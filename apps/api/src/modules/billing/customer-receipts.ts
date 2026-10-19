import PDFDocument from 'pdfkit';
import type { InvoiceDTO } from '@mezmitra/shared/dto';
import type { FastifyReply } from 'fastify';
import type { Tx } from '../../context';
import { notFound } from '../../lib/errors';
import { loadInvoice } from './serialize';

/** Only receipt information: never expose the customer's account or staff/payment references. */
export function customerInvoice(invoice: InvoiceDTO): InvoiceDTO & { upi_uri: null } {
  const bill = invoice.bill;
  return { ...invoice, upi_uri: null, bill: { ...bill,
    customer: null, membership: null, customer_name: null, customer_gstin: null,
    discount_reason: null, void_reason: null, rewards: [],
    lines: bill.lines.map((line) => ({ ...line, order_item_id: null, comps: [] })),
    payments: bill.payments.map((payment) => ({ ...payment, reference: null, confirmed_by_name: null,
      room_no: null, room_guest: null, room_posted_at: null, room_rejected_at: null, room_reject_reason: null })),
  } };
}

/** Uses persisted invoice amounts; no pricing or tax recalculation. Long bills paginate. */
export function receiptPdf(invoice: InvoiceDTO): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${invoice.bill.invoice_no ?? ''}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const money = (amount: number) => (amount / 100).toFixed(2);
    const text = (value: string, bold = false) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(value).moveDown(0.35); };
    const row = (label: string, amount: number) => text(`${label}: Rs. ${money(amount)}`);
    const { bill, outlet } = invoice;
    text(outlet.name, true);
    for (const value of [outlet.legal_name, outlet.address, outlet.phone && `Ph: ${outlet.phone}`, outlet.gstin && `GSTIN: ${outlet.gstin}`, outlet.fssai_no && `FSSAI: ${outlet.fssai_no}`]) if (value) text(value);
    text(`TAX INVOICE ${bill.invoice_no ?? ''}`, true);
    text(bill.invoice_date ?? '');
    if (bill.table_label) text(`Table ${bill.table_label} ${bill.split_label ?? ''}`);
    if (bill.pickup_no != null) text(`Order ${bill.pickup_no}`);
    doc.moveDown();
    for (const line of bill.lines) {
      text(`${line.name} — ${line.qty} x ${money(line.unit_price_paise)} = ${money(line.gross_paise)}`);
      if (line.hsn_sac) text(`HSN/SAC ${line.hsn_sac}`);
      if (line.comp_qty) text(`Complimentary: ${line.comp_qty}`);
    }
    doc.moveDown();
    row('Subtotal', bill.subtotal_paise);
    if (bill.comp_paise) row('Complimentary', -bill.comp_paise);
    const discount = bill.item_discount_paise + bill.bill_discount_paise - bill.comp_paise;
    if (discount) row('Discount', -discount);
    if (bill.member_discount_paise) row('Member discount', -bill.member_discount_paise);
    const points = bill.loyalty_discount_paise - bill.reward_discount_paise - bill.member_discount_paise;
    if (points) row(`Points redeemed (${bill.loyalty_points_redeemed})`, -points);
    if (bill.reward_discount_paise) row('Loyalty reward', -bill.reward_discount_paise);
    if (bill.service_charge_paise) row(`Service charge (${bill.service_charge_bp / 100}%)`, bill.service_charge_paise);
    for (const tax of invoice.tax_summary) {
      row(`CGST ${tax.tax_rate_bp / 200}% on ${money(tax.taxable_paise)}`, tax.cgst_paise);
      row(`SGST ${tax.tax_rate_bp / 200}% on ${money(tax.taxable_paise)}`, tax.sgst_paise);
    }
    if (bill.tax_by_operator) text('GST paid by the e-commerce operator under section 9(5), CGST Act');
    if (bill.round_off_paise) row('Round off', bill.round_off_paise);
    text(`TOTAL: Rs. ${money(bill.total_paise)}`, true);
    for (const payment of bill.payments) row(`${payment.kind === 'refund' ? 'Refund' : 'Paid'} (${payment.method})`, payment.amount_paise);
    if (bill.balance_paise > 0) row('Balance due', bill.balance_paise);
    text('Thank you. Visit again!');
    doc.end();
  });
}

/** IDs must come from a query scoped to the authenticated visit or secret order link. */
export async function serveCustomerReceipts(tx: Tx, ids: string[], query: { format?: 'pdf'; bill_id?: string }, reply: FastifyReply) {
  reply.header('cache-control', 'private, no-store');
  if (query.format === 'pdf') {
    if (!query.bill_id || !ids.includes(query.bill_id)) throw notFound('Receipt');
    const invoice = await loadInvoice(tx, query.bill_id);
    if (!invoice) throw notFound('Receipt');
    const safe = customerInvoice(invoice);
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `attachment; filename="bill-${query.bill_id}.pdf"`);
    return reply.send(await receiptPdf(safe));
  }
  return Promise.all(ids.map(async (id) => customerInvoice((await loadInvoice(tx, id))!)));
}
