import type { BillDoc, KotDoc, PrintDoc, TestDoc } from '@mezmitra/shared/print';
import { columns, EscPos, wrap } from './escpos';

const money = (paise: number) => (paise / 100).toFixed(2);
const pct = (bp: number) => `${Number((bp / 100).toFixed(2))}%`;

function stamp(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

const ORDER_TYPE: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', counter: 'Counter' };

export function renderKot(doc: KotDoc, width: number): EscPos {
  const p = new EscPos().init();
  const rule = '-'.repeat(width);
  p.align('center');
  if (doc.cancelled) p.bold(true).size(2, 2).line('CANCELLED').size(1, 1).bold(false);
  if (doc.reprint) p.line('** REPRINT **');
  p.bold(true).size(2, 2).line(`KOT ${doc.kot_no}`).size(1, 1).bold(false);
  p.line(doc.station.toUpperCase());
  p.align('left');
  const where = doc.table_label ? `Table ${doc.table_label}` : ORDER_TYPE[doc.order_type] ?? doc.order_type;
  p.bold(true).line(columns(where, `Order #${doc.order_no}`, width)).bold(false);
  p.line(columns(ORDER_TYPE[doc.order_type] ?? '', stamp(doc.placed_at), width));
  p.line(rule);
  for (const item of doc.items) {
    const seat = item.seat_no ? ` (seat ${item.seat_no})` : '';
    p.bold(true).size(1, 2);
    for (const l of wrap(`${item.qty} x ${item.name}${seat}`, width, '    ')) p.line(l);
    p.size(1, 1).bold(false);
    if (item.modifiers.length) for (const l of wrap(`+ ${item.modifiers.join(', ')}`, width - 4, '    ')) p.line(`    ${l}`);
    if (item.note) for (const l of wrap(`! ${item.note}`, width - 4, '    ')) p.line(`    ${l}`);
  }
  p.line(rule);
  if (doc.note) for (const l of wrap(`Note: ${doc.note}`, width)) p.line(l);
  return p.feed(3).cut();
}

/** What the printer needs besides the document: the site's address, for links on receipts. */
export interface RenderOptions {
  webOrigin?: string | null;
}

export function renderBill(doc: BillDoc, width: number, opts: RenderOptions = {}): EscPos {
  const { bill, outlet, tax_summary } = doc.invoice;
  const p = new EscPos().init();
  const rule = '-'.repeat(width);
  p.align('center').bold(true).size(1, 2).line(outlet.name).size(1, 1).bold(false);
  if (outlet.legal_name && outlet.legal_name !== outlet.name) p.line(outlet.legal_name);
  if (outlet.address) for (const l of wrap(outlet.address, width)) p.line(l);
  if (outlet.phone) p.line(`Ph: ${outlet.phone}`);
  if (outlet.gstin) p.line(`GSTIN: ${outlet.gstin}`);
  if (outlet.fssai_no) p.line(`FSSAI: ${outlet.fssai_no}`);
  p.feed(1).bold(true).line(doc.duplicate ? 'TAX INVOICE (DUPLICATE)' : 'TAX INVOICE').bold(false);
  // Counter and takeaway: the number the guest listens for, big enough to read across the counter.
  if (doc.pickup_no != null) p.feed(1).bold(true).size(2, 2).line(`ORDER ${doc.pickup_no}`).size(1, 1).bold(false);
  p.align('left');
  p.line(columns(`Inv: ${bill.invoice_no ?? 'DRAFT'}`, bill.invoice_date ?? '', width));
  if (bill.table_label) p.line(`Table: ${bill.table_label}${bill.split_label ? `  (${bill.split_label})` : ''}`);
  const customer = bill.customer_name ?? bill.customer?.name;
  if (customer) p.line(`Customer: ${customer}`);
  if (bill.customer_gstin) p.line(`Customer GSTIN: ${bill.customer_gstin}`);
  p.line(rule);
  const amtW = 10;
  const qtyW = 4;
  const nameW = width - amtW - qtyW;
  p.bold(true).line(`${'Item'.padEnd(nameW)}${'Qty'.padStart(qtyW)}${'Amount'.padStart(amtW)}`).bold(false);
  for (const l of bill.lines) {
    const [first, ...rest] = wrap(l.name, nameW - 1);
    p.line(`${(first ?? '').padEnd(nameW)}${String(l.qty).padStart(qtyW)}${money(l.gross_paise).padStart(amtW)}`);
    for (const r of rest) p.line(`  ${r}`);
    if (l.comp_qty) p.line(`  Complimentary${l.comp_qty < l.qty ? ` (${l.comp_qty} of ${l.qty})` : ''}`);
    if (l.hsn_sac) p.line(`  HSN/SAC ${l.hsn_sac} @ ${money(l.unit_price_paise)}`);
  }
  p.line(rule);
  p.line(columns('Subtotal', money(bill.subtotal_paise), width));
  // Free dishes are part of the item discount; they are shown on their own line.
  const free = bill.comp_paise ?? 0;
  if (free) p.line(columns('Complimentary', `-${money(free)}`, width));
  const discount = bill.item_discount_paise + bill.bill_discount_paise - free;
  if (discount) p.line(columns('Discount', `-${money(discount)}`, width));
  // Loyalty money off is points redeemed plus rewards; each has its own line.
  const rewardOff = bill.reward_discount_paise ?? 0;
  const memberOff = bill.member_discount_paise ?? 0;
  const pointsOff = bill.loyalty_discount_paise - rewardOff - memberOff;
  if (memberOff) p.line(columns('Member discount', `-${money(memberOff)}`, width));
  if (pointsOff) p.line(columns(`Points redeemed (${bill.loyalty_points_redeemed})`, `-${money(pointsOff)}`, width));
  if (rewardOff) p.line(columns('Loyalty reward', `-${money(rewardOff)}`, width));
  if (bill.service_charge_paise) p.line(columns(`Service charge (${pct(bill.service_charge_bp)})`, money(bill.service_charge_paise), width));
  for (const t of tax_summary) {
    const half = pct(t.tax_rate_bp / 2);
    p.line(columns(`CGST ${half} on ${money(t.taxable_paise)}`, money(t.cgst_paise), width));
    p.line(columns(`SGST ${half} on ${money(t.taxable_paise)}`, money(t.sgst_paise), width));
  }
  if (bill.tax_by_operator) {
    p.line('GST paid by the e-commerce operator');
    p.line('under section 9(5), CGST Act');
  }
  if (bill.round_off_paise) p.line(columns('Round off', money(bill.round_off_paise), width));
  p.line(rule);
  p.bold(true).size(1, 2).line(columns('TOTAL', `Rs. ${money(bill.total_paise)}`, width)).size(1, 1).bold(false);
  for (const pay of bill.payments) {
    const how = pay.method === 'room' ? `room ${pay.room_no ?? ''}`.trim() : pay.method === 'platform' ? 'via delivery app' : pay.method.replace('_', ' ');
    const label = pay.kind === 'refund' ? `Refund (${how})` : pay.method === 'room' ? `Charged to ${how}` : `Paid ${how}`;
    p.line(columns(label, money(pay.amount_paise), width));
  }
  if (bill.balance_paise > 0 && bill.payments.length) p.bold(true).line(columns('Balance due', money(bill.balance_paise), width)).bold(false);
  if (bill.amount_shares && bill.balance_paise > 0) {
    p.line(`Split ${bill.amount_shares.length} ways: ${bill.amount_shares.map(money).join(' / ')}`);
  }
  if (doc.upi_uri && bill.balance_paise > 0) {
    p.feed(1).align('center').line('Scan to pay with any UPI app').qr(doc.upi_uri, 6).align('left');
  }
  if (bill.loyalty_points_earned) p.line(`Points earned on this bill: ${bill.loyalty_points_earned}`);
  if (doc.track_code && opts.webOrigin) {
    p.feed(1).align('center').line('Scan to see when your order is ready').qr(`${opts.webOrigin}/o/${doc.track_code}`, 5).align('left');
  }
  p.feed(1).align('center').line('Thank you. Visit again!');
  return p.feed(3).cut();
}

export function renderTest(doc: TestDoc, width: number): EscPos {
  const p = new EscPos().init().align('center');
  p.bold(true).line('Mezmitra printer test').bold(false);
  p.line(doc.outlet_name);
  p.line(`Target: ${doc.target}`);
  p.line(stamp(doc.at));
  p.line('-'.repeat(width));
  p.line('If you can read this, printing works.');
  return p.feed(3).cut();
}

export function render(doc: PrintDoc, width: number, opts: RenderOptions = {}): EscPos {
  switch (doc.kind) {
    case 'kot':
      return renderKot(doc, width);
    case 'bill':
      return renderBill(doc, width, opts);
    case 'test':
      return renderTest(doc, width);
    case 'drawer':
      return new EscPos().init().drawer();
  }
}
