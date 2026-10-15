'use client';

import { useParams } from 'next/navigation';
import type { KotDoc } from '@dineos/shared/print';
import { time } from '@/lib/format';
import { Line, Receipt, Rule, usePrintData } from '@/components/print/receipt';

export default function PrintKot() {
  const { orderId } = useParams<{ orderId: string }>();
  const { data, error } = usePrintData<{ id: string; doc: KotDoc }[]>(`/orders/${orderId}/kots`);
  if (error) return <p className="p-6">{error}</p>;
  if (!data) return <p className="p-6">Loading…</p>;
  return (
    <Receipt>
      {data.map(({ id, doc }) => (
        <div key={id} className="mb-6 break-after-page">
          <div className="text-center">
            {doc.cancelled && <p className="text-lg font-bold">CANCELLED</p>}
            <p className="text-xl font-bold">KOT {doc.kot_no}</p>
            <p className="uppercase">{doc.station}</p>
          </div>
          <Line left={<b>{doc.table_label ? `Table ${doc.table_label}` : doc.order_type}</b>} right={<b>Order #{doc.order_no}</b>} />
          <Line left={doc.order_type.replace('_', '-')} right={time(doc.placed_at)} />
          <Rule />
          {doc.items.map((i, n) => (
            <div key={n} className="mb-1">
              <p className="text-[14px] font-bold">
                {i.qty} x {i.name}
                {i.seat_no ? ` (seat ${i.seat_no})` : ''}
              </p>
              {i.modifiers.length > 0 && <p className="pl-3">+ {i.modifiers.join(', ')}</p>}
              {i.note && <p className="pl-3 font-bold">! {i.note}</p>}
            </div>
          ))}
          <Rule />
          {doc.note && <p>Note: {doc.note}</p>}
        </div>
      ))}
    </Receipt>
  );
}
