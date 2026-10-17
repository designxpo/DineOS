'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { MenuDTO } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/overlay';
import { Card, Select } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useSaveOutlet } from './use-save-outlet';

/** Settings > Ordering: how tables free up after guests leave, and bottled water on tables. */
export function TableSettings() {
  const { api, outletId, outlet } = useStaff();
  const save = useSaveOutlet();
  const { data: menu } = useQuery({ queryKey: ['menu', outletId, 'staff'], queryFn: () => api<MenuDTO>(`/menu?outlet_id=${outletId}`), staleTime: 60_000 });
  if (!outlet) return null;
  const items = [...(menu?.items ?? [])].sort((a, b) => Number(/water|bisleri|kinley|aqua/i.test(b.name)) - Number(/water|bisleri|kinley|aqua/i.test(a.name)) || a.name.localeCompare(b.name));
  return (
    <Card className="divide-y divide-line">
      <div className="space-y-2 p-5">
        <h2 className="font-semibold">After guests leave</h2>
        <p className="text-sm text-ink-faint">
          When the bill is paid the table shows &ldquo;Needs cleaning&rdquo;. It turns free again by itself after this time, or when staff tap Mark clean. New guests scanning its QR
          mark it taken straight away.
        </p>
        <Select value={outlet.auto_clean_minutes} onChange={(e) => void save({ auto_clean_minutes: Number(e.target.value) })} aria-label="Tables count as clean after" className="max-w-xs">
          <option value={0}>Only when staff mark it clean</option>
          {[5, 10, 15, 20, 30].map((m) => (
            <option key={m} value={m}>
              Free again after {m} minutes
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2 p-5">
        <h2 className="font-semibold">Bottled water on tables</h2>
        <p className="text-sm text-ink-faint">
          If you leave sealed water bottles on tables and charge only for opened ones, pick the dish to bill them as. Before a table&rsquo;s bill prints, staff tap how many were opened
          (or none), so a bottle is never missed or wrongly charged.
        </p>
        <Select value={outlet.table_water_item_id ?? ''} onChange={(e) => void save({ table_water_item_id: e.target.value || null })} aria-label="Bottled water item" className="max-w-xs">
          <option value="">No water on tables</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} · {formatPaise(i.price_paise)}
            </option>
          ))}
        </Select>
      </div>
    </Card>
  );
}

/**
 * The pickup screen for counter and takeaway orders: a TV or old tablet by the counter shows
 * order numbers being made and ready to collect, instead of calling out names.
 */
export function PickupScreenSettings() {
  const { api, outletId } = useStaff();
  const toast = useToast();
  const qc = useQueryClient();
  const [qr, setQr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({ queryKey: ['pickup-link', outletId], queryFn: () => api<{ url: string }>(`/outlets/${outletId}/pickup-link`), staleTime: Infinity });
  const url = data?.url ?? null;
  useEffect(() => {
    if (url) void QRCode.toDataURL(url, { margin: 1, width: 240 }).then(setQr);
  }, [url]);
  const rotate = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['pickup-link', outletId], await api<{ url: string }>(`/outlets/${outletId}/pickup-link/rotate`, { method: 'POST' }));
      toast('New link made; the old one has stopped working');
      setConfirm(false);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-5">
      <div>
        <h2 className="font-semibold">Pickup screen for counter orders</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Open this link on a TV or tablet by the counter. It shows the numbers of counter and takeaway orders being made and ready to collect, and chimes when one is ready. Guests also get
          a link on their receipt to follow their order on their phone.
        </p>
      </div>
      {url && (
        <div className="flex flex-wrap items-center gap-4">
          {qr && <img src={qr} alt="" className="size-28 rounded-lg border border-line bg-white" />}
          <div className="min-w-0 flex-1 space-y-2">
            <p className="truncate rounded-lg bg-stone-50 px-3 py-2 font-mono text-xs text-ink-soft">{url}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(url).then(() => toast('Link copied'))}>
                <Copy className="size-4" /> Copy link
              </Button>
              <Button size="sm" variant="outline" onClick={() => window.open(url, '_blank')}>
                <ExternalLink className="size-4" /> Open
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
                <RefreshCw className="size-4" /> New link
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Make a new pickup screen link?"
        description="Screens using the old link stop showing orders. Open the new link on your screens."
        confirmLabel="Make new link"
        tone="primary"
        busy={busy}
        onConfirm={() => void rotate()}
      />
    </Card>
  );
}
