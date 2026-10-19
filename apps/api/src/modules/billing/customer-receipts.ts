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

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const FILL = '#f3f4f6';
const DUE = '#b91c1c';

/** Indian digit grouping: 1,23,456.00. Display only; every amount is the saved paise value. */
const money = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const METHOD: Record<string, string> = { cash: 'cash', upi: 'UPI', card_slip: 'card', other: 'other', room: 'room charge', platform: 'delivery app' };
const rate = (bp: number) => `${bp / 100}%`;

/**
 * The tax invoice as a printable A4 page: outlet header, invoice details, an item table that
 * repeats its heading on every page, the GST breakdown, and totals. It uses the amounts saved on
 * the bill and recalculates nothing, so the PDF always agrees with the bill on screen.
 */
export function receiptPdf(invoice: InvoiceDTO): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { bill, outlet } = invoice;
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Invoice ${bill.invoice_no ?? ''}`, Author: outlet.legal_name ?? outlet.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const M = 40;
    const W = doc.page.width - M * 2;
    const BOTTOM = doc.page.height - M - 28; // room left for the page footer
    let y = M;

    const put = (value: string, x: number, at: number, width: number, o: { size?: number; bold?: boolean; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
      doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 10).fillColor(o.color ?? INK).text(value, x, at, { width, align: o.align ?? 'left', lineBreak: false });
    };
    const height = (value: string, width: number, size: number, bold = false) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).heightOfString(value, { width });
    const hline = (at: number, color = RULE, weight = 0.5) => doc.save().moveTo(M, at).lineTo(M + W, at).lineWidth(weight).strokeColor(color).stroke().restore();
    const ensure = (needed: number, redraw?: () => void) => {
      if (y + needed <= BOTTOM) return;
      doc.addPage();
      y = M;
      redraw?.();
    };

    // ---------------------------------------------------------------- header: who is billing
    const leftW = W * 0.6;
    let ly = y;
    const block = (value: string | null | undefined, size: number, bold: boolean, color = INK, gap = 2) => {
      if (!value) return;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(value, M, ly, { width: leftW });
      ly = doc.y + gap;
    };
    block(outlet.name, 17, true, INK, 3);
    if (outlet.legal_name && outlet.legal_name !== outlet.name) block(outlet.legal_name, 10, false, INK);
    block(outlet.address, 9, false, MUTED);
    block(outlet.phone && `Ph: ${outlet.phone}`, 9, false, MUTED);
    block([outlet.gstin && `GSTIN: ${outlet.gstin}`, outlet.fssai_no && `FSSAI: ${outlet.fssai_no}`].filter(Boolean).join('   |   '), 9, false, MUTED);

    const rightX = M + leftW;
    const rightW = W - leftW;
    put('TAX INVOICE', rightX, y, rightW, { size: 15, bold: true, align: 'right' });
    put(bill.invoice_no ?? 'Draft', rightX, y + 22, rightW, { size: 11, bold: true, align: 'right', color: MUTED });
    y = Math.max(ly, y + 40) + 8;
    hline(y, INK, 1.2);
    y += 10;

    // ---------------------------------------------------------------- invoice details
    const cells: [string, string][] = [['Invoice date', bill.invoice_date ?? '-']];
    if (bill.table_label) cells.push(['Table', `${bill.table_label}${bill.split_label ? ` ${bill.split_label}` : ''}`]);
    if (bill.pickup_no != null) cells.push(['Order', String(bill.pickup_no)]);
    if (bill.customer_name) cells.push(['Billed to', bill.customer_name]);
    if (bill.customer_gstin) cells.push(['Customer GSTIN', bill.customer_gstin]);
    const cw = W / cells.length;
    cells.forEach(([label, value], i) => {
      put(label.toUpperCase(), M + i * cw, y, cw - 8, { size: 7.5, bold: true, color: MUTED });
      put(value, M + i * cw, y + 11, cw - 8, { size: 10.5, bold: true });
    });
    y += 34;
    hline(y);
    y += 12;

    // ---------------------------------------------------------------- items
    const col = { n: 24, hsn: 58, qty: 36, rate: 66, amt: 74 };
    const descW = W - (col.n + col.hsn + col.qty + col.rate + col.amt);
    const x = { n: M, desc: M + col.n, hsn: M + col.n + descW, qty: M + col.n + descW + col.hsn, rate: M + col.n + descW + col.hsn + col.qty, amt: M + col.n + descW + col.hsn + col.qty + col.rate };
    const itemHead = () => {
      doc.save().rect(M, y, W, 20).fill(FILL).restore();
      const o = { size: 8, bold: true, color: MUTED } as const;
      put('#', x.n + 4, y + 6, col.n - 4, o);
      put('ITEM', x.desc, y + 6, descW, o);
      put('HSN/SAC', x.hsn, y + 6, col.hsn, o);
      put('QTY', x.qty, y + 6, col.qty - 4, { ...o, align: 'right' });
      put('RATE', x.rate, y + 6, col.rate - 4, { ...o, align: 'right' });
      put('AMOUNT', x.amt, y + 6, col.amt - 4, { ...o, align: 'right' });
      y += 20;
    };
    itemHead();
    bill.lines.forEach((line, i) => {
      const note = line.comp_qty ? `Complimentary: ${line.comp_qty}` : '';
      const nameH = height(line.name, descW - 8, 10, true);
      const rowH = Math.max(22, nameH + (note ? 11 : 0) + 10);
      ensure(rowH, itemHead);
      put(String(i + 1), x.n + 4, y + 6, col.n - 4, { size: 9, color: MUTED });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(line.name, x.desc, y + 5, { width: descW - 8 });
      if (note) put(note, x.desc, y + 5 + nameH, descW - 8, { size: 8, color: MUTED });
      put(line.hsn_sac ?? '', x.hsn, y + 6, col.hsn - 4, { size: 9, color: MUTED });
      put(String(line.qty), x.qty, y + 6, col.qty - 4, { align: 'right' });
      put(money(line.unit_price_paise), x.rate, y + 6, col.rate - 4, { align: 'right' });
      put(money(line.gross_paise), x.amt, y + 6, col.amt - 4, { align: 'right', bold: true });
      y += rowH;
      hline(y);
    });
    y += 14;

    // ---------------------------------------------------------------- GST breakdown
    if (invoice.tax_summary.length) {
      const widths = [0.16, 0.24, 0.2, 0.2, 0.2].map((f) => f * W);
      const at = widths.reduce<number[]>((acc, w, i) => [...acc, (acc[i] ?? M) + w], [M]);
      const head = () => {
        doc.save().rect(M, y, W, 18).fill(FILL).restore();
        ['GST RATE', 'TAXABLE VALUE', 'CGST', 'SGST', 'TOTAL TAX'].forEach((label, i) => put(label, at[i]!, y + 5, widths[i]! - (i ? 6 : 0), { size: 8, bold: true, color: MUTED, align: i ? 'right' : 'left' }));
        y += 18;
      };
      ensure(18 + invoice.tax_summary.length * 18 + 10);
      head();
      for (const tax of invoice.tax_summary) {
        ensure(18, head);
        const cells2 = [rate(tax.tax_rate_bp), money(tax.taxable_paise), money(tax.cgst_paise), money(tax.sgst_paise), money(tax.cgst_paise + tax.sgst_paise)];
        cells2.forEach((value, i) => put(value, at[i]!, y + 5, widths[i]! - (i ? 6 : 0), { size: 9, align: i ? 'right' : 'left' }));
        y += 18;
        hline(y);
      }
      y += 14;
    }
    if (bill.tax_by_operator) {
      const note = 'GST on this supply is paid by the e-commerce operator under section 9(5) of the CGST Act.';
      ensure(height(note, W, 8.5) + 12);
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(note, M, y, { width: W });
      y = doc.y + 12;
    }

    // ---------------------------------------------------------------- totals
    const lines: [string, number][] = [['Subtotal', bill.subtotal_paise]];
    if (bill.comp_paise) lines.push(['Complimentary', -bill.comp_paise]);
    const discount = bill.item_discount_paise + bill.bill_discount_paise - bill.comp_paise;
    if (discount) lines.push(['Discount', -discount]);
    if (bill.member_discount_paise) lines.push(['Member discount', -bill.member_discount_paise]);
    const points = bill.loyalty_discount_paise - bill.reward_discount_paise - bill.member_discount_paise;
    if (points) lines.push([`Points redeemed (${bill.loyalty_points_redeemed})`, -points]);
    if (bill.reward_discount_paise) lines.push(['Loyalty reward', -bill.reward_discount_paise]);
    if (bill.service_charge_paise) lines.push([`Service charge (${rate(bill.service_charge_bp)})`, bill.service_charge_paise]);
    const cgst = invoice.tax_summary.reduce((a, t) => a + t.cgst_paise, 0);
    const sgst = invoice.tax_summary.reduce((a, t) => a + t.sgst_paise, 0);
    if (invoice.tax_summary.length) lines.push(['CGST', cgst], ['SGST', sgst]);
    if (bill.round_off_paise) lines.push(['Round off', bill.round_off_paise]);
    const paid = bill.payments.map((p): [string, number] => [`${p.kind === 'refund' ? 'Refunded' : 'Paid'} by ${METHOD[p.method] ?? p.method}`, p.amount_paise]);

    const boxW = 250;
    const bx = M + W - boxW;
    ensure(lines.length * 17 + 34 + paid.length * 17 + (bill.balance_paise > 0 ? 22 : 0) + 8);
    for (const [label, amount] of lines) {
      put(label, bx, y, boxW - 90, { size: 10, color: MUTED });
      put(money(amount), bx + boxW - 90, y, 90, { align: 'right' });
      y += 17;
    }
    y += 4;
    doc.save().rect(bx, y, boxW, 28).fill(INK).restore();
    put('TOTAL', bx + 10, y + 8, 80, { size: 10, bold: true, color: '#ffffff' });
    put(`Rs. ${money(bill.total_paise)}`, bx + 80, y + 7, boxW - 90, { size: 13, bold: true, color: '#ffffff', align: 'right' });
    y += 28 + 10;
    for (const [label, amount] of paid) {
      put(label, bx, y, boxW - 90, { size: 10, color: MUTED });
      put(money(amount), bx + boxW - 90, y, 90, { align: 'right' });
      y += 17;
    }
    if (bill.balance_paise > 0) {
      y += 4;
      put('Balance due', bx, y, boxW - 90, { size: 11, bold: true, color: DUE });
      put(`Rs. ${money(bill.balance_paise)}`, bx + boxW - 110, y, 110, { size: 11, bold: true, color: DUE, align: 'right' });
      y += 22;
    }
    y += 16;
    ensure(30);
    put('Thank you. Visit again!', M, y, W, { size: 10, bold: true });

    // ---------------------------------------------------------------- footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // writing below the margin must not start a new page
      const fy = doc.page.height - M - 8;
      hline(fy - 6);
      put(`${outlet.name}${bill.invoice_no ? ` · ${bill.invoice_no}` : ''} · This is a computer-generated invoice.`, M, fy, W - 80, { size: 8, color: MUTED });
      put(`Page ${i + 1} of ${range.count}`, M + W - 80, fy, 80, { size: 8, color: MUTED, align: 'right' });
    }
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
