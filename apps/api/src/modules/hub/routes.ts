import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HUB_PAYMENT_METHODS, ITEM_STATUSES, ORDER_SOURCES, ORDER_STATUSES, ORDER_TYPES } from '@mezmitra/shared/enums';
import type { HubSyncPayload } from '@mezmitra/shared/hub';
import type { AppContext } from '../../context';
import { requireDevice, type DeviceAuth } from '../../lib/auth';
import { forbidden } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { ingestHubSync } from './ingest';
import { buildSnapshot } from './snapshot';

const ts = z.iso.datetime({ offset: true });
const money = z.number().int().min(-100_000_000).max(100_000_000);
const text = (max: number) => z.string().max(max).nullable();

const session = z.object({
  id: z.uuid(),
  table_id: z.uuid(),
  status: z.enum(['open', 'closed']),
  opened_at: ts.nullable(),
  closed_at: ts.nullable(),
  guest_count: z.number().int().min(1).max(500).nullable(),
  waiter_id: z.uuid().nullable(),
  bill_requested_at: ts.nullable(),
});

const item = z.object({
  id: z.uuid(),
  item_id: z.uuid(),
  name: z.string().min(1).max(200),
  price_paise: money,
  unit_price_paise: money,
  modifiers: z.array(z.object({ modifier_id: z.uuid(), group_name: z.string().max(80), name: z.string().max(80), price_delta_paise: money })).max(30),
  is_veg: z.boolean(),
  tax_rate_bp: z.number().int().min(0).max(2800),
  hsn_sac: text(20),
  qty: z.number().int().min(1).max(999),
  note: text(300),
  status: z.enum(ITEM_STATUSES),
  station: z.string().min(1).max(30),
  seat_no: z.number().int().min(1).max(100).nullable(),
  cancelled_reason: text(300),
  position: z.number().int().min(0).max(10_000),
});

const order = z.object({
  id: z.uuid(),
  table_session_id: z.uuid().nullable(),
  table_id: z.uuid().nullable(),
  order_no: z.number().int().min(0),
  offline_ref: text(20),
  business_date: z.iso.date(),
  type: z.enum(ORDER_TYPES),
  status: z.enum(ORDER_STATUSES),
  source: z.enum(ORDER_SOURCES),
  note: text(300),
  flagged: z.boolean(),
  customer_name: text(80),
  customer_phone: text(20),
  created_by: z.uuid().nullable(),
  placed_at: ts,
  accepted_at: ts.nullable(),
  ready_at: ts.nullable(),
  served_at: ts.nullable(),
  rejected_reason: text(300),
  cancelled_reason: text(300),
  items: z.array(item).max(300),
});

const bill = z.object({
  id: z.uuid(),
  table_session_id: z.uuid().nullable(),
  order_id: z.uuid().nullable(),
  status: z.enum(['draft', 'finalised', 'paid']),
  invoice_series: z.enum(['main', 'hub']),
  fy_code: z.string().regex(/^\d{4}$/).nullable(),
  invoice_seq: z.number().int().min(1).nullable(),
  invoice_no: text(16),
  invoice_date: z.iso.date().nullable(),
  service_charge_bp: z.number().int().min(0).max(2500),
  service_charge_waived: z.boolean(),
  service_charge_tax_rate_bp: z.number().int().min(0).max(2800),
  subtotal_paise: money,
  item_discount_paise: money,
  bill_discount_paise: money,
  loyalty_discount_paise: money,
  service_charge_paise: money,
  taxable_paise: money,
  cgst_paise: money,
  sgst_paise: money,
  tax_total_paise: money,
  round_off_paise: money,
  total_paise: money,
  paid_paise: money,
  customer_name: text(120),
  customer_gstin: text(15),
  outlet_snapshot: z
    .object({
      name: z.string().max(120),
      legal_name: text(160),
      address: text(400),
      gstin: text(15),
      fssai_no: text(20),
      phone: text(30),
      state_code: text(2),
    })
    .nullable(),
  finalised_at: ts.nullable(),
  finalised_by: z.uuid().nullable(),
  paid_at: ts.nullable(),
  created_at: ts,
  lines: z
    .array(
      z.object({
        order_item_id: z.uuid(),
        name: z.string().min(1).max(300),
        qty: z.number().int().min(1).max(999),
        unit_price_paise: money,
        gross_paise: money,
        item_discount_paise: money,
        bill_discount_paise: money,
        taxable_paise: money,
        tax_rate_bp: z.number().int().min(0).max(2800),
        cgst_paise: money,
        sgst_paise: money,
        amount_paise: money,
        hsn_sac: text(20),
        seat_no: z.number().int().min(1).max(100).nullable(),
      }),
    )
    .max(500),
  payments: z
    .array(
      z.object({
        id: z.uuid(),
        method: z.enum(HUB_PAYMENT_METHODS),
        amount_paise: z.number().int().min(1).max(100_000_000),
        tendered_paise: money.nullable(),
        change_paise: money.nullable(),
        reference: text(80),
        confirmed_by: z.uuid().nullable(),
        created_at: ts,
        room_no: z.string().regex(/^[A-Z0-9][A-Z0-9 -]{0,9}$/).nullable().default(null),
        room_guest: text(80).default(null),
      }),
    )
    .max(50),
});

const syncBody = z.object({
  sessions: z.array(session).max(500),
  orders: z.array(order).max(2000),
  bills: z.array(bill).max(1000),
  tables: z.array(z.object({ id: z.uuid(), needs_cleaning: z.boolean() })).max(500),
});

export default function routes(ctx: AppContext): FastifyPluginAsync {
  const webUrl = (() => {
    try {
      return new URL(ctx.config.GUEST_URL_TEMPLATE.replace('{token}', 'x')).origin;
    } catch {
      return null;
    }
  })();

  /** Only the device the outlet chose as its hub gets the staff session list. */
  async function requireHub(auth: DeviceAuth): Promise<void> {
    const outlet = await ctx.tx(auth.tenantId, (tx) => tx.db.selectFrom('outlets').select('hub_device_id').where('id', '=', auth.outletId).executeTakeFirstOrThrow());
    if (outlet.hub_device_id !== auth.deviceId) throw forbidden('This device is not the outlet hub. Choose it in Settings > Printers.');
  }

  return async (app) => {
    app.get('/device/hub/snapshot', async (req) => {
      const auth = requireDevice(req, 'print_agent');
      await requireHub(auth);
      return ctx.tx(auth.tenantId, async (tx) => {
        await tx.db.updateTable('devices').set({ last_seen_at: new Date() }).where('id', '=', auth.deviceId).execute();
        return buildSnapshot(tx, auth.outletId, auth.deviceId, webUrl);
      });
    });

    app.post('/device/hub/sync', { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
      const auth = requireDevice(req, 'print_agent');
      await requireHub(auth);
      const body = parse(syncBody, req.body) as HubSyncPayload;
      return ingestHubSync(ctx, auth, body);
    });
  };
}
