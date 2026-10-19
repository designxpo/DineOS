'use client';

import { useParams } from 'next/navigation';
import { BillReceipt, type PrintableInvoice } from '@/components/print/bill-receipt';
import { Receipt, usePrintData } from '@/components/print/receipt';

export default function PrintBill() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = usePrintData<PrintableInvoice>(`/bills/${id}/invoice`);
  if (error) return <p className="p-6">{error}</p>;
  if (!data) return <p className="p-6">Loading…</p>;
  return <Receipt animate><BillReceipt data={data} /></Receipt>;
}
