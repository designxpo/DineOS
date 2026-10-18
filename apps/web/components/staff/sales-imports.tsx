'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import type { SalesImportDTO, SalesImportResultDTO } from '@mezmitra/shared/dto';
import type { PaymentMethod } from '@mezmitra/shared/enums';
import { ApiError, errorMessage } from '@/lib/api';
import { readBase64 } from '@/lib/files';
import { date, dateTime, formatPaise } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Select, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

const METHOD: Partial<Record<PaymentMethod, string>> = { cash: 'Cash', upi: 'UPI', card_slip: 'Card', platform: 'Delivery apps', other: 'Other' };

const ROLES = [
  { key: 'date', label: 'Bill date', required: true },
  { key: 'total', label: 'Bill total', required: true },
  { key: 'method', label: 'Payment type' },
  { key: 'bill_no', label: 'Bill number' },
  { key: 'reference', label: 'UPI reference (UTR)' },
  { key: 'status', label: 'Status (to leave out cancelled bills)' },
] as const;
type Columns = Partial<Record<(typeof ROLES)[number]['key'], string>>;

/** The upload button for the other system's sales export, with the column picker it may need. */
export function useSalesUpload(system: string) {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ file: File; headers: string[] } | null>(null);

  const send = async (file: File, columns?: Columns) => {
    setBusy(true);
    try {
      const r = await api<SalesImportResultDTO>('/reconciliation/sales', { method: 'POST', body: { outlet_id: outletId, file_name: file.name, data: await readBase64(file), columns } });
      await qc.invalidateQueries({ queryKey: ['sales-imports'] });
      await qc.invalidateQueries({ queryKey: ['reconcile'] });
      setAsking(null);
      const i = r.import;
      toast(i.bills ? `Read ${i.bills} bills from ${date(i.period_from)} to ${date(i.period_to)}${i.duplicates ? ` (${i.duplicates} already here)` : ''}` : 'Nothing new in this file: every bill was already uploaded');
      if (r.unsplit) toast(`${r.unsplit} bill${r.unsplit === 1 ? ' was' : 's were'} paid in parts without amounts per method, so ${r.unsplit === 1 ? 'it is' : 'they are'} counted as Other`);
    } catch (err) {
      const headers = err instanceof ApiError && err.code === 'unknown_sales_export' ? (err.details as { headers?: string[] } | undefined)?.headers : undefined;
      if (headers?.length) setAsking({ file, headers });
      else toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const element = (
    <>
      <input ref={input} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && void send(e.target.files[0])} />
      {asking && <ColumnsSheet system={system} headers={asking.headers} busy={busy} onClose={() => setAsking(null)} onSend={(c) => void send(asking.file, c)} />}
    </>
  );
  return { pick: () => input.current?.click(), busy, element };
}

