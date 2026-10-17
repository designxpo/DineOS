import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext, Tx } from '../../context';
import { json } from '../../db';
import { audit } from '../../lib/audit';
import { assertCan, requireAction, requireStaff } from '../../lib/auth';
import { randomToken, sha256 } from '../../lib/crypto';
import { notFound } from '../../lib/errors';
import { idParams, outletQuery, parse } from '../../lib/validate';
import { bumpConfig } from '../../lib/config-version';

/** A network printer (host:port), a printer installed on the agent's computer, or a Linux USB device. */
const printerAddress = z
  .string()
  .trim()
  .max(140)
  .refine(
    (a) => /^[\w.-]+(:\d{2,5})?$/.test(a) || (/^printer:[^'"]{1,120}$/.test(a) && !/\p{Cc}/u.test(a)) || /^\/dev\/[\w./-]{1,60}$/.test(a),
    'Pick a printer the computer found, or type an address like 192.168.1.50:9100',
  );
const printerConfig = z.object({
  /** target ('bill' or a kitchen station) -> printer */
  printers: z
    .record(
      z.string().min(1).max(30),
      z.object({ address: printerAddress, width: z.union([z.literal(32), z.literal(42), z.literal(48)]).default(48), drawer: z.boolean().optional() }),
    )
    .default({}),
});

/** A device that checked in this recently counts as online (agents check in every minute). */
export const ONLINE_WINDOW_MS = 2 * 60_000;

function deviceDto(d: { id: string; outlet_id: string; kind: string; name: string; status: string; config: unknown; info: unknown; last_seen_at: Date | null; created_at: Date }) {
  return {
    id: d.id,
    outlet_id: d.outlet_id,
    kind: d.kind,
    name: d.name,
    status: d.status,
    config: d.config,
    info: d.info,
    last_seen_at: d.last_seen_at?.toISOString() ?? null,
    online: !!d.last_seen_at && Date.now() - d.last_seen_at.getTime() < ONLINE_WINDOW_MS,
    created_at: d.created_at.toISOString(),
  };
}

const COLUMNS = ['id', 'outlet_id', 'kind', 'name', 'status', 'config', 'info', 'last_seen_at', 'created_at'] as const;

/** Commands reach the outlet's agents on their socket; each acts only on its own id. */
async function tellAgent(tx: Tx, outletId: string, deviceId: string, command: 'reload' | 'scan'): Promise<void> {
  await tx.emit({ outletId, type: 'device.command', channels: ['print'], payload: { device_id: deviceId, command } });
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/devices', async (req) => {
      const auth = requireStaff(req);
      const { outlet_id } = parse(outletQuery, req.query);
      assertCan(auth, outlet_id, 'device.manage');
      return ctx.tx(auth.tenantId, async (tx) => {
        const rows = await tx.db.selectFrom('devices').select(COLUMNS).where('outlet_id', '=', outlet_id).orderBy('created_at').execute();
        return rows.map(deviceDto);
      });
    });

    /** Registers a print agent or a camera (vision) box. The token is shown once; the device stores it. */
    app.post('/devices', async (req, reply) => {
      const body = parse(
        z.object({ outlet_id: z.uuid(), kind: z.enum(['print_agent', 'vision']).default('print_agent'), name: z.string().trim().min(1).max(60), config: printerConfig.optional() }),
        req.body,
      );
      const auth = requireAction(req, body.outlet_id, 'device.manage');
      const token = randomToken('dv');
      const device = await ctx.tx(auth.tenantId, async (tx) => {
        const row = await tx.db
          .insertInto('devices')
          .values({
            tenant_id: tx.tenantId,
            outlet_id: body.outlet_id,
            kind: body.kind,
            name: body.name,
            token_hash: sha256(token),
            config: json(body.config ?? { printers: {} }),
          })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(tx, auth, { outletId: body.outlet_id, action: 'device.create', entity: 'device', entityId: row.id, after: { name: body.name } });
        return row;
      });
      return reply.status(201).send({ device: deviceDto(device), token });
    });

    app.patch('/devices/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(
        z.object({ name: z.string().trim().min(1).max(60).optional(), config: printerConfig.optional(), status: z.enum(['active', 'revoked']).optional() }),
        req.body,
      );
      return ctx.tx(auth.tenantId, async (tx) => {
        const d = await tx.db.selectFrom('devices').select(['outlet_id', 'status']).where('id', '=', id).executeTakeFirst();
        if (!d) throw notFound('Device');
        assertCan(auth, d.outlet_id, 'device.manage');
        const row = await tx.db
          .updateTable('devices')
          .set({
            ...(body.name ? { name: body.name } : {}),
            ...(body.config ? { config: json(body.config) } : {}),
            ...(body.status ? { status: body.status } : {}),
          })
          .where('id', '=', id)
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        // A running agent picks up new printers straight away, and confirms it when it fetches them.
        if (body.config) {
          await bumpConfig(tx, d.outlet_id);
          await tellAgent(tx, d.outlet_id, id, 'reload');
        }
        if (body.status && body.status !== d.status) {
          // A revoked device stops being the outlet hub.
          if (body.status === 'revoked') await tx.db.updateTable('outlets').set({ hub_device_id: null }).where('hub_device_id', '=', id).execute();
          await audit(tx, auth, { outletId: d.outlet_id, action: `device.${body.status === 'revoked' ? 'revoke' : 'activate'}`, entity: 'device', entityId: id });
        }
        return deviceDto(row);
      });
    });

    /** Asks a print agent to look for printers again (after plugging one in). */
    app.post('/devices/:id/scan', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await ctx.tx(auth.tenantId, async (tx) => {
        const d = await tx.db.selectFrom('devices').select(['outlet_id', 'kind']).where('id', '=', id).where('status', '=', 'active').executeTakeFirst();
        if (!d || d.kind !== 'print_agent') throw notFound('Print computer');
        assertCan(auth, d.outlet_id, 'device.manage');
        await tellAgent(tx, d.outlet_id, id, 'scan');
      });
      return reply.status(202).send({ ok: true });
    });

    app.post('/devices/:id/rotate-token', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const token = randomToken('dv');
      return ctx.tx(auth.tenantId, async (tx) => {
        const d = await tx.db.selectFrom('devices').select('outlet_id').where('id', '=', id).executeTakeFirst();
        if (!d) throw notFound('Device');
        assertCan(auth, d.outlet_id, 'device.manage');
        await tx.db.updateTable('devices').set({ token_hash: sha256(token) }).where('id', '=', id).execute();
        await audit(tx, auth, { outletId: d.outlet_id, action: 'device.rotate_token', entity: 'device', entityId: id });
        return { token };
      });
    });
  };
}
