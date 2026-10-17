'use client';

import { useQuery } from '@tanstack/react-query';
import { ReceiptIndianRupee } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { BillDTO, OrderDTO, TableDTO } from '@mezmitra/shared/dto';
import type { BillStatus } from '@mezmitra/shared/enums';
import { errorMessage } from '@/lib/api';
import { formatPaise, time, todayIst } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, Segmented, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { orderTitle } from '@/components/staff/order-title';
import { PageHeader } from '@/components/staff/shell';

const TONE: Record<BillStatus, 'amber' | 'blue' | 'green' | 'rose'> = { draft: 'amber', finalised: 'blue', paid: 'green', void: 'rose' };
const LABEL: Record<BillStatus, string> = { draft: 'Draft', finalised: 'Unpaid', paid: 'Paid', void: 'Void' };

export default function BillsPage() {
  const { api, outletId } = useStaff();
  const { t: tr } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<'open' | 'paid' | 'void'>('open');
  const status = tab === 'open' ? 'draft,finalised' : tab;
  const bills = useQuery({
    queryKey: ['bills', outletId, tab],
    queryFn: () => api<BillDTO[]>(`/bills?outlet_id=${outletId}&status=${status}${tab === 'open' ? '' : `&date=${todayIst()}`}`),
  });
  const tables = useQuery({ queryKey: ['tables', outletId], queryFn: () => api<TableDTO[]>(`/tables?outlet_id=${outletId}`) });
  const waiting = (tables.data ?? []).filter((t) => t.session?.status === 'open' && (t.state === 'bill_requested' || t.state === 'served'));
  // Takeaway, counter and delivery orders that were sent to the kitchen and served but never billed.
  const served = useQuery({
    queryKey: ['orders', outletId, 'to-bill'],
    enabled: tab === 'open',
    queryFn: () => api<OrderDTO[]>(`/orders?outlet_id=${outletId}&status=served&since=${encodeURIComponent(new Date(Date.now() - 24 * 3600_000).toISOString())}&limit=100`),
  });
  const drafts = new Set((bills.data ?? []).map((b) => b.order_id).filter(Boolean));
  const unbilled = (served.data ?? []).filter((o) => !o.table_session_id && !drafts.has(o.id));

  const open = async (body: { table_session_id: string } | { order_id: string }) => {
    try {
      const bill = await api<BillDTO>('/bills', { method: 'POST', body });
      router.push(`/app/bills/${bill.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="pb-10">
      <PageHeader
        title="Bills"
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'paid', label: 'Paid today' },
              { value: 'void', label: 'Void today' },
            ]}
          />
        }
      />
      {tab === 'open' && waiting.length + unbilled.length > 0 && (
        <div className="px-4 pb-4 lg:px-8">
          <p className="mb-2 text-sm font-semibold text-ink-soft">Ready to bill</p>
          <div className="flex flex-wrap gap-2">
            {waiting.map((t) => (
              <Button key={t.id} variant={t.state === 'bill_requested' ? 'primary' : 'outline'} onClick={() => void open({ table_session_id: t.session!.id })}>
                {t.label} · {formatPaise(t.running_total_paise)}
              </Button>
            ))}
            {unbilled.map((o) => (
              <Button key={o.id} variant="outline" onClick={() => void open({ order_id: o.id })}>
                {orderTitle(o, tr)} #{o.order_no} · {formatPaise(o.subtotal_paise)}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="px-4 lg:px-8">
        <Card className="overflow-hidden">
          {bills.isLoading ? (
            <div className="grid place-items-center py-16">
              <Spinner />
            </div>
          ) : (bills.data ?? []).length === 0 ? (
            <EmptyState icon={<ReceiptIndianRupee className="size-5" />} title="No bills here" />
          ) : (
            <ul className="divide-y divide-line">
              {(bills.data ?? []).map((b) => (
                <li key={b.id}>
                  <Link href={`/app/bills/${b.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-stone-50">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {b.membership ? `Membership: ${b.membership.name}` : b.table_label ? `Table ${b.table_label}` : 'Counter / takeaway'}
                        {b.split_label && <span className="ml-2 text-xs text-ink-faint">{b.split_label}</span>}
                      </p>
                      <p className="text-xs text-ink-faint">
                        {b.invoice_no ?? 'Not printed'} · {time(b.finalised_at ?? b.created_at)}
                      </p>
                    </div>
                    <Badge tone={TONE[b.status]}>{LABEL[b.status]}</Badge>
                    <div className="w-28 text-right">
                      <p className="font-semibold tabular">{formatPaise(b.total_paise)}</p>
                      {b.status === 'finalised' && b.paid_paise > 0 && <p className="text-xs text-ink-faint">due {formatPaise(b.balance_paise)}</p>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
