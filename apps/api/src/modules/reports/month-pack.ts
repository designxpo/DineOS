// The month-end pack for the accountant: one workbook with every figure they ask for, each sheet
// filterable, money as numbers in rupees, and a "Read me" sheet with the same definitions the
// owner sees on screen.

import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { REPORT_DATE_RULES, REPORT_TERMS } from '@mezmitra/shared/report-terms';
import type { Tx } from '../../context';
import { compReport } from '../comps/service';
import { dayEnd, gstReport, salesSummary, type Range } from './service';

const COMP_REASON: Record<string, string> = {
  mishap: 'Mishap made right',
  special_guest: 'Special guest',
  owners_guest: "Owner's guest",
  celebration: 'Celebration',
  staff_meal: 'Staff meal',
  marketing: 'Marketing or tasting',
  loyalty: 'Loyalty reward',
  other: 'Other',
};

interface Column {
  header: string;
  key: string;
  width?: number;
  money?: boolean;
}

const inr = (paise: number | null | undefined) => (paise == null ? null : Math.round(paise) / 100);
const rate = (bp: number | null) => (bp == null ? '' : `${bp / 100}%`);

/** A sheet of rows: bold frozen header, filters, and money columns as rupees. */
function table(wb: ExcelJS.Workbook, name: string, columns: Column[], rows: Record<string, unknown>[], note?: string) {
  const ws = wb.addWorksheet(name);
  let top = 1;
  if (note) {
    ws.getCell('A1').value = note;
    ws.getCell('A1').font = { italic: true, color: { argb: 'FF57534E' } };
    top = 3;
  }
  const head = ws.getRow(top);
  columns.forEach((c, i) => {
    head.getCell(i + 1).value = c.header;
    ws.getColumn(i + 1).width = c.width ?? Math.max(12, c.header.length + 2);
    if (c.money) ws.getColumn(i + 1).numFmt = '#,##0.00';
  });
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F4' } };
  for (const r of rows) ws.addRow(columns.map((c) => r[c.key] ?? null));
  ws.views = [{ state: 'frozen', ySplit: top }];
  if (rows.length) ws.autoFilter = { from: { row: top, column: 1 }, to: { row: top + rows.length, column: columns.length } };
  if (!rows.length) ws.addRow(['Nothing in this period']);
  return ws;
}

const ORDER_TYPE: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', counter: 'Counter', delivery: 'Delivery', membership: 'Membership' };

