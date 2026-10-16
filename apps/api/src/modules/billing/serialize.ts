import { splitEvenly } from '@dineos/shared/billing';
import type { BillDTO, BillLineDTO, InvoiceDTO, PaymentDTO } from '@dineos/shared/dto';
import type { BillStatus, PaymentMethod } from '@dineos/shared/enums';
import type { Tx } from '../../context';

export type AmountSplit = { count: number } | { amounts: number[] };

export function shares(split: unknown, total: number): number[] | null {
  if (!split || typeof split !== 'object') return null;
  if ('count' in split && typeof split.count === 'number') return splitEvenly(total, split.count);
  if ('amounts' in split && Array.isArray(split.amounts)) return split.amounts as number[];
  return null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function loadBills(tx: Tx, ids: readonly string[]): Promise<BillDTO[]> {
  if (ids.length === 0) return [];
  const bills = await tx.db
    .selectFrom('bills')
    .leftJoin('table_sessions', 'table_sessions.id', 'bills.table_session_id')
    .leftJoin('orders', 'orders.id', 'bills.order_id')
    .selectAll('bills')
    .select(['table_sessions.table_id as session_table_id', 'orders.table_id as order_table_id'])
    .where('bills.id', 'in', [...ids])
    .execute();
  const customerIds = [...new Set(bills.map((b) => b.customer_id).filter((x): x is string => !!x))];
  const customers = new Map(
    customerIds.length
      ? (await tx.db.selectFrom('customers').select(['id', 'name', 'phone', 'points']).where('id', 'in', customerIds).execute()).map((c) => [c.id, c])
      : [],
  );
  const tableIds = [...new Set(bills.map((b) => b.session_table_id ?? b.order_table_id).filter((x): x is string => !!x))];
  const labels = new Map(
    tableIds.length
      ? (await tx.db.selectFrom('tables').select(['id', 'label']).where('id', 'in', tableIds).execute()).map((t) => [t.id, t.label])
      : [],
  );
  const lines = await tx.db
    .selectFrom('bill_lines')
    .selectAll()
    .where('bill_id', 'in', [...ids])
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const payments = await tx.db
    .selectFrom('payments')
    .leftJoin('users', 'users.id', 'payments.confirmed_by')
    .selectAll('payments')
    .select('users.name as confirmed_by_name')
    .where('payments.bill_id', 'in', [...ids])
    .orderBy('payments.created_at')
    .execute();

  const map = new Map(
    bills.map((b) => {
      const dto: BillDTO = {
        id: b.id,
        outlet_id: b.outlet_id,
        table_session_id: b.table_session_id,
        order_id: b.order_id,
        table_label: labels.get(b.session_table_id ?? b.order_table_id ?? '') ?? null,
        parent_bill_id: b.parent_bill_id,
        split_label: b.split_label,
        status: b.status as BillStatus,
        lines: lines
          .filter((l) => l.bill_id === b.id)
          .map(
            (l): BillLineDTO => ({
              id: l.id,
              order_item_id: l.order_item_id,
              name: l.name,
              qty: l.qty,
              unit_price_paise: l.unit_price_paise,
              gross_paise: l.gross_paise,
              item_discount_paise: l.item_discount_paise,
              bill_discount_paise: l.bill_discount_paise,
              taxable_paise: l.taxable_paise,
              tax_rate_bp: l.tax_rate_bp,
              cgst_paise: l.cgst_paise,
              sgst_paise: l.sgst_paise,
              amount_paise: l.amount_paise,
              hsn_sac: l.hsn_sac,
              seat_no: l.seat_no,
            }),
          ),
        bill_discount: (b.bill_discount ?? null) as BillDTO['bill_discount'],
        discount_reason: b.discount_reason,
        service_charge_bp: b.service_charge_bp,
        service_charge_waived: b.service_charge_waived,
        subtotal_paise: b.subtotal_paise,
        item_discount_paise: b.item_discount_paise,
        bill_discount_paise: b.bill_discount_paise,
        service_charge_paise: b.service_charge_paise,
        taxable_paise: b.taxable_paise,
        cgst_paise: b.cgst_paise,
        sgst_paise: b.sgst_paise,
        tax_total_paise: b.tax_total_paise,
        round_off_paise: b.round_off_paise,
        total_paise: b.total_paise,
        paid_paise: b.paid_paise,
        balance_paise: Math.max(0, b.total_paise - b.paid_paise),
        amount_shares: shares(b.amount_shares, b.total_paise),
        customer: b.customer_id ? (customers.get(b.customer_id) ?? null) : null,
        loyalty_points_redeemed: b.loyalty_points_redeemed,
        loyalty_discount_paise: b.loyalty_discount_paise,
        loyalty_points_earned: b.loyalty_points_earned,
        invoice_no: b.invoice_no,
        invoice_date: b.invoice_date,
        customer_name: b.customer_name,
        customer_gstin: b.customer_gstin,
        payments: payments
          .filter((p) => p.bill_id === b.id)
          .map(
            (p): PaymentDTO => ({
              id: p.id,
              bill_id: p.bill_id,
              kind: p.kind as PaymentDTO['kind'],
              method: p.method as PaymentMethod,
              amount_paise: p.amount_paise,
              tendered_paise: p.tendered_paise,
              change_paise: p.change_paise,
              reference: p.reference,
              confirmed_by_name: p.confirmed_by_name,
              created_at: p.created_at.toISOString(),
              room_no: p.room_no,
              room_guest: p.room_guest,
              room_posted_at: iso(p.room_posted_at),
            }),
          ),
        finalised_at: iso(b.finalised_at),
        paid_at: iso(b.paid_at),
        voided_at: iso(b.voided_at),
        void_reason: b.void_reason,
        created_at: b.created_at.toISOString(),
      };
      return [b.id, dto] as const;
    }),
  );
  return ids.map((id) => map.get(id)).filter((b): b is BillDTO => !!b);
}

export async function loadBill(tx: Tx, id: string): Promise<BillDTO | null> {
  return (await loadBills(tx, [id]))[0] ?? null;
}

/** The invoice view: frozen outlet details for finalised bills, live ones for drafts. */
export async function loadInvoice(tx: Tx, billId: string): Promise<InvoiceDTO | null> {
  const bill = await loadBill(tx, billId);
  if (!bill) return null;
  const row = await tx.db
    .selectFrom('bills')
    .select(['outlet_snapshot', 'service_charge_tax_rate_bp'])
    .where('id', '=', billId)
    .executeTakeFirstOrThrow();
  let outlet = row.outlet_snapshot as InvoiceDTO['outlet'] | null;
  if (!outlet) {
    outlet = await tx.db
      .selectFrom('outlets')
      .select(['name', 'legal_name', 'address', 'gstin', 'fssai_no', 'phone', 'state_code'])
      .where('id', '=', bill.outlet_id)
      .executeTakeFirstOrThrow();
  }
  const byRate = new Map<number, { tax_rate_bp: number; taxable_paise: number; cgst_paise: number; sgst_paise: number }>();
  const add = (rate: number, taxable: number, cgst: number, sgst: number) => {
    const r = byRate.get(rate) ?? { tax_rate_bp: rate, taxable_paise: 0, cgst_paise: 0, sgst_paise: 0 };
    r.taxable_paise += taxable;
    r.cgst_paise += cgst;
    r.sgst_paise += sgst;
    byRate.set(rate, r);
  };
  for (const l of bill.lines) add(l.tax_rate_bp, l.taxable_paise, l.cgst_paise, l.sgst_paise);
  if (bill.service_charge_paise > 0) {
    const linesCgst = bill.lines.reduce((a, l) => a + l.cgst_paise, 0);
    const linesSgst = bill.lines.reduce((a, l) => a + l.sgst_paise, 0);
    add(row.service_charge_tax_rate_bp, bill.service_charge_paise, bill.cgst_paise - linesCgst, bill.sgst_paise - linesSgst);
  }
  return { bill, outlet, tax_summary: [...byRate.values()].sort((a, b) => a.tax_rate_bp - b.tax_rate_bp) };
}

/** "upi://pay?..." so the guest can pay the outlet's own UPI ID; staff confirm receipt by hand. */
export function upiUri(vpa: string | null, payee: string | null, amountPaise: number, note: string): string | null {
  if (!vpa) return null;
  const params = new URLSearchParams({
    pa: vpa,
    pn: payee ?? '',
    am: (amountPaise / 100).toFixed(2),
    cu: 'INR',
    tn: note,
  });
  return `upi://pay?${params.toString()}`;
}
