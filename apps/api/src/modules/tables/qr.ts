import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { Config } from '../../config';
import { signQrToken } from '../../lib/tokens';

export interface QrTable {
  id: string;
  label: string;
  zone: string | null;
  qr_token_version: number;
}

export function guestUrl(config: Config, ids: { tenantId: string; outletId: string; slug: string }, table: QrTable): string {
  const token = signQrToken(config.TOKEN_SECRET, {
    tenantId: ids.tenantId,
    outletId: ids.outletId,
    tableId: table.id,
    version: table.qr_token_version,
  });
  return config.GUEST_URL_TEMPLATE.replace('{slug}', ids.slug).replace('{token}', token);
}

export function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
}

export function qrPng(url: string, width = 600): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width });
}

/** A4 sheet of table cards, six per page, ready to print and laminate. */
export async function qrSheetPdf(
  outletName: string,
  cards: { table: QrTable; url: string }[],
  accent = '#B4532A',
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `${outletName} table QR codes` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const pageW = 595.28;
  const pageH = 841.89;
  const margin = 28;
  const cols = 2;
  const rows = 3;
  const gap = 14;
  const cardW = (pageW - margin * 2 - gap * (cols - 1)) / cols;
  const cardH = (pageH - margin * 2 - gap * (rows - 1)) / rows;

  for (const [index, card] of cards.entries()) {
    const slot = index % (cols * rows);
    if (index > 0 && slot === 0) doc.addPage();
    const x = margin + (slot % cols) * (cardW + gap);
    const y = margin + Math.floor(slot / cols) * (cardH + gap);

    doc.roundedRect(x, y, cardW, cardH, 10).lineWidth(1).strokeColor('#D9D4CC').stroke();
    doc.rect(x, y + 10, 4, 34).fillColor(accent).fill();
    doc
      .fillColor('#1F1B16')
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(outletName, x + 16, y + 14, { width: cardW - 32, lineBreak: false, ellipsis: true });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#6B645B')
      .text(card.table.zone ?? 'Table', x + 16, y + 31, { width: cardW - 32 });

    const qrSize = Math.min(cardW - 80, cardH - 110);
    const png = await qrPng(card.url, 600);
    doc.image(png, x + (cardW - qrSize) / 2, y + 52, { width: qrSize, height: qrSize });

    doc
      .font('Helvetica-Bold')
      .fontSize(22)
      .fillColor('#1F1B16')
      .text(card.table.label, x, y + 56 + qrSize, { width: cardW, align: 'center' });
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#6B645B')
      .text('Scan to see the menu and order', x, y + 84 + qrSize, { width: cardW, align: 'center' });
  }
  if (cards.length === 0) doc.font('Helvetica').fontSize(12).text('No tables selected', margin, margin);
  doc.end();
  return done;
}
