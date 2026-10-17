import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BillDoc, KotDoc, PrintDoc, PrintJobDTO, PrintProblemDTO, PrintStatusDTO } from '@mezmitra/shared/print';
import type { AppContext, Tx } from '../../context';
import { json } from '../../db';
import { assertCan, requireDevice, requireStaff } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { idParams, outletQuery, parse } from '../../lib/validate';
import { webOrigin } from '../../lib/links';
import { ONLINE_WINDOW_MS } from '../devices/routes';
import { queuePrintJob } from './jobs';

const MAX_ATTEMPTS = 5;

function jobDto(j: { id: string; kind: string; target: string; doc: unknown; status: string; attempts: number; created_at: Date }): PrintJobDTO {
  return {
    id: j.id,
    kind: j.kind as PrintJobDTO['kind'],
    target: j.target,
    doc: j.doc as PrintDoc,
    status: j.status as PrintJobDTO['status'],
    attempts: j.attempts,
    created_at: j.created_at.toISOString(),
  };
}

const JOB_COLUMNS = ['id', 'kind', 'target', 'doc', 'status', 'attempts', 'created_at', 'last_error', 'printed_at'] as const;

/** A job the agent has not printed this long after it was queued is reported as waiting. */
const WAITING_AFTER_MS = 90_000;
/** Problems older than this are no longer shown. */
const PROBLEM_WINDOW_MS = 12 * 3600_000;

const ORDER_KIND: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', counter: 'Counter', delivery: 'Delivery' };

/** What staff call a print job: "KOT 12 · Table C4", "Bill AGC/2627/000135". */
function jobLabel(doc: PrintDoc): string {
  if (doc.kind === 'kot') {
    const k = doc as KotDoc;
    return `KOT ${k.kot_no} · ${k.table_label ? `Table ${k.table_label}` : `${ORDER_KIND[k.order_type] ?? k.order_type} #${k.order_no}`}`;
  }
  if (doc.kind === 'bill') return `Bill ${(doc as BillDoc).invoice.bill.invoice_no ?? ''}`.trim();
  return 'Test page';
}

const foundPrinter = z.object({ address: z.string().trim().min(1).max(140), label: z.string().trim().min(1).max(120), kind: z.enum(['network', 'system', 'device']) });

