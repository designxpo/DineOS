import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext, Tx } from '../../context';
import { json } from '../../db';
import { audit } from '../../lib/audit';
import { assertCan, requireDevice, requireStaff } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { idParams, parse } from '../../lib/validate';
import { refreshTableStates } from '../tables/sessions';
import { applyReading, loadCameras, visionConfig } from './service';

const reading = z.object({
  table_id: z.uuid(),
  state: z.enum(['vacant', 'occupied', 'needs_cleaning']),
  confidence: z.number().min(0).max(1),
  observed_at: z.iso.datetime({ offset: true }),
});
const ref = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,40}$/, 'Letters, digits and _ only, e.g. courtyard_1');
const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

const MAX_SNAPSHOT = 3 * 1024 * 1024;

export default function routes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    // Raw JPEG stills from the edge worker (zone drawing only, on request).
    app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: MAX_SNAPSHOT }, (_req, body, done) => done(null, body));

    // ------------------------------------------------------------ edge worker (vision device token)

    app.get('/vision/config', async (req) => {
      const auth = requireDevice(req, 'vision');
      return ctx.tx(auth.tenantId, async (tx) => {
        await tx.db.updateTable('devices').set({ last_seen_at: new Date() }).where('id', '=', auth.deviceId).execute();
        return visionConfig(tx, auth);
      });
    });

    /** One reading ({table_id, state, confidence, observed_at}) or a batch ({readings: [...]}). */
    app.post('/vision/table-state', async (req) => {
      const auth = requireDevice(req, 'vision');
      const raw = req.body as { readings?: unknown } | undefined;
      const readings = parse(z.array(reading).min(1).max(200), raw && 'readings' in raw ? raw.readings : [raw]);
      const now = Date.now();
      for (const r of readings) {
        if (Date.parse(r.observed_at) > now + 60_000) throw badRequest('clock_ahead', 'observed_at is in the future; check the edge box clock');
      }
      const results = [];
      for (const r of [...readings].sort((a, b) => a.observed_at.localeCompare(b.observed_at))) {
        results.push({ table_id: r.table_id, result: await ctx.tx(auth.tenantId, (tx) => applyReading(tx, auth, r)) });
      }
      return { results };
    });

    app.post('/vision/heartbeat', async (req, reply) => {
      const auth = requireDevice(req, 'vision');
      const body = parse(
        z.object({
          cameras: z
            .array(z.object({ camera_id: z.uuid(), ok: z.boolean(), fps: z.number().min(0).max(60).nullable().optional(), error: z.string().max(300).nullable().optional() }))
            .max(64)
            .default([]),
        }),
        req.body ?? {},
      );
      await ctx.tx(auth.tenantId, async (tx) => {
        await tx.db.updateTable('devices').set({ last_seen_at: new Date() }).where('id', '=', auth.deviceId).execute();
        for (const c of body.cameras) {
          await tx.db
            .updateTable('cameras')
            .set({ last_seen_at: new Date(), fps: c.fps ?? null, last_error: c.ok ? null : (c.error ?? 'Camera not readable') })
            .where('id', '=', c.camera_id)
            .where('device_id', '=', auth.deviceId)
            .execute();
        }
      });
      return reply.status(204).send();
    });

    app.put('/vision/cameras/:id/snapshot', async (req, reply) => {
      const auth = requireDevice(req, 'vision');
      const { id } = parse(idParams, req.params);
      const q = parse(z.object({ width: z.coerce.number().int().min(16).max(8000), height: z.coerce.number().int().min(16).max(8000) }), req.query);
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) throw badRequest('not_jpeg', 'Send a JPEG image');
      await ctx.tx(auth.tenantId, async (tx) => {
        const res = await tx.db
          .updateTable('cameras')
          .set({ snapshot: body, snapshot_width: q.width, snapshot_height: q.height, snapshot_at: new Date(), snapshot_requested_at: null })
          .where('id', '=', id)
          .where('device_id', '=', auth.deviceId)
          .executeTakeFirst();
        if (!Number(res.numUpdatedRows)) throw notFound('Camera');
      });
      return reply.status(204).send();
    });

    // ------------------------------------------------------------ setup (owners and managers)

    app.get('/cameras', async (req) => {
      const auth = requireStaff(req);
      const q = parse(z.object({ outlet_id: z.uuid() }), req.query);
      assertCan(auth, q.outlet_id, 'table.manage');
      return ctx.tx(auth.tenantId, (tx) => loadCameras(tx, q.outlet_id));
    });

    app.post('/cameras', async (req, reply) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ outlet_id: z.uuid(), device_id: z.uuid(), name: z.string().trim().min(1).max(60), rtsp_secret_ref: ref }), req.body);
      assertCan(auth, body.outlet_id, 'table.manage');
      const camera = await ctx.tx(auth.tenantId, async (tx) => {
        const device = await tx.db
          .selectFrom('devices')
          .select('id')
          .where('id', '=', body.device_id)
          .where('outlet_id', '=', body.outlet_id)
          .where('kind', '=', 'vision')
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!device) throw badRequest('invalid_device', 'Pick an active camera box at this outlet');
        const row = await tx.db
          .insertInto('cameras')
          .values({ tenant_id: tx.tenantId, outlet_id: body.outlet_id, device_id: body.device_id, name: body.name, rtsp_secret_ref: body.rtsp_secret_ref, snapshot_requested_at: new Date() })
          .returning('id')
          .executeTakeFirstOrThrow();
        await audit(tx, auth, { outletId: body.outlet_id, action: 'camera.create', entity: 'camera', entityId: row.id, after: { name: body.name } });
        return (await loadCameras(tx, body.outlet_id, [row.id]))[0];
      });
      return reply.status(201).send(camera);
    });

    async function onCamera<T>(auth: ReturnType<typeof requireStaff>, id: string, fn: (tx: Tx, outletId: string) => Promise<T>) {
      return ctx.tx(auth.tenantId, async (tx) => {
        const cam = await tx.db.selectFrom('cameras').select('outlet_id').where('id', '=', id).executeTakeFirst();
        if (!cam) throw notFound('Camera');
        assertCan(auth, cam.outlet_id, 'table.manage');
        return fn(tx, cam.outlet_id);
      });
    }

    app.patch('/cameras/:id', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ name: z.string().trim().min(1).max(60).optional(), status: z.enum(['active', 'disabled']).optional(), rtsp_secret_ref: ref.optional() }), req.body);
      return onCamera(auth, id, async (tx, outletId) => {
        await tx.db.updateTable('cameras').set(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))).where('id', '=', id).execute();
        if (body.status === 'disabled') {
          // A switched-off camera stops counting at once.
          const tables = await tx.db.updateTable('tables').set({ camera_state: null, camera_at: null, camera_occupied_since: null }).where('camera_id', '=', id).returning('id').execute();
          await refreshTableStates(tx, tables.map((t) => t.id), 'staff');
        }
        await audit(tx, auth, { outletId, action: 'camera.update', entity: 'camera', entityId: id, after: body });
        return (await loadCameras(tx, outletId, [id]))[0];
      });
    });

    app.post('/cameras/:id/snapshot-request', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return onCamera(auth, id, async (tx, outletId) => {
        await tx.db.updateTable('cameras').set({ snapshot_requested_at: new Date() }).where('id', '=', id).execute();
        return (await loadCameras(tx, outletId, [id]))[0];
      });
    });

    /** The still is private (it shows the dining room): served only to staff who set up zones. */
    app.get('/cameras/:id/snapshot', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const image = await onCamera(auth, id, async (tx) => (await tx.db.selectFrom('cameras').select('snapshot').where('id', '=', id).executeTakeFirstOrThrow()).snapshot);
      if (!image) throw notFound('Snapshot');
      reply.header('content-type', 'image/jpeg');
      reply.header('cache-control', 'private, no-store');
      return reply.send(image);
    });

    app.delete('/cameras/:id/snapshot', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await onCamera(auth, id, (tx) => tx.db.updateTable('cameras').set({ snapshot: null, snapshot_at: null }).where('id', '=', id).execute());
      return reply.status(204).send();
    });

    /** Draws (or removes) a table's zone on a camera picture, in 0..1 coordinates. */
    app.put('/tables/:id/camera-zone', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ camera_id: z.uuid().nullable(), polygon: z.array(point).min(3).max(24).nullable() }), req.body);
      if (!!body.camera_id !== !!body.polygon) throw badRequest('zone_incomplete', 'Give both a camera and a polygon, or neither to remove the zone');
      return ctx.tx(auth.tenantId, async (tx) => {
        const table = await tx.db.selectFrom('tables').select(['id', 'outlet_id', 'camera_id']).where('id', '=', id).executeTakeFirst();
        if (!table) throw notFound('Table');
        assertCan(auth, table.outlet_id, 'table.manage');
        if (body.camera_id) {
          const cam = await tx.db.selectFrom('cameras').select('id').where('id', '=', body.camera_id).where('outlet_id', '=', table.outlet_id).executeTakeFirst();
          if (!cam) throw badRequest('invalid_camera', 'Camera is not in this outlet');
        }
        const moved = table.camera_id !== body.camera_id;
        await tx.db
          .updateTable('tables')
          .set({
            camera_id: body.camera_id,
            camera_zone_polygon: body.polygon ? json(body.polygon) : null,
            ...(moved ? { camera_state: null, camera_at: null, camera_confidence: null, camera_occupied_since: null } : {}),
          })
          .where('id', '=', id)
          .execute();
        await refreshTableStates(tx, [id], 'staff');
        await tx.emit({ outletId: table.outlet_id, type: 'tables.updated', channels: ['outlet'], payload: { table_id: id } });
        return { table_id: id, camera_id: body.camera_id, polygon: body.polygon };
      });
    });
  };
}
