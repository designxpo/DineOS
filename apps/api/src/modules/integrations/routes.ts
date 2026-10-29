import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { CHAT_CHANNELS, onlineBooking, slotLabel } from '@mezmitra/shared/booking';
import type { OpeningHours } from '@mezmitra/shared/booking';
import type { TalkoDeliveryDTO, TalkoLinkDTO } from '@mezmitra/shared/dto';
import { normalizePhone } from '@mezmitra/shared/phone';
import type { AppContext, Tx } from '../../context';
import { audit } from '../../lib/audit';
import { assertTenantOwner, evictCachedAuthHash, requireIntegration, requireStaff } from '../../lib/auth';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { pingTalko, talkoBase } from '../../lib/talko';
import { parse } from '../../lib/validate';
import { loadMenu } from '../menu/service';
import { bookingView, cancelChatBooking, createChatBooking, openSlots, upcomingBookings } from './booking';
import { dispatchTalkoOutbox, peerKeyContext, peerWebhookContext } from './outbox';

/** What a Talko link may do. Every link gets all of them; the list is checked per route. */
export const TALKO_SCOPES = ['link', 'outlets.read', 'menu.read', 'reservations.read', 'reservations.write', 'orders.read'] as const;

const outletParams = z.object({ id: z.uuid() });
const phoneField = z.string().trim().min(10).max(20);
/** Booking writes from a chat, per link: generous for real guests, tight for a runaway bot. */
const bookingLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  const configured = () => !!ctx.config.INTEGRATION_ENC_KEY && !!talkoBase(ctx.config);

  async function planAllows(tx: Tx): Promise<boolean> {
    const row = await tx.db
      .selectFrom('tenants')
      .leftJoin('plans', 'plans.code', 'tenants.plan_code')
      .select(sql<boolean>`coalesce((plans.features ->> 'talko_link')::boolean, false)`.as('allows'))
      .where('tenants.id', '=', tx.tenantId)
      .executeTakeFirst();
    return !!row?.allows;
  }

  async function linkView(tx: Tx): Promise<TalkoLinkDTO> {
    const link = await tx.db
      .selectFrom('integration_links')
      .selectAll()
      .where('provider', '=', 'talko')
      .where('status', '<>', 'revoked')
      .executeTakeFirst();
    const counts = { pending: 0, dead: 0, sent_today: 0 };
    let recent: TalkoDeliveryDTO[] = [];
    if (link) {
      const since = new Date(Date.now() - 24 * 3600_000);
      const c = await tx.db
        .selectFrom('integration_outbox')
        .select([
          sql<string>`count(*) filter (where status = 'pending')`.as('pending'),
          sql<string>`count(*) filter (where status = 'dead' and created_at > now() - interval '7 days')`.as('dead'),
          sql<string>`count(*) filter (where status = 'sent' and sent_at > ${since})`.as('sent_today'),
        ])
        .where('link_id', '=', link.id)
        .executeTakeFirstOrThrow();
      counts.pending = Number(c.pending);
      counts.dead = Number(c.dead);
      counts.sent_today = Number(c.sent_today);
      const rows = await tx.db
        .selectFrom('integration_outbox')
        .select(['id', 'event', 'status', 'attempts', 'phone', 'last_error', 'created_at', 'sent_at'])
        .where('link_id', '=', link.id)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      recent = rows.map((r) => ({
        id: r.id,
        event: r.event,
        status: r.status as TalkoDeliveryDTO['status'],
        attempts: r.attempts,
        phone_tail: r.phone.slice(-4),
        last_error: r.last_error,
        created_at: r.created_at.toISOString(),
        sent_at: r.sent_at?.toISOString() ?? null,
      }));
    }
    return {
      status: link ? (link.status as 'pending' | 'active') : 'none',
      plan_allows: await planAllows(tx),
      configured: configured(),
      token_prefix: link?.token_prefix ?? null,
      peer_account: link?.peer_account ?? null,
      created_at: link?.created_at.toISOString() ?? null,
      linked_at: link?.linked_at?.toISOString() ?? null,
      last_used_at: link?.last_used_at?.toISOString() ?? null,
      last_error: link?.last_error ?? null,
      counts,
      recent,
    };
  }

  /** Revokes the tenant's live link, if any. Returns the key hashes to drop from the auth cache. */
  async function revokeLive(tx: Tx): Promise<string[]> {
    const old = await tx.db
      .updateTable('integration_links')
      .set({ status: 'revoked', revoked_at: new Date(), peer_api_key_enc: null, peer_webhook_secret_enc: null })
      .where('provider', '=', 'talko')
      .where('status', '<>', 'revoked')
      .returning(['id', 'token_hash'])
      .execute();
    if (old.length) {
      await tx.db
        .updateTable('integration_outbox')
        .set({ status: 'skipped', last_error: 'Talko AI was disconnected' })
        .where('link_id', 'in', old.map((o) => o.id))
        .where('status', '=', 'pending')
        .execute();
    }
    return old.map((o) => o.token_hash);
  }

  /** Stamps when the link was last used; at most once a minute per link. */
  function touch(linkId: string, tenantId: string): void {
    void ctx
      .tx(tenantId, (tx) =>
        tx.db
          .updateTable('integration_links')
          .set({ last_used_at: new Date() })
          .where('id', '=', linkId)
          .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', new Date(Date.now() - 60_000))]))
          .execute(),
      )
      .catch((err) => ctx.log.warn({ err }, 'could not stamp link use'));
  }

  return async (app) => {
    // The opt-out webhook is signed over its exact bytes, so this module keeps the raw JSON body.
    // The default parser still does the parsing (with its prototype-poisoning protection).
    const parseJson = app.getDefaultJsonParser('error', 'error');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest).rawBody = body as string;
      parseJson(req, body as string, done);
    });

    // ------------------------------------------------------------ owner: connect and watch

    app.get('/integrations/talko', async (req): Promise<TalkoLinkDTO> => {
      const auth = requireStaff(req);
      assertTenantOwner(auth);
      return ctx.tx(auth.tenantId, (tx) => linkView(tx));
    });

    /** Makes a new link key, shown once. Any earlier link stops working. */
    app.post('/integrations/talko', async (req, reply) => {
      const auth = requireStaff(req);
      assertTenantOwner(auth);
      // A replayed response would keep the key in the idempotency table; this route has no need of one.
      if (req.headers['idempotency-key'] !== undefined) throw badRequest('idempotency_not_supported', 'Retry without an Idempotency-Key');
      // A setting on our side, not a failure: the owner sees it on the Talko AI card.
      if (!configured()) throw conflict('not_configured', 'Talko AI is not set up on this server yet');
      const key = randomToken('mzk');
      const { dropped, view } = await ctx.tx(auth.tenantId, async (tx) => {
        if (!(await planAllows(tx))) throw forbidden('Your plan does not include Talko AI. Upgrade to connect it.', 'plan_upgrade');
        const dropped = await revokeLive(tx);
        const row = await tx.db
          .insertInto('integration_links')
          .values({
            tenant_id: tx.tenantId,
            provider: 'talko',
            token_hash: sha256(key),
            token_prefix: key.slice(0, 12),
            scopes: [...TALKO_SCOPES],
            created_by: auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await audit(tx, auth, { action: 'integration.connect', entity: 'integration_link', entityId: row.id, after: { provider: 'talko' } });
        return { dropped, view: await linkView(tx) };
      });
      for (const hash of dropped) evictCachedAuthHash(hash);
      return reply.status(201).send({ key, link: view });
    });

    app.delete('/integrations/talko', async (req, reply) => {
      const auth = requireStaff(req);
      assertTenantOwner(auth);
      const dropped = await ctx.tx(auth.tenantId, async (tx) => {
        const hashes = await revokeLive(tx);
        if (hashes.length) await audit(tx, auth, { action: 'integration.disconnect', entity: 'integration_link', after: { provider: 'talko' } });
        return hashes;
      });
      for (const hash of dropped) evictCachedAuthHash(hash);
      return reply.status(204).send();
    });

    /** Sends failed messages again (those still worth sending). */
    app.post('/integrations/talko/retry', async (req) => {
      const auth = requireStaff(req);
      assertTenantOwner(auth);
      const view = await ctx.tx(auth.tenantId, async (tx) => {
        await tx.db
          .updateTable('integration_outbox')
          .set({ status: 'pending', attempts: 0, next_attempt_at: new Date(), last_error: null })
          .where('status', '=', 'dead')
          .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
          .where('created_at', '>', new Date(Date.now() - 24 * 3600_000))
          .execute();
        return linkView(tx);
      });
      await dispatchTalkoOutbox(ctx, { tenantId: auth.tenantId }).catch((err) => ctx.log.warn({ err }, 'talko retry failed'));
      return ctx.tx(auth.tenantId, (tx) => linkView(tx)).catch(() => view);
    });

    /** Checks the stored Talko key without messaging anyone. */
    app.post('/integrations/talko/test', async (req) => {
      const auth = requireStaff(req);
      assertTenantOwner(auth);
      const link = await ctx.tx(auth.tenantId, (tx) =>
        tx.db.selectFrom('integration_links').select(['id', 'status', 'peer_api_key_enc']).where('provider', '=', 'talko').where('status', '=', 'active').executeTakeFirst(),
      );
      if (!link?.peer_api_key_enc || !ctx.config.INTEGRATION_ENC_KEY) throw conflict('not_linked', 'Connect Talko AI first');
      let apiKey: string;
      try {
        apiKey = decryptSecret(ctx.config.INTEGRATION_ENC_KEY, link.peer_api_key_enc, peerKeyContext(link.id));
      } catch {
        throw conflict('relink', 'The stored Talko key cannot be read (the server key changed). Disconnect and connect again.');
      }
      const result = await pingTalko(ctx.config, apiKey);
      await ctx.tx(auth.tenantId, (tx) =>
        tx.db.updateTable('integration_links').set({ last_error: result.ok ? null : result.error.slice(0, 500) }).where('id', '=', link.id).execute(),
      );
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    });

    // ------------------------------------------------------------ Talko: link

    app.get('/talko/whoami', async (req) => {
      const auth = requireIntegration(req, 'link');
      const tenant = await ctx.tx(auth.tenantId, (tx) => tx.db.selectFrom('tenants').select(['name', 'slug']).where('id', '=', auth.tenantId).executeTakeFirstOrThrow());
      return { tenant: { id: auth.tenantId, name: tenant.name, slug: tenant.slug }, link: { id: auth.linkId, status: auth.status, scopes: auth.scopes } };
    });

    /**
     * Talko completes the link: it hands over its own API key (for sending us nothing but events)
     * and the secret it signs opt-out webhooks with. Allowed once per key, so a key that leaks
     * later cannot re-point events to someone else's Talko account.
     */
    app.post('/talko/link', async (req) => {
      const auth = requireIntegration(req, 'link');
      const body = parse(
        z.object({
          api_key: z.string().regex(/^ak_live_[0-9a-f]{48}$/, 'Expected a Talko API key'),
          webhook_secret: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
          account: z.string().trim().min(1).max(120),
        }),
        req.body,
      );
      const encKey = ctx.config.INTEGRATION_ENC_KEY;
      if (!encKey) throw conflict('not_configured', 'Mezmitra is not set up for Talko AI yet');
      const hash = await ctx.tx(auth.tenantId, async (tx) => {
        const link = await tx.db.selectFrom('integration_links').select(['id', 'status', 'token_hash']).where('id', '=', auth.linkId).forUpdate().executeTakeFirstOrThrow();
        if (link.status !== 'pending') throw conflict('already_linked', 'This key was already used. Make a new one in Mezmitra Settings.');
        await tx.db
          .updateTable('integration_links')
          .set({
            status: 'active',
            linked_at: new Date(),
            last_used_at: new Date(),
            peer_account: body.account,
            peer_api_key_enc: encryptSecret(encKey, body.api_key, peerKeyContext(link.id)),
            peer_webhook_secret_enc: encryptSecret(encKey, body.webhook_secret, peerWebhookContext(link.id)),
            last_error: null,
          })
          .where('id', '=', link.id)
          .execute();
        await audit(tx, null, { action: 'integration.linked', entity: 'integration_link', entityId: link.id, after: { provider: 'talko', account: body.account } });
        return link.token_hash;
      });
      evictCachedAuthHash(hash);
      return { ok: true, webhook_path: `/v1/talko/webhooks/${auth.linkId}` };
    });

    /** Talko disconnects: this key stops working and nothing more is sent to Talko. */
    app.post('/talko/unlink', async (req, reply) => {
      const auth = requireIntegration(req, 'link');
      const hash = await ctx.tx(auth.tenantId, async (tx) => {
        const link = await tx.db
          .updateTable('integration_links')
          .set({ status: 'revoked', revoked_at: new Date(), peer_api_key_enc: null, peer_webhook_secret_enc: null })
          .where('id', '=', auth.linkId)
          .returning('token_hash')
          .executeTakeFirstOrThrow();
        await tx.db
          .updateTable('integration_outbox')
          .set({ status: 'skipped', last_error: 'Talko AI was disconnected' })
          .where('link_id', '=', auth.linkId)
          .where('status', '=', 'pending')
          .execute();
        await audit(tx, null, { action: 'integration.unlinked', entity: 'integration_link', entityId: auth.linkId, after: { provider: 'talko', by: 'talko' } });
        return link.token_hash;
      });
      evictCachedAuthHash(hash);
      return reply.status(204).send();
    });

    // ------------------------------------------------------------ Talko: read

    app.get('/talko/outlets', async (req) => {
      const auth = requireIntegration(req, 'outlets.read');
      touch(auth.linkId, auth.tenantId);
      const rows = await ctx.tx(auth.tenantId, (tx) =>
        tx.db
          .selectFrom('outlets')
          .select(['id', 'name', 'address', 'city', 'phone', 'timezone', 'opening_hours', 'online_booking'])
          .where('status', '=', 'active')
          .orderBy('name')
          .execute(),
      );
      return {
        outlets: rows.map((o) => {
          const booking = onlineBooking(o.online_booking);
          return {
            id: o.id,
            name: o.name,
            address: o.address,
            city: o.city,
            phone: o.phone,
            timezone: o.timezone,
            opening_hours: (o.opening_hours ?? null) as OpeningHours | null,
            online_booking: { enabled: booking.enabled && !!o.opening_hours, max_party: booking.max_party, days_ahead: booking.days_ahead },
          };
        }),
      };
    });

    app.get('/talko/outlets/:id/menu', async (req) => {
      const auth = requireIntegration(req, 'menu.read');
      const { id } = parse(outletParams, req.params);
      touch(auth.linkId, auth.tenantId);
      return ctx.tx(auth.tenantId, async (tx) => {
        const o = await tx.db.selectFrom('outlets').select('status').where('id', '=', id).executeTakeFirst();
        if (!o || o.status !== 'active') throw notFound('Outlet');
        const menu = await loadMenu(tx, id, { forGuest: true });
        // What a guest may be told, nothing more: no tax codes, stations or staff shortcuts.
        return {
          menu_version: menu.menu_version,
          categories: menu.categories.map((c) => ({
            id: c.id,
            name: c.name,
            items: menu.items
              .filter((i) => i.category_id === c.id)
              .map((i) => ({
                id: i.id,
                name: i.name,
                description: i.description,
                price_paise: i.price_paise,
                is_veg: i.is_veg,
                in_stock: i.in_stock,
                available_now: c.available_now && i.in_stock,
              })),
          })),
        };
      });
    });

    app.get('/talko/outlets/:id/availability', async (req) => {
      const auth = requireIntegration(req, 'reservations.read');
      const { id } = parse(outletParams, req.params);
      const q = parse(z.object({ date: z.iso.date(), party_size: z.coerce.number().int().min(1).max(200) }), req.query);
      touch(auth.linkId, auth.tenantId);
      const result = await ctx.tx(auth.tenantId, (tx) => openSlots(tx, id, q.date, q.party_size));
      return {
        outlet_id: result.outlet.id,
        outlet_name: result.outlet.name,
        date: q.date,
        party_size: q.party_size,
        max_party: result.max_party,
        reason: result.reason,
        slots: result.slots.map((s) => ({ start: s.start.toISOString(), label: slotLabel(s.start, result.outlet.timezone) })),
      };
    });

    /** A guest's upcoming bookings. POST so the phone number stays out of URLs and access logs. */
    app.post('/talko/reservations/lookup', async (req) => {
      const auth = requireIntegration(req, 'reservations.read');
      const body = parse(z.object({ phone: phoneField }), req.body);
      touch(auth.linkId, auth.tenantId);
      return { bookings: await ctx.tx(auth.tenantId, (tx) => upcomingBookings(tx, body.phone)) };
    });

    app.get('/talko/orders/:code', async (req) => {
      const auth = requireIntegration(req, 'orders.read');
      const { code } = parse(z.object({ code: z.string().min(16).max(40).regex(/^[\w-]+$/) }), req.params);
      touch(auth.linkId, auth.tenantId);
      const { rows } = await sql<{ tenant_id: string; order_id: string }>`select * from mezmitra_track_order(${code})`.execute(ctx.db);
      const found = rows[0];
      // Another tenant's code is "not found", exactly like an unknown one.
      if (!found || found.tenant_id !== auth.tenantId) throw notFound('Order');
      return ctx.tx(auth.tenantId, async (tx) => {
        const o = await tx.db
          .selectFrom('orders')
          .innerJoin('outlets', 'outlets.id', 'orders.outlet_id')
          .select(['orders.order_no', 'orders.type', 'orders.status', 'orders.placed_at', 'orders.ready_at', 'outlets.name as outlet_name'])
          .where('orders.id', '=', found.order_id)
          .executeTakeFirst();
        if (!o) throw notFound('Order');
        return {
          order_no: o.order_no,
          type: o.type,
          status: o.status,
          outlet_name: o.outlet_name,
          placed_at: o.placed_at.toISOString(),
          ready_at: o.ready_at?.toISOString() ?? null,
        };
      });
    });

    // ------------------------------------------------------------ Talko: book

    app.post('/talko/outlets/:id/reservations', { config: bookingLimit }, async (req, reply) => {
      const auth = requireIntegration(req, 'reservations.write');
      const { id } = parse(outletParams, req.params);
      const body = parse(
        z.object({
          slot_start: z.iso.datetime({ offset: true }),
          party_size: z.number().int().min(1).max(200),
          guest_name: z.string().trim().min(1).max(80),
          phone: phoneField,
          channel: z.enum(CHAT_CHANNELS),
          external_ref: z.string().trim().max(120).nullable().optional(),
          notes: z.string().trim().max(300).nullable().optional(),
        }),
        req.body,
      );
      touch(auth.linkId, auth.tenantId);
      const booking = await ctx.tx(auth.tenantId, async (tx) => {
        const r = await createChatBooking(tx, {
          outletId: id,
          slotStart: new Date(body.slot_start),
          partySize: body.party_size,
          guestName: body.guest_name,
          phone: body.phone,
          channel: body.channel,
          externalRef: body.external_ref ?? null,
          notes: body.notes ?? null,
        });
        const o = await tx.db.selectFrom('outlets').select(['name', 'timezone']).where('id', '=', id).executeTakeFirstOrThrow();
        return bookingView({ id: r.id, public_ref: r.public_ref, slot_start: new Date(r.slot_start), party_size: r.party_size, status: r.status, outlet_id: id, outlet_name: o.name, timezone: o.timezone });
      });
      return reply.status(201).send(booking);
    });

    app.post('/talko/reservations/:ref/cancel', { config: bookingLimit }, async (req) => {
      const auth = requireIntegration(req, 'reservations.write');
      const { ref } = parse(z.object({ ref: z.string().regex(/^BK[A-Z0-9]{6}$/) }), req.params);
      const body = parse(z.object({ phone: phoneField }), req.body);
      touch(auth.linkId, auth.tenantId);
      return ctx.tx(auth.tenantId, (tx) => cancelChatBooking(tx, ref, body.phone));
    });

    // ------------------------------------------------------------ Talko: opt-out webhook

    /**
     * Talko tells us a guest replied STOP. Signed with the secret Talko gave us when linking
     * (HMAC-SHA256 of the raw body, X-Alabs-Signature: sha256=<hex>). Turning marketing off is
     * harmless to repeat, so a replayed delivery changes nothing.
     */
    app.post('/talko/webhooks/:linkId', async (req, reply) => {
      const { linkId } = parse(z.object({ linkId: z.uuid() }), req.params);
      const signature = req.headers['x-alabs-signature'];
      if (typeof signature !== 'string' || !req.rawBody) throw unauthorized();
      // Auth bootstrap: no tenant is known until the link is found.
      const link = await ctx.adminDb
        .selectFrom('integration_links')
        .select(['id', 'tenant_id', 'status', 'peer_webhook_secret_enc'])
        .where('id', '=', linkId)
        .executeTakeFirst();
      const encKey = ctx.config.INTEGRATION_ENC_KEY;
      if (!link || link.status !== 'active' || !link.peer_webhook_secret_enc || !encKey) throw unauthorized();
      let secret: string;
      try {
        secret = decryptSecret(encKey, link.peer_webhook_secret_enc, peerWebhookContext(link.id));
      } catch {
        throw unauthorized();
      }
      const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}`);
      const given = Buffer.from(signature);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized();

      const envelope = parse(z.object({ event: z.string().max(60), data: z.record(z.string(), z.unknown()).default({}) }), req.body);
      if (envelope.event === 'contact.optout' && typeof envelope.data.phone === 'string' && envelope.data.phone.trim()) {
        // Talko sends digits with the country code (919876543210); Indian numbers are kept as +91...
        const digits = envelope.data.phone.replace(/\D/g, '');
        const candidates = [...new Set([normalizePhone(digits), `+${digits}`])];
        await ctx.tx(link.tenant_id, (tx) =>
          tx.db.updateTable('customers').set({ marketing_opt_in: false }).where('phone', 'in', candidates).where('marketing_opt_in', '=', true).execute(),
        );
      }
      return reply.status(204).send();
    });
  };
}