export default function routes(ctx: AppContext): FastifyPluginAsync {
  // Agents poll every few seconds where the live link is not available; one write in 20 s is enough.
  async function touch(tx: Tx, deviceId: string) {
    await tx.db
      .updateTable('devices')
      .set({ last_seen_at: new Date() })
      .where('id', '=', deviceId)
      .where((eb) => eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<', new Date(Date.now() - 20_000))]))
      .execute();
  }

  return async (app) => {
    // ---------------------------------------------------------------- print agent (device token)

    app.get('/device/me', async (req) => {
      const auth = requireDevice(req, 'print_agent');
      return ctx.tx(auth.tenantId, async (tx) => {
        await touch(tx, auth.deviceId);
        const d = await tx.db
          .selectFrom('devices')
          .innerJoin('outlets', 'outlets.id', 'devices.outlet_id')
          .select(['devices.id', 'devices.name', 'devices.config', 'outlets.id as outlet_id', 'outlets.name as outlet_name', 'outlets.kitchen_stations', 'outlets.config_version'])
          .where('devices.id', '=', auth.deviceId)
          .executeTakeFirstOrThrow();
        // Fetching its settings is how a print computer applies a change; record which it has.
        const { config_version, ...me } = d;
        await tx.db.updateTable('devices').set({ applied_version: config_version, applied_at: new Date() }).where('id', '=', auth.deviceId).execute();
        // Receipts carry a link for guests to follow their order; the agent adds this address.
        return { ...me, web_origin: webOrigin(ctx.config) };
      });
    });

    app.post('/device/heartbeat', async (req, reply) => {
      const auth = requireDevice(req);
      await ctx.tx(auth.tenantId, (tx) => touch(tx, auth.deviceId));
      return reply.status(204).send();
    });

    /**
     * Backlog for an agent that just (re)connected, and a safety net poll. Claims queued jobs by
     * marking them sent; jobs sent but never acked are offered again after a minute.
     */
    app.get('/device/print-jobs', async (req) => {
      const auth = requireDevice(req, 'print_agent');
      return ctx.tx(auth.tenantId, async (tx) => {
        await touch(tx, auth.deviceId);
        const jobs = await tx.db
          .selectFrom('print_jobs')
          .select(JOB_COLUMNS)
          .where('outlet_id', '=', auth.outletId)
          .where((eb) =>
            eb.or([
              eb('status', '=', 'queued'),
              eb.and([eb('status', '=', 'sent'), eb('sent_at', '<', new Date(Date.now() - 60_000))]),
            ]),
          )
          .orderBy('created_at')
          .limit(50)
          .forUpdate()
          .skipLocked()
          .execute();
        if (jobs.length) {
          await tx.db
            .updateTable('print_jobs')
            .set((eb) => ({ status: 'sent', sent_at: new Date(), device_id: auth.deviceId, attempts: eb('attempts', '+', 1) }))
            .where('id', 'in', jobs.map((j) => j.id))
            .execute();
        }
        return jobs.map((j) => jobDto({ ...j, status: 'sent', attempts: j.attempts + 1 }));
      });
    });

    app.post('/device/print-jobs/:id/ack', async (req) => {
      const auth = requireDevice(req, 'print_agent');
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ status: z.enum(['printed', 'failed']), error: z.string().max(500).optional() }), req.body);
      return ctx.tx(auth.tenantId, async (tx) => {
        const job = await tx.db
          .selectFrom('print_jobs')
          .select(['id', 'kind', 'ref_id', 'attempts', 'status'])
          .where('id', '=', id)
          .where('outlet_id', '=', auth.outletId)
          .forUpdate()
          .executeTakeFirst();
        if (!job) throw notFound('Print job');
        if (job.status === 'printed') return { id, status: 'printed' };
        if (body.status === 'printed') {
          await tx.db.updateTable('print_jobs').set({ status: 'printed', printed_at: new Date(), device_id: auth.deviceId, last_error: null }).where('id', '=', id).execute();
          if (job.kind === 'kot' && job.ref_id) {
            await tx.db.updateTable('kots').set({ printed_at: new Date() }).where('id', '=', job.ref_id).where('printed_at', 'is', null).execute();
          }
          return { id, status: 'printed' };
        }
        const giveUp = job.attempts >= MAX_ATTEMPTS;
        await tx.db
          .updateTable('print_jobs')
          .set({ status: giveUp ? 'failed' : 'queued', last_error: body.error ?? 'unknown error' })
          .where('id', '=', id)
          .execute();
        if (giveUp) {
          // Staff need to know a kitchen ticket did not print.
          const outlet = await tx.db.selectFrom('print_jobs').select('outlet_id').where('id', '=', id).executeTakeFirstOrThrow();
          await tx.emit({ outletId: outlet.outlet_id, type: 'print.job', channels: ['outlet'], payload: { job_id: id, status: 'failed', error: body.error } });
        }
        return { id, status: giveUp ? 'failed' : 'queued' };
      });
    });

    /** What the agent found on its computer and network, for the printer picker in Settings. */
    app.post('/device/report', async (req, reply) => {
      const auth = requireDevice(req, 'print_agent');
      const body = parse(
        z.object({
          version: z.string().max(40).optional(),
          platform: z.string().max(60).optional(),
          hostname: z.string().max(120).optional(),
          printers: z.array(foundPrinter).max(50),
        }),
        req.body,
      );
      await ctx.tx(auth.tenantId, async (tx) => {
        await tx.db
          .updateTable('devices')
          .set({ info: json({ ...body, scanned_at: new Date().toISOString() }), last_seen_at: new Date() })
          .where('id', '=', auth.deviceId)
          .execute();
      });
      return reply.status(204).send();
    });

    // ---------------------------------------------------------------- staff view of the queue

    /**
     * Whether printing works right now: the outlet's print computers, and kitchen tickets or bills
     * that failed or are still waiting (the computer is off, a printer is out of paper).
     */
    app.get('/print/status', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery, req.query);
      assertCan(auth, q.outlet_id, 'order.view');
      return ctx.tx(auth.tenantId, async (tx): Promise<PrintStatusDTO> => {
        const devices = await tx.db
          .selectFrom('devices')
          .select(['id', 'name', 'last_seen_at'])
          .where('outlet_id', '=', q.outlet_id)
          .where('kind', '=', 'print_agent')
          .where('status', '=', 'active')
          .orderBy('created_at')
          .execute();
        const now = Date.now();
        const jobs = await tx.db
          .selectFrom('print_jobs')
          .leftJoin('kots', 'kots.id', 'print_jobs.ref_id')
          .select(['print_jobs.id', 'print_jobs.kind', 'print_jobs.target', 'print_jobs.doc', 'print_jobs.status', 'print_jobs.last_error', 'print_jobs.created_at', 'print_jobs.ref_id', 'kots.order_id'])
          .where('print_jobs.outlet_id', '=', q.outlet_id)
          .where('print_jobs.dismissed_at', 'is', null)
          .where('print_jobs.kind', '<>', 'drawer')
          .where('print_jobs.created_at', '>', new Date(now - PROBLEM_WINDOW_MS))
          .where((eb) =>
            eb.or([
              eb('print_jobs.status', '=', 'failed'),
              eb.and([eb('print_jobs.status', 'in', ['queued', 'sent']), eb('print_jobs.created_at', '<', new Date(now - WAITING_AFTER_MS))]),
            ]),
          )
          .orderBy('print_jobs.created_at')
          .limit(30)
          .execute();
        return {
          agents: devices.map((d) => ({ id: d.id, name: d.name, online: !!d.last_seen_at && now - d.last_seen_at.getTime() < ONLINE_WINDOW_MS, last_seen_at: d.last_seen_at?.toISOString() ?? null })),
          problems: jobs.map(
            (j): PrintProblemDTO => ({
              job_id: j.id,
              kind: j.kind as PrintProblemDTO['kind'],
              target: j.target,
              label: jobLabel(j.doc as unknown as PrintDoc),
              order_id: j.kind === 'kot' ? j.order_id : null,
              bill_id: j.kind === 'bill' ? j.ref_id : null,
              status: j.status === 'failed' ? 'failed' : 'waiting',
              since: j.created_at.toISOString(),
              error: j.last_error,
            }),
          ),
        };
      });
    });

    /** The kitchen has it some other way (read off the screen, printed again): stop warning. */
    app.post('/print-jobs/:id/dismiss', async (req, reply) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      await ctx.tx(auth.tenantId, async (tx) => {
        const job = await tx.db.selectFrom('print_jobs').select(['outlet_id']).where('id', '=', id).executeTakeFirst();
        if (!job) throw notFound('Print job');
        assertCan(auth, job.outlet_id, 'order.view');
        await tx.db.updateTable('print_jobs').set({ dismissed_at: new Date() }).where('id', '=', id).where('dismissed_at', 'is', null).execute();
      });
      return reply.status(204).send();
    });

    app.get('/print-jobs', async (req) => {
      const auth = requireStaff(req);
      const q = parse(outletQuery.extend({ status: z.enum(['queued', 'sent', 'printed', 'failed']).optional() }), req.query);
      assertCan(auth, q.outlet_id, 'order.view');
      return ctx.tx(auth.tenantId, async (tx) => {
        let query = tx.db.selectFrom('print_jobs').select(JOB_COLUMNS).where('outlet_id', '=', q.outlet_id);
        if (q.status) query = query.where('status', '=', q.status);
        const rows = await query.orderBy('created_at', 'desc').limit(100).execute();
        return rows.map((r) => ({ ...jobDto(r), last_error: r.last_error, printed_at: r.printed_at?.toISOString() ?? null }));
      });
    });

    app.post('/print-jobs/:id/retry', async (req) => {
      const auth = requireStaff(req);
      const { id } = parse(idParams, req.params);
      return ctx.tx(auth.tenantId, async (tx) => {
        const job = await tx.db.selectFrom('print_jobs').select(['outlet_id', 'target', 'doc', 'ref_id']).where('id', '=', id).executeTakeFirst();
        if (!job) throw notFound('Print job');
        assertCan(auth, job.outlet_id, 'order.view');
        await tx.db
          .updateTable('print_jobs')
          .set({ status: 'failed', last_error: 'superseded by retry', dismissed_at: new Date() })
          .where('id', '=', id)
          .where('status', '<>', 'printed')
          .execute();
        return queuePrintJob(tx, job.outlet_id, { target: job.target, refId: job.ref_id, doc: job.doc as unknown as PrintDoc });
      });
    });

    app.post('/print/test', async (req) => {
      const auth = requireStaff(req);
      const body = parse(z.object({ outlet_id: z.uuid(), target: z.string().min(1).max(30) }), req.body);
      assertCan(auth, body.outlet_id, 'device.manage');
      return ctx.tx(auth.tenantId, async (tx) => {
        const outlet = await tx.db.selectFrom('outlets').select(['name', 'kitchen_stations']).where('id', '=', body.outlet_id).executeTakeFirstOrThrow();
        if (body.target !== 'bill' && !outlet.kitchen_stations.includes(body.target)) throw badRequest('invalid_target', 'Unknown printer target');
        return queuePrintJob(tx, body.outlet_id, {
          target: body.target,
          doc: { kind: 'test', outlet_name: outlet.name, target: body.target, at: new Date().toISOString() },
        });
      });
    });
  };
}
