'use client';

import { useParams } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { InvoiceDTO } from '@dineos/shared/dto';
import { formatRate } from '@/lib/format';
import { Line, Receipt, Rule, usePrintData } from '@/components/print/receipt';

const money = (p: number) => (p / 100).toFixed(2);

export default function PrintBill() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = usePrintData<InvoiceDTO & { upi_uri: string | null }>(`/bills/${id}/invoice`);
  const [qr, setQr] = useState<string | null>(null);
  const [trackQr, setTrackQr] = useState<string | null>(null);
  useEffect(() => {
    if (data?.upi_uri) QRCode.toDataURL(data.upi_uri, { margin: 0, width: 220 }).then(setQr);
  }, [data?.upi_uri]);
  const trackCode = data?.bill.track_code;
  useEffect(() => {
    if (trackCode) QRCode.toDataURL(`${window.location.origin}/o/${trackCode}`, { margin: 0, width: 220 }).then(setTrackQr);
  }, [trackCode]);

  if (error) return <p className="p-6">{error}</p>;
  if (!data) return <p className="p-6">Loading…</p>;
  const { bill, outlet, tax_summary } = data;
  // Free (complimentary) dishes are part of the item discounts; printed on their own line.
  const free = bill.comp_paise ?? 0;
  const discount = bill.item_discount_paise + bill.bill_discount_paise - free;

  return (
    <Receipt>
      <div className="text-center">
        <p className="text-[15px] font-bold">{outlet.name}</p>
        {outlet.legal_name && <p>{outlet.legal_name}</p>}
        {outlet.address && <p>{outlet.address}</p>}
        {outlet.phone && <p>Ph: {outlet.phone}</p>}
        {outlet.gstin && <p>GSTIN: {outlet.gstin}</p>}
        {outlet.fssai_no && <p>FSSAI: {outlet.fssai_no}</p>}
        <p className="mt-2 font-bold">{bill.status === 'draft' ? 'PRE-BILL (NOT A TAX INVOICE)' : 'TAX INVOICE'}</p>
        {bill.status === 'void' && <p className="font-bold">*** CANCELLED ***</p>}
        {bill.pickup_no != null && <p className="mt-2 text-[22px] leading-none font-bold">ORDER {bill.pickup_no}</p>}
      </div>
      <Rule />
      <Line left={`Inv: ${bill.invoice_no ?? '—'}`} right={bill.invoice_date ?? ''} />
      {bill.table_label && <Line left={`Table ${bill.table_label}`} right={bill.split_label ?? ''} />}
      {(bill.customer_name ?? bill.customer?.name) && <p>Customer: {bill.customer_name ?? bill.customer?.name}</p>}
      {bill.customer_gstin && <p>Customer GSTIN: {bill.customer_gstin}</p>}
      <Rule />
      <Line left="Item" right="Qty    Amount" bold />
      {bill.lines.map((l) => (
        <div key={l.id}>
          <Line left={l.name} right={`${l.qty}  ${money(l.gross_paise).padStart(9)}`} />
          {l.comp_qty > 0 && <p className="pl-2 text-[11px]">Complimentary{l.comp_qty < l.qty ? ` (${l.comp_qty} of ${l.qty})` : ''}</p>}
          {l.hsn_sac && <p className="pl-2 text-[11px]">HSN/SAC {l.hsn_sac} @ {money(l.unit_price_paise)}</p>}
        </div>
      ))}
      <Rule />
      <Line left="Subtotal" right={money(bill.subtotal_paise)} />
      {free > 0 && <Line left="Complimentary" right={`-${money(free)}`} />}
      {discount > 0 && <Line left="Discount" right={`-${money(discount)}`} />}
      {bill.loyalty_discount_paise - bill.reward_discount_paise > 0 && <Line left={`Points redeemed (${bill.loyalty_points_redeemed})`} right={`-${money(bill.loyalty_discount_paise - bill.reward_discount_paise)}`} />}
      {bill.reward_discount_paise > 0 && <Line left="Loyalty reward" right={`-${money(bill.reward_discount_paise)}`} />}
      {bill.service_charge_paise > 0 && <Line left={`Service charge (${formatRate(bill.service_charge_bp)})`} right={money(bill.service_charge_paise)} />}
      {tax_summary.map((t) => (
        <div key={t.tax_rate_bp}>
          <Line left={`CGST ${formatRate(t.tax_rate_bp / 2)} on ${money(t.taxable_paise)}`} right={money(t.cgst_paise)} />
          <Line left={`SGST ${formatRate(t.tax_rate_bp / 2)} on ${money(t.taxable_paise)}`} right={money(t.sgst_paise)} />
        </div>
      ))}
      {bill.tax_by_operator && <p>GST paid by the e-commerce operator under section 9(5), CGST Act</p>}
      {bill.round_off_paise !== 0 && <Line left="Round off" right={money(bill.round_off_paise)} />}
      <Rule />
      <Line left={<span className="text-[15px]">TOTAL</span>} right={<span className="text-[15px]">Rs. {money(bill.total_paise)}</span>} bold />
      {bill.payments.map((p) => (
        <Line
          key={p.id}
          left={p.kind === 'refund' ? `Refund (${p.method === 'room' ? `room ${p.room_no}` : p.method})` : p.method === 'room' ? `Charged to room ${p.room_no}${p.room_guest ? ` (${p.room_guest})` : ''}` : p.method === 'platform' ? 'Paid via delivery app' : `Paid ${p.method.replace('_', ' ')}`}
          right={money(p.amount_paise)}
        />
      ))}
      {bill.balance_paise > 0 && bill.payments.length > 0 && <Line left="Balance due" right={money(bill.balance_paise)} bold />}
      {qr && bill.balance_paise > 0 && (
        <div className="mt-3 text-center">
          <p>Scan to pay with any UPI app</p>
          <img src={qr} alt="UPI QR" className="mx-auto mt-1 size-32" />
        </div>
      )}
      {trackQr && (
        <div className="mt-3 text-center">
          <p>Scan to see when your order is ready</p>
          <img src={trackQr} alt="Order status QR" className="mx-auto mt-1 size-28" />
        </div>
      )}
      <p className="mt-3 text-center">Thank you. Visit again!</p>
    </Receipt>
  );
}