export async function monthPack(tx: Tx, r: Range, opts: { month: string; toDate: boolean }): Promise<Buffer> {
  const outlet = await tx.db.selectFrom('outlets').select(['name', 'legal_name', 'gstin', 'address', 'city']).where('id', '=', r.outletId).executeTakeFirstOrThrow();
  const sales = await salesSummary(tx, r);
  const gst = await gstReport(tx, r);
  const day = await dayEnd(tx, r);
  const comps = await compReport(tx, r);
  const local = (col: string) => sql<string>`to_char(${sql.ref(col)} at time zone ${r.timezone}, 'YYYY-MM-DD HH24:MI')`;

  const invoices = await tx.db
    .selectFrom('bills')
    .leftJoin('orders', 'orders.id', 'bills.order_id')
    .select([
      'bills.invoice_no',
      'bills.invoice_date',
      'bills.invoice_series',
      'bills.status',
      'bills.customer_name',
      'bills.customer_gstin',
      'bills.subtotal_paise',
      'bills.service_charge_paise',
      'bills.taxable_paise',
      'bills.cgst_paise',
      'bills.sgst_paise',
      'bills.round_off_paise',
      'bills.total_paise',
      'bills.paid_paise',
      'bills.tax_by_operator',
      'bills.void_reason',
      'orders.channel',
      sql<number>`bills.item_discount_paise + bills.bill_discount_paise + bills.loyalty_discount_paise`.as('discount_paise'),
      sql<string>`case when bills.membership_id is not null then 'membership' when bills.table_session_id is not null then 'dine_in' else coalesce(orders.type, 'counter') end`.as('type'),
    ])
    .where('bills.outlet_id', '=', r.outletId)
    .where('bills.invoice_no', 'is not', null)
    .where('bills.invoice_date', '>=', r.from)
    .where('bills.invoice_date', '<=', r.to)
    .orderBy('bills.fy_code')
    .orderBy('bills.invoice_series')
    .orderBy('bills.invoice_seq')
    .execute();

  const payments = await tx.db
    .selectFrom('payments')
    .leftJoin('bills', 'bills.id', 'payments.bill_id')
    .leftJoin('users', 'users.id', 'payments.confirmed_by')
    .select([local('payments.created_at').as('at'), 'bills.invoice_no', 'payments.wallet_topup_id', 'payments.method', 'payments.kind', 'payments.amount_paise', 'payments.reference', 'payments.reason', 'payments.room_no', 'users.name as confirmed_by'])
    .where('payments.outlet_id', '=', r.outletId)
    .where(sql<string>`(payments.created_at at time zone ${r.timezone})::date`, '>=', r.from)
    .where(sql<string>`(payments.created_at at time zone ${r.timezone})::date`, '<=', r.to)
    .orderBy('payments.created_at')
    .execute();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mezmitra';
  wb.created = new Date();

  // ------------------------------------------------------------------ Read me
  const readme = wb.addWorksheet('Read me');
  readme.getColumn(1).width = 28;
  readme.getColumn(2).width = 110;
  const line = (a: string, b = '', bold = false) => {
    const row = readme.addRow([a, b]);
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(1).alignment = { vertical: 'top' };
    if (bold) row.font = { bold: true };
  };
  readme.addRow([`Month-end pack: ${outlet.legal_name || outlet.name}`]).font = { bold: true, size: 14 };
  line('Outlet', [outlet.name, outlet.address, outlet.city].filter(Boolean).join(', '));
  if (outlet.gstin) line('GSTIN', outlet.gstin);
  line('Period', `${r.from} to ${r.to}${opts.toDate ? ' (month to date)' : ''}`);
  line('Made', new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: r.timezone }).format(new Date()));
  readme.addRow([]);
  line('How the dates work', '', true);
  for (const rule of REPORT_DATE_RULES) line('', rule);
  readme.addRow([]);
  line('What each figure means', '', true);
  for (const term of Object.values(REPORT_TERMS)) line(term.label, term.means);
  readme.addRow([]);
  line('Sheets', '', true);
  line('', 'Summary, Sales by day, GST by rate, HSN summary, Invoices, B2B invoices, Delivery apps 9(5), Payments, Wallet top-ups, Free items, Discounts, Voids, Refunds.');

  // ------------------------------------------------------------------ Summary
  const t = sales.totals;
  table(
    wb,
    'Summary',
    [
      { header: 'Figure', key: 'k', width: 34 },
      { header: 'Amount (₹)', key: 'v', width: 16, money: true },
      { header: 'Count', key: 'c', width: 10 },
    ],
    [
      { k: REPORT_TERMS.gross.label, v: inr(t.gross_paise) },
      { k: REPORT_TERMS.given_free.label, v: inr(-t.complimentary_paise) },
      { k: REPORT_TERMS.discounts.label, v: inr(-t.discount_paise) },
      { k: '   of which loyalty and members', v: inr(-t.loyalty_discount_paise) },
      { k: REPORT_TERMS.service_charge.label, v: inr(t.service_charge_paise) },
      { k: REPORT_TERMS.taxable.label, v: inr(t.taxable_paise) },
      { k: 'CGST', v: inr(t.cgst_paise) },
      { k: 'SGST', v: inr(t.sgst_paise) },
      { k: REPORT_TERMS.round_off.label, v: inr(t.round_off_paise) },
      { k: REPORT_TERMS.net_sales.label, v: inr(t.net_paise), c: t.bills },
      { k: REPORT_TERMS.average_bill.label, v: inr(t.average_bill_paise) },
      { k: REPORT_TERMS.still_unpaid.label, v: inr(t.outstanding_paise) },
      { k: REPORT_TERMS.voids.label, v: inr(sales.voids.amount_paise), c: sales.voids.count },
      // The free-items sheet follows the order day, so it also counts dishes on bills not yet invoiced.
      { k: 'Free dishes logged, by order day', v: inr(comps.totals.value_paise), c: comps.totals.items },
      { k: `   ${REPORT_TERMS.free_cost.label}`, v: inr(comps.totals.cost_paise) },
      ...sales.payments.map((p) => ({ k: `Payments: ${p.method.replace('_', ' ')}`, v: inr(p.net_paise), c: p.count })),
      ...sales.wallet_topups.map((p) => ({ k: `Wallet top-ups: ${p.method.replace('_', ' ')}`, v: inr(p.net_paise), c: p.count })),
      ...gst.operator_supplies.map((o) => ({ k: `Delivery app pays GST: ${o.channel}`, v: inr(o.value_paise), c: o.bills })),
    ],
  );

  table(
    wb,
    'Sales by day',
    [
      { header: 'Invoice date', key: 'date', width: 14 },
      { header: 'Bills', key: 'bills' },
      { header: 'Net sales (₹)', key: 'net', width: 16, money: true },
    ],
    sales.by_day.map((d) => ({ date: d.date, bills: d.bills, net: inr(d.net_paise) })),
  );

  table(
    wb,
    'GST by rate',
    [
      { header: 'On', key: 'kind', width: 18 },
      { header: 'Rate', key: 'rate' },
      { header: 'Taxable (₹)', key: 'taxable', width: 16, money: true },
      { header: 'CGST (₹)', key: 'cgst', width: 14, money: true },
      { header: 'SGST (₹)', key: 'sgst', width: 14, money: true },
      { header: 'Total tax (₹)', key: 'tax', width: 14, money: true },
    ],
    gst.by_rate.map((x) => ({ kind: x.kind === 'service_charge' ? 'Service charge' : 'Food and drinks', rate: rate(x.tax_rate_bp), taxable: inr(x.taxable_paise), cgst: inr(x.cgst_paise), sgst: inr(x.sgst_paise), tax: inr(x.cgst_paise + x.sgst_paise) })),
    REPORT_TERMS.gst.means,
  );

  table(
    wb,
    'HSN summary',
    [
      { header: 'HSN/SAC', key: 'hsn' },
      { header: 'Rate', key: 'rate' },
      { header: 'Quantity', key: 'qty' },
      { header: 'Taxable (₹)', key: 'taxable', width: 16, money: true },
      { header: 'Tax (₹)', key: 'tax', width: 14, money: true },
    ],
    gst.hsn_summary.map((h) => ({ hsn: h.hsn_sac ?? '(none set)', rate: rate(h.tax_rate_bp), qty: h.qty, taxable: inr(h.taxable_paise), tax: inr(h.tax_paise) })),
    REPORT_TERMS.hsn.means,
  );

  table(
    wb,
    'Invoices',
    [
      { header: 'Invoice', key: 'no', width: 20 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Series', key: 'series' },
      { header: 'Status', key: 'status' },
      { header: 'Type', key: 'type' },
      { header: 'Customer', key: 'customer', width: 20 },
      { header: 'GSTIN', key: 'gstin', width: 18 },
      { header: 'Gross (₹)', key: 'gross', money: true },
      { header: 'Discounts (₹)', key: 'discount', money: true },
      { header: 'Service charge (₹)', key: 'sc', money: true },
      { header: 'Taxable (₹)', key: 'taxable', money: true },
      { header: 'CGST (₹)', key: 'cgst', money: true },
      { header: 'SGST (₹)', key: 'sgst', money: true },
      { header: 'Round off (₹)', key: 'round', money: true },
      { header: 'Total (₹)', key: 'total', money: true },
      { header: 'Paid (₹)', key: 'paid', money: true },
      { header: 'Notes', key: 'notes', width: 30 },
    ],
    invoices.map((i) => ({
      no: i.invoice_no,
      date: i.invoice_date,
      series: i.invoice_series === 'hub' ? 'Outage (hub)' : 'Main',
      status: i.status === 'void' ? 'Voided' : i.status === 'paid' ? 'Paid' : 'Unpaid',
      type: i.channel ? `Delivery (${i.channel})` : (ORDER_TYPE[i.type] ?? i.type),
      customer: i.customer_name,
      gstin: i.customer_gstin,
      gross: inr(i.subtotal_paise),
      discount: inr(i.discount_paise),
      sc: inr(i.service_charge_paise),
      taxable: inr(i.taxable_paise),
      cgst: inr(i.cgst_paise),
      sgst: inr(i.sgst_paise),
      round: inr(i.round_off_paise),
      total: inr(i.total_paise),
      paid: inr(i.paid_paise),
      notes: [i.status === 'void' ? `Voided: ${i.void_reason ?? 'no reason'}` : '', i.tax_by_operator ? 'GST paid by the delivery app (9(5))' : ''].filter(Boolean).join('; ') || null,
    })),
  );

  table(
    wb,
    'B2B invoices',
    [
      { header: 'Invoice', key: 'no', width: 20 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Customer', key: 'customer', width: 24 },
      { header: 'GSTIN', key: 'gstin', width: 18 },
      { header: 'Taxable (₹)', key: 'taxable', money: true },
      { header: 'Tax (₹)', key: 'tax', money: true },
      { header: 'Total (₹)', key: 'total', money: true },
    ],
    gst.b2b.map((b) => ({ no: b.invoice_no, date: b.invoice_date, customer: b.customer_name, gstin: b.customer_gstin, taxable: inr(b.taxable_paise), tax: inr(b.tax_paise), total: inr(b.total_paise) })),
    REPORT_TERMS.b2b.means,
  );

  table(
    wb,
    'Delivery apps 9(5)',
    [
      { header: 'App', key: 'channel' },
      { header: 'Bills', key: 'bills' },
      { header: 'Value (₹)', key: 'value', width: 16, money: true },
    ],
    gst.operator_supplies.map((o) => ({ channel: o.channel, bills: o.bills, value: inr(o.value_paise) })),
    REPORT_TERMS.operator.means,
  );

  const paymentColumns: Column[] = [
    { header: 'When', key: 'at', width: 18 },
    { header: 'Invoice', key: 'invoice', width: 20 },
    { header: 'Method', key: 'method' },
    { header: 'Kind', key: 'kind' },
    { header: 'Amount (₹)', key: 'amount', width: 14, money: true },
    { header: 'Reference', key: 'reference', width: 22 },
    { header: 'Room', key: 'room' },
    { header: 'Confirmed by', key: 'by', width: 18 },
    { header: 'Reason', key: 'reason', width: 24 },
  ];
  const paymentRow = (p: (typeof payments)[number]) => ({
    at: p.at,
    invoice: p.invoice_no,
    method: p.method.replace('_', ' '),
    kind: p.kind === 'refund' ? 'Refund' : 'Payment',
    amount: inr(p.kind === 'refund' ? -p.amount_paise : p.amount_paise),
    reference: p.reference,
    room: p.room_no,
    by: p.confirmed_by,
    reason: p.reason,
  });
  table(wb, 'Payments', paymentColumns, payments.filter((p) => !p.wallet_topup_id).map(paymentRow), REPORT_TERMS.payments.means);
  table(wb, 'Wallet top-ups', paymentColumns.filter((c) => c.key !== 'invoice' && c.key !== 'room'), payments.filter((p) => p.wallet_topup_id).map(paymentRow), REPORT_TERMS.wallet_topups.means);

  table(
    wb,
    'Free items',
    [
      { header: 'When', key: 'at', width: 18 },
      { header: 'Dish', key: 'item', width: 24 },
      { header: 'Qty', key: 'qty' },
      { header: 'Value (₹)', key: 'value', money: true },
      { header: 'Cost (₹)', key: 'cost', money: true },
      { header: 'Reason', key: 'reason', width: 20 },
      { header: 'Note', key: 'note', width: 24 },
      { header: 'Given by', key: 'by', width: 16 },
      { header: 'Approved by', key: 'approved', width: 16 },
      { header: 'Invoice', key: 'invoice', width: 20 },
      { header: 'Undone', key: 'undone' },
    ],
    comps.rows.map((c) => ({
      at: new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23', timeZone: r.timezone }).format(new Date(c.created_at)).replace(',', ''),
      item: c.item_name,
      qty: c.qty,
      value: inr(c.value_paise),
      cost: inr(c.cost_paise),
      reason: COMP_REASON[c.reason] ?? c.reason,
      note: c.note,
      by: c.given_by,
      approved: c.approved_by,
      invoice: c.invoice_no,
      undone: c.removed_at ? 'Yes' : null,
    })),
    REPORT_TERMS.given_free.means,
  );

  table(
    wb,
    'Discounts',
    [
      { header: 'Invoice', key: 'no', width: 20 },
      { header: 'Amount (₹)', key: 'amount', money: true },
      { header: 'Reason', key: 'reason', width: 30 },
    ],
    day.discounts.map((d) => ({ no: d.invoice_no, amount: inr(d.discount_paise), reason: d.reason })),
    REPORT_TERMS.discounts.means,
  );

  table(
    wb,
    'Voids',
    [
      { header: 'Invoice', key: 'no', width: 20 },
      { header: 'Amount (₹)', key: 'amount', money: true },
      { header: 'Reason', key: 'reason', width: 30 },
      { header: 'Voided by', key: 'by', width: 18 },
    ],
    day.voids.map((v) => ({ no: v.invoice_no, amount: inr(v.total_paise), reason: v.reason, by: v.voided_by })),
    REPORT_TERMS.voids.means,
  );

  table(
    wb,
    'Refunds',
    [
      { header: 'Invoice', key: 'no', width: 20 },
      { header: 'Method', key: 'method' },
      { header: 'Amount (₹)', key: 'amount', money: true },
      { header: 'Reason', key: 'reason', width: 30 },
    ],
    day.refunds.map((x) => ({ no: x.invoice_no, method: x.method.replace('_', ' '), amount: inr(x.amount_paise), reason: x.reason })),
    REPORT_TERMS.refunds.means,
  );

  return Buffer.from(await wb.xlsx.writeBuffer());
}
