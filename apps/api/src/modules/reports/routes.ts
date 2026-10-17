import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { businessDate } from '@dineos/shared/dates';
import type { AppContext } from '../../context';
import { assertCan, requireStaff } from '../../lib/auth';
import { badRequest } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { inventoryReport } from '../inventory/report';
import { roomCharges } from '../billing/rooms';
import { compReport } from '../comps/service';
import { visionAudit } from '../vision/audit';
import { insights } from './insights';
import { dashboard, dayEnd, deliveryReport, gstReport, itemSales, salesSummary, toCsv, type Range } from './service';

const rangeQuery = z.object({
  outlet_id: z.uuid(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  date: z.iso.date().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

/** Money columns become rupees in CSV so spreadsheets open cleanly. */
function rupees(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => (k.endsWith('_paise') && typeof v === 'number' ? [k.replace(/_paise$/, '_inr'), (v / 100).toFixed(2)] : [k, v])),
    ),
  );
}

function sendCsv(reply: FastifyReply, name: string, rows: Record<string, unknown>[]) {
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${name}.csv"`);
  return reply.send(toCsv(rupees(rows)));
}

export default function routes(ctx: AppContext): FastifyPluginAsync {
  async function range(req: { query: unknown; auth: unknown }, tenantId: string) {
    const q = parse(rangeQuery, req.query);
    const outlet = await ctx.tx(tenantId, (tx) => tx.db.selectFrom('outlets').select('timezone').where('id', '=', q.outlet_id).executeTakeFirst());
    if (!outlet) throw badRequest('invalid_outlet', 'Unknown outlet');
    const today = businessDate(new Date(), outlet.timezone);
    const from = q.date ?? q.from ?? today;
    const to = q.date ?? q.to ?? from;
    if (to < from) throw badRequest('invalid_range', '"to" is before "from"');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw badRequest('range_too_long', 'At most one year at a time');
    const r: Range = { outletId: q.outlet_id, from, to, timezone: outlet.timezone };
    return { r, format: q.format };
  }

  return async (app) => {
    app.get('/reports/sales', async (req, reply) => {
      const auth = requireStaff(req);
      const { r, format } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      const data = await ctx.tx(auth.tenantId, (tx) => salesSummary(tx, r));
      return format === 'csv' ? sendCsv(reply, `sales-${r.from}-${r.to}`, data.by_day) : data;
    });

    app.get('/reports/gst', async (req, reply) => {
      const auth = requireStaff(req);
      const { r, format } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      const data = await ctx.tx(auth.tenantId, (tx) => gstReport(tx, r));
      return format === 'csv' ? sendCsv(reply, `gst-${r.from}-${r.to}`, data.hsn_summary) : data;
    });

    app.get('/reports/items', async (req, reply) => {
      const auth = requireStaff(req);
      const { r, format } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      const data = await ctx.tx(auth.tenantId, (tx) => itemSales(tx, r));
      return format === 'csv' ? sendCsv(reply, `items-${r.from}-${r.to}`, data) : data;
    });

    app.get('/reports/day-end', async (req) => {
      const auth = requireStaff(req);
      const { r } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      return ctx.tx(auth.tenantId, (tx) => dayEnd(tx, r));
    });

    app.get('/reports/delivery', async (req, reply) => {
      const auth = requireStaff(req);
      const { r, format } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      const data = await ctx.tx(auth.tenantId, (tx) => deliveryReport(tx, r));
      return format === 'csv' ? sendCsv(reply, `delivery-${r.from}-${r.to}`, data.channels) : data;
    });

    /** Free food and drinks: what, why, for whom, who gave and approved it, and what it cost. */
    app.get('/reports/comps', async (req, reply) => {
      const auth = requireStaff(req);
      const { r, format } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      const data = await ctx.tx(auth.tenantId, (tx) => compReport(tx, r));
      if (format !== 'csv') return data;
      return sendCsv(
        reply,
        `complimentary-${r.from}-${r.to}`,
        data.rows.map((c) => ({
          date: c.created_at,
          item: c.item_name,
          qty: c.qty,
          value_paise: c.value_paise,
          cost_paise: c.cost_paise ?? '',
          reason: c.reason,
          note: c.note ?? '',
          whole_bill: c.whole_bill ? 'yes' : '',
          guest: c.customer ? `${c.customer.name ?? ''} (…${c.customer.phone_last4})` : '',
          given_by: c.given_by,
          approved_by: c.approved_by ?? '',
          table: c.table_label ?? '',
          order_no: c.order_no,
          invoice_no: c.invoice_no ?? '',
          undone: c.removed_at ? 'yes' : '',
        })),
      );
    });

    app.get('/reports/insights', async (req) => {
      const auth = requireStaff(req);
      const { r } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      return ctx.tx(auth.tenantId, (tx) => insights(tx, r));
    });

    /** Room charges for the front desk to post to folios; ?unposted=1 for what is still open. */
    app.get('/reports/room-charges', async (req, reply) => {
      const auth = requireStaff(req);
      const { r, format } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      const unposted = ['1', 'true'].includes(String((req.query as Record<string, unknown>).unposted ?? ''));
      const data = await ctx.tx(auth.tenantId, (tx) => roomCharges(tx, r, { unpostedOnly: unposted }));
      if (format !== 'csv') return data;
      return sendCsv(
        reply,
        `room-charges-${r.from}-${r.to}`,
        data.rows.map((x) => ({
          date: new Intl.DateTimeFormat('en-CA', { timeZone: r.timezone }).format(new Date(x.at)),
          time: new Date(x.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: r.timezone }),
          room: x.room_no,
          guest: x.room_guest ?? '',
          invoice: x.invoice_no ?? '',
          table: x.table_label ?? '',
          type: x.kind,
          amount_paise: x.amount_paise,
          posted: x.posted_at ? 'yes' : 'no',
        })),
      );
    });

    app.get('/reports/vision', async (req) => {
      const auth = requireStaff(req);
      const { r } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      return ctx.tx(auth.tenantId, (tx) => visionAudit(tx, r));
    });

    app.get('/reports/inventory', async (req, reply) => {
      const auth = requireStaff(req);
      const { r, format } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      const data = await ctx.tx(auth.tenantId, (tx) => inventoryReport(tx, r));
      return format === 'csv' ? sendCsv(reply, `inventory-${r.from}-${r.to}`, data.ingredients) : data;
    });

    app.get('/reports/dashboard', async (req) => {
      const auth = requireStaff(req);
      const { r } = await range(req, auth.tenantId);
      assertCan(auth, r.outletId, 'report.view');
      return ctx.tx(auth.tenantId, (tx) => dashboard(tx, r));
    });
  };
}