/** Sales exports uploaded from the outlet's other billing system, and what their UPI looks like in the bank. */
export function SalesImports({ system, onPick, busy }: { system: string; onPick: () => void; busy: boolean }) {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['sales-imports', outletId], queryFn: () => api<SalesImportDTO[]>(`/reconciliation/sales?outlet_id=${outletId}`) });
  const [removing, setRemoving] = useState<SalesImportDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const remove = async (i: SalesImportDTO) => {
    setDeleting(true);
    try {
      await api(`/reconciliation/sales/${i.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['sales-imports'] });
      await qc.invalidateQueries({ queryKey: ['reconcile'] });
      setRemoving(null);
      toast('Upload removed');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setDeleting(false);
    }
  };
  const confirm = (
    <ConfirmDialog
      open={!!removing}
      onClose={() => setRemoving(null)}
      title={`Remove ${removing?.file_name ?? 'this upload'}?`}
      description={`Its ${removing?.bills ?? 0} bills go too, and bank matches made to them are undone. Upload the right file again any time.`}
      confirmLabel="Remove upload"
      busy={deleting}
      onConfirm={() => removing && void remove(removing)}
    />
  );

  if (list.isLoading) return <Spinner />;
  if (!list.data?.length) {
    return (
      <Card>
        <EmptyState
          icon={<FileSpreadsheet className="size-5" />}
          title={`Start with ${system}'s sales`}
          hint={`In ${system}, export the bill-wise sales report (one row per bill, with the payment type) for the days to check, as Excel or CSV. Upload it here, then import your bank statement for the same days.`}
          action={
            <Button onClick={onPick} loading={busy}>
              <Upload className="size-4" /> Upload sales export
            </Button>
          }
        />
      </Card>
    );
  }
  const [latest, ...older] = list.data;
  return (
    <div className="space-y-3">
      <ImportCard i={latest!} onRemove={() => setRemoving(latest!)} />
      {older.length > 0 && (
        <details className="rounded-[var(--radius-card)] border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Earlier uploads ({older.length})</summary>
          <ul className="divide-y divide-line border-t border-line">
            {older.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {date(i.period_from)} to {date(i.period_to)} · {i.file_name}
                </span>
                <span className="text-ink-faint">{i.bills} bills</span>
                {i.upi.missing > 0 && <Badge tone="rose">{formatPaise(i.upi.missing_paise)} UPI not in bank</Badge>}
                <IconButton label={`Remove ${i.file_name}`} onClick={() => setRemoving(i)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        </details>
      )}
      {confirm}
    </div>
  );
}

function ImportCard({ i, onRemove }: { i: SalesImportDTO; onRemove: () => void }) {
  const total = i.by_method.reduce((a, m) => a + m.amount_paise, 0);
  const u = i.upi;
  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">
            {i.system} sales, {date(i.period_from)} to {date(i.period_to)}
          </h2>
          <p className="text-xs text-ink-faint">
            {i.file_name} · {i.bills} bills{i.duplicates ? `, ${i.duplicates} already here` : ''}
            {i.skipped ? `, ${i.skipped} rows left out (cancelled, zero or totals)` : ''} · uploaded {dateTime(i.created_at)}
            {i.uploaded_by_name && ` by ${i.uploaded_by_name}`}
          </p>
        </div>
        <IconButton label={`Remove ${i.file_name}`} onClick={onRemove}>
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium tracking-wide text-ink-faint uppercase">What the bills say was taken</p>
          <ul className="space-y-1.5 text-sm">
            {i.by_method.map((m) => (
              <li key={m.method} className="flex items-baseline gap-2">
                <span className="flex-1">
                  {METHOD[m.method] ?? m.method} <span className="text-xs text-ink-faint">· {m.count}</span>
                </span>
                <span className="font-medium tabular">{formatPaise(m.amount_paise)}</span>
              </li>
            ))}
            <li className="flex items-baseline gap-2 border-t border-line pt-1.5 font-semibold">
              <span className="flex-1">Total</span>
              <span className="tabular">{formatPaise(total)}</span>
            </li>
          </ul>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium tracking-wide text-ink-faint uppercase">UPI against the bank</p>
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-baseline gap-2">
              <span className="flex-1">Found in the bank</span>
              <span className="font-medium text-emerald-700 tabular">{formatPaise(u.matched_paise)}</span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="flex-1">
                Not in the bank <span className="text-xs text-ink-faint">· {u.missing}</span>
              </span>
              <span className={u.missing ? 'font-semibold text-rose-700 tabular' : 'font-medium tabular'}>{formatPaise(u.missing_paise)}</span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="flex-1">
                Not checked yet <span className="text-xs text-ink-faint">· {u.unchecked}</span>
              </span>
              <span className="font-medium text-ink-soft tabular">{formatPaise(u.unchecked_paise)}</span>
            </li>
          </ul>
          {u.unchecked > 0 && <p className="mt-2 text-xs text-ink-faint">Import a bank statement that runs past these days to check the rest.</p>}
        </div>
      </div>
    </Card>
  );
}

/** The export's columns could not be told from their names: the person says which is which. */
function ColumnsSheet({ system, headers, busy, onClose, onSend }: { system: string; headers: string[]; busy: boolean; onClose: () => void; onSend: (c: Columns) => void }) {
  const [cols, setCols] = useState<Columns>({});
  const ready = !!cols.date && !!cols.total;
  return (
    <Sheet
      open
      onClose={onClose}
      title="Which column is which?"
      footer={
        <Button block onClick={() => onSend(cols)} disabled={!ready} loading={busy}>
          Read the file
        </Button>
      }
    >
      <p className="mb-4 text-sm text-ink-soft">Mezmitra could not tell the columns of this {system} file from their names. Pick them once; without a payment type, every bill counts as Other.</p>
      <div className="space-y-3">
        {ROLES.map((r) => (
          <Field key={r.key} label={`${r.label}${'required' in r ? '' : ' (if there is one)'}`}>
            {(id) => (
              <Select id={id} value={cols[r.key] ?? ''} onChange={(e) => setCols({ ...cols, [r.key]: e.target.value || undefined })}>
                <option value="">{'required' in r ? 'Choose…' : 'None'}</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ))}
      </div>
    </Sheet>
  );
}
