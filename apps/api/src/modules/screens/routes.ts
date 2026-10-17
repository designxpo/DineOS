// Which menu and settings every staff screen and print computer is running. Screens check in
// every half minute with the version they have applied; the owner sees who is behind and can
// reload one from the office.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrintComputerStateDTO, ScreenDTO, ScreenKind, ScreensDTO } from '@mezmitra/shared/dto';
import type { AppContext } from '../../context';
import { assertCan, assertOutletAccess, requireStaff } from '../../lib/auth';
import { notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';

/** A screen counts as on while it checked in within this long (it checks in every 30 s). */
const ONLINE_MS = 90_000;
const KINDS = ['kitchen', 'till', 'floor', 'orders', 'bills', 'other'] as const;

/** "Chrome on Android", from the browser's user agent: enough to tell two screens apart. */
function deviceName(ua: string | null): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' on ') || null;
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    /** A screen checks in: the version it is running; the answer says the latest, and whether to reload. */
    app.post('/screens/heartbeat', async (req) => {
      const auth = requireStaff(req);
      const body = parse(
        z.object({ outlet_id: z.uuid(), screen_id: z.uuid(), kind: z.enum(KINDS), applied_version: z.number().int().min(0).nullable() }),
        req.body,
      );
      assertOutletAccess(auth, body.outlet_id);
      const ua = (req.headers['user-agent'] ?? '').slice(0, 300) || null;
      return ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select('config_version').where('id', '=', body.outlet_id).executeTakeFirst();
        if (!outlet) throw notFound('Outlet');
        const row = await tx.db
          .insertInto('screens')
          .values({ id: body.screen_id, tenant_id: tx.tenantId, outlet_id: body.outlet_id, kind: body.kind, user_id: auth.userId, applied_version: body.applied_version, user_agent: ua })
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'id']).doUpdateSet({ outlet_id: body.outlet_id, kind: body.kind, user_id: auth.userId, applied_version: body.applied_version, user_agent: ua, last_seen_at: new Date() }),
          )
          .returning(['reload_requested_at', 'label'])
          .executeTakeFirstOrThrow();
        if (row.reload_requested_at) await tx.db.updateTable('screens').set({ reload_requested_at: null }).where('id', '=', body.screen_id).execute();
        return { config_version: Number(outlet.config_version), reload: !!row.reload_requested_at, label: row.label };
      });
    });

    app.get('/screens', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid() }), req.query);
      assertCan(auth, q.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, async (tx): Promise<ScreensDTO> => {
        const outlet = await tx.db.selectFrom('outlets').select('config_version').where('id', '=', q.outlet_id).executeTakeFirstOrThrow();
        const version = Number(outlet.config_version);
        const now = Date.now();
        const rows = await tx.db
          .selectFrom('screens')
          .leftJoin('users', 'users.id', 'screens.user_id')
          .select(['screens.id', 'screens.label', 'screens.kind', 'screens.applied_version', 'screens.user_agent', 'screens.last_seen_at', 'users.name as user_name'])
          .where('screens.outlet_id', '=', q.outlet_id)
          .where('screens.last_seen_at', '>', new Date(now - 86_400_000))
          .orderBy('screens.last_seen_at', 'desc')
          .execute();
        const agents = await tx.db
          .selectFrom('devices')
          .select(['id', 'name', 'applied_version', 'last_seen_at'])
          .where('outlet_id', '=', q.outlet_id)
          .where('kind', '=', 'print_agent')
          .where('status', '=', 'active')
          .orderBy('name')
          .execute();
        return {
          config_version: version,
          screens: rows.map(
            (r): ScreenDTO => ({
              id: r.id,
              label: r.label,
              kind: r.kind as ScreenKind,
              user_name: r.user_name,
              device: deviceName(r.user_agent),
              applied_version: r.applied_version === null ? null : Number(r.applied_version),
              up_to_date: r.applied_version !== null && Number(r.applied_version) >= version,
              online: now - r.last_seen_at.getTime() < ONLINE_MS,
              last_seen_at: r.last_seen_at.toISOString(),
            }),
          ),
          print_computers: agents.map(
            (d): PrintComputerStateDTO => ({
              id: d.id,
              name: d.name,
              applied_version: d.applied_version === null ? null : Number(d.applied_version),
              up_to_date: d.applied_version !== null && Number(d.applied_version) >= version,
              online: !!d.last_seen_at && now - d.last_seen_at.getTime() < ONLINE_MS,
              last_seen_at: d.last_seen_at?.toISOString() ?? null,
            }),
          ),
        };
      });
    });

    /** Names a screen so the owner can tell them apart ("Bar tablet"). */
    app.patch('/screens/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ outlet_id: z.uuid(), label: z.string().trim().max(40) }), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      return ctx.tx(auth.tenantId, async (tx) => {
        const r = await tx.db.updateTable('screens').set({ label: body.label }).where('id', '=', id).where('outlet_id', '=', body.outlet_id).returning('id').executeTakeFirst();
        if (!r) throw notFound('Screen');
        return { id, label: body.label };
      });
    });

    /** Reloads a screen that is behind: straight away if it is listening, else when it next checks in. */
    app.post('/screens/:id/reload', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ outlet_id: z.uuid() }), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      await ctx.tx(auth.tenantId, async (tx) => {
        const r = await tx.db.updateTable('screens').set({ reload_requested_at: new Date() }).where('id', '=', id).where('outlet_id', '=', body.outlet_id).returning('id').executeTakeFirst();
        if (!r) throw notFound('Screen');
        await tx.emit({ outletId: body.outlet_id, type: 'screen.reload', channels: ['outlet'], payload: { screen_id: id } });
      });
      return reply.status(204).send();
    });

    /** Tells a print computer to fetch its settings again. */
    app.post('/screens/print-computers/:id/reload', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ outlet_id: z.uuid() }), req.body);
      assertCan(auth, body.outlet_id, 'outlet.settings');
      await ctx.tx(auth.tenantId, async (tx) => {
        const d = await tx.db.selectFrom('devices').select('id').where('id', '=', id).where('outlet_id', '=', body.outlet_id).executeTakeFirst();
        if (!d) throw notFound('Print computer');
        await tx.emit({ outletId: body.outlet_id, type: 'device.command', channels: ['print'], payload: { device_id: id, command: 'reload' } });
      });
      return reply.status(204).send();
    });
  };
}
