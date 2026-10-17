'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Monitor, Printer, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ScreenKind, ScreensDTO } from '@dineos/shared/dto';
import { errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Badge, Card, Input, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

const KIND: Record<ScreenKind, string> = { kitchen: 'Kitchen screen', till: 'Till', floor: 'Floor', orders: 'Orders', bills: 'Bills', other: 'Portal' };

function useScreens() {
  const { api, outletId, can } = useStaff();
  return useQuery({
    queryKey: ['screens', outletId],
    enabled: can('outlet.settings'),
    queryFn: () => api<ScreensDTO>(`/screens?outlet_id=${outletId}`),
    refetchInterval: 10_000,
  });
}

function useReload() {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  return async (kind: 'screen' | 'printer', id: string, name: string) => {
    try {
      await api(kind === 'screen' ? `/screens/${id}/reload` : `/screens/print-computers/${id}/reload`, { method: 'POST', body: { outlet_id: outletId } });
      toast(`Asked ${name} to reload`);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['screens'] }), 3000);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
}

const screenName = (s: { label: string; kind: ScreenKind; device: string | null }) => s.label || `${KIND[s.kind]}${s.device ? ` (${s.device})` : ''}`;

/**
 * One line saying whether the latest menu and settings have reached every screen that is on, and
 * which ones have not, with a reload for each. "Saved" is not the same as "on every screen".
 */
export function ScreensStatus({ className }: { className?: string }) {
  const { data } = useScreens();
  const reload = useReload();
  if (!data) return null;
  const screens = data.screens.filter((s) => s.online);
  const printers = data.print_computers.filter((p) => p.online);
  const total = screens.length + printers.length;
  if (total === 0) return null;
  const behind = [...screens.filter((s) => !s.up_to_date).map((s) => ({ kind: 'screen' as const, id: s.id, name: screenName(s) })), ...printers.filter((p) => !p.up_to_date).map((p) => ({ kind: 'printer' as const, id: p.id, name: p.name }))];
  if (!behind.length) {
    return (
      <p className={cn('flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900', className)} role="status">
        <CheckCircle2 className="size-4 shrink-0" />
        Your latest changes are on all {total} {total === 1 ? 'screen' : 'screens'} that are on.
      </p>
    );
  }
  return (
    <div className={cn('space-y-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950', className)} role="status">
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert className="size-4 shrink-0" />
        Your latest change is on {total - behind.length} of {total} screens.
      </p>
      <ul className="space-y-1">
        {behind.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 pl-6">
            <span>{b.name} has not picked it up yet.</span>
            <Button size="sm" variant="outline" onClick={() => void reload(b.kind, b.id, b.name)}>
              <RefreshCw className="size-3.5" /> Reload it
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every screen and print computer seen today: what it is, who is on it, and whether it is up to date. */
export function ScreensPanel() {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useScreens();
  const reload = useReload();
  const [names, setNames] = useState<Record<string, string>>({});
  if (isLoading || !data) return <Spinner />;

  const rename = async (id: string, label: string) => {
    try {
      await api(`/screens/${id}`, { method: 'PATCH', body: { outlet_id: outletId, label } });
      await qc.invalidateQueries({ queryKey: ['screens'] });
      toast('Screen named');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const status = (online: boolean, upToDate: boolean, seen: string | null) =>
    !online ? (
      <Badge tone="neutral">{seen ? `Off · seen ${ago(seen)}` : 'Never connected'}</Badge>
    ) : upToDate ? (
      <Badge tone="green">Up to date</Badge>
    ) : (
      <Badge tone="amber">Behind</Badge>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">
        Every screen checks in each half minute with the menu and settings it is running. When you change a dish, a station or a printer, each one confirms it here. Name the screens so you can tell them apart.
      </p>
      <ScreensStatus />
      <Card className="divide-y divide-line">
        {data.screens.length === 0 && <p className="px-4 py-6 text-center text-sm text-ink-faint">No screens have opened the portal today.</p>}
        {data.screens.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Monitor className="size-5 shrink-0 text-ink-faint" />
            <div className="min-w-0 flex-1 space-y-1">
              <Input
                value={names[s.id] ?? s.label}
                placeholder={`${KIND[s.kind]}${s.device ? ` (${s.device})` : ''}`}
                onChange={(e) => setNames({ ...names, [s.id]: e.target.value })}
                onBlur={() => names[s.id] !== undefined && names[s.id] !== s.label && void rename(s.id, names[s.id]!.trim())}
                maxLength={40}
                aria-label="Screen name"
                className="h-9"
              />
              <p className="text-xs text-ink-faint">
                {KIND[s.kind]}
                {s.device && ` · ${s.device}`}
                {s.user_name && ` · ${s.user_name}`}
              </p>
            </div>
            {status(s.online, s.up_to_date, s.last_seen_at)}
            <Button size="sm" variant="ghost" onClick={() => void reload('screen', s.id, screenName(s))}>
              <RefreshCw className="size-3.5" /> Reload
            </Button>
          </div>
        ))}
      </Card>
      {data.print_computers.length > 0 && (
        <Card className="divide-y divide-line">
          {data.print_computers.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Printer className="size-5 shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-xs text-ink-faint">Print computer</p>
              </div>
              {status(p.online, p.up_to_date, p.last_seen_at)}
              <Button size="sm" variant="ghost" onClick={() => void reload('printer', p.id, p.name)}>
                <RefreshCw className="size-3.5" /> Reload
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
