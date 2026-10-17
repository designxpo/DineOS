'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Pencil, Plus, QrCode, RefreshCw, Rows3, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { TableDTO } from '@dineos/shared/dto';
import { apiBlobUrl, errorMessage } from '@/lib/api';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Sheet } from '@/components/ui/overlay';
import { Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/staff/shell';

export default function TablesPage() {
  const { api, outletId, token } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: tables, isLoading } = useQuery({ queryKey: ['tables', outletId], queryFn: () => api<TableDTO[]>(`/tables?outlet_id=${outletId}`) });
  const [editing, setEditing] = useState<TableDTO | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);
  const [qrFor, setQrFor] = useState<TableDTO | null>(null);
  const [rotate, setRotate] = useState<TableDTO | null>(null);
  const [retire, setRetire] = useState<TableDTO | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  const mutate = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['tables'] });
      toast(done);
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };

  const downloadSheet = async () => {
    setPdfBusy(true);
    try {
      const url = await apiBlobUrl(`/tables/qr-sheet.pdf?outlet_id=${outletId}`, token);
      window.open(url, '_blank');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setPdfBusy(false);
    }
  };

  const zones = [...new Set((tables ?? []).map((t) => t.zone ?? 'Tables'))];

  return (
    <div className="pb-12">
      <PageHeader
        title="Tables & QR codes"
        subtitle="Each table has its own QR. Guests scan it to see the menu and order."
        actions={
          <>
            <Button variant="outline" onClick={() => setBulk(true)}>
              <Rows3 className="size-4" /> Add many
            </Button>
            <Button variant="outline" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> Add table
            </Button>
            <Button onClick={() => void downloadSheet()} loading={pdfBusy} disabled={!tables?.length}>
              <Download className="size-4" /> QR sheet (PDF)
            </Button>
          </>
        }
      />
      <div className="space-y-4 px-4 lg:px-8">
        {isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : !tables?.length ? (
          <Card>
            <EmptyState icon={<QrCode className="size-5" />} title="No tables yet" hint="Add your tables, then print their QR codes." action={<Button onClick={() => setBulk(true)}>Add tables</Button>} />
          </Card>
        ) : (
          zones.map((zone) => (
            <Card key={zone} className="overflow-hidden">
              <h2 className="border-b border-line bg-stone-50 px-4 py-2 text-sm font-semibold text-ink-soft">{zone}</h2>
              <ul className="divide-y divide-line">
                {tables
                  .filter((t) => (t.zone ?? 'Tables') === zone)
                  .map((t) => (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-2">
                      <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
                        <span className="truncate font-display text-lg font-semibold sm:w-16">{t.label}</span>
                        <span className="text-xs text-ink-faint sm:flex-1 sm:text-sm">
                          {t.seats} seats · QR version {t.qr_token_version}
                        </span>
                      </div>
                      <IconButton label={`Show QR for ${t.label}`} onClick={() => setQrFor(t)}>
                        <QrCode className="size-4" />
                      </IconButton>
                      <IconButton label={`New QR for ${t.label}`} onClick={() => setRotate(t)}>
                        <RefreshCw className="size-4" />
                      </IconButton>
                      <IconButton label={`Edit ${t.label}`} onClick={() => setEditing(t)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton label={`Remove ${t.label}`} onClick={() => setRetire(t)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </li>
                  ))}
              </ul>
            </Card>
          ))
        )}
      </div>

      {editing && (
        <TableEditor
          table={editing === 'new' ? null : editing}
          zones={zones}
          onClose={() => setEditing(null)}
          onSave={(body) =>
            mutate(() => (editing === 'new' ? api('/tables', { method: 'POST', body: { ...body, outlet_id: outletId } }) : api(`/tables/${editing.id}`, { method: 'PATCH', body })), 'Table saved').then((ok) => ok && setEditing(null))
          }
        />
      )}
      {bulk && <BulkSheet zones={zones} onClose={() => setBulk(false)} onSave={(body) => mutate(() => api('/tables/bulk', { method: 'POST', body: { ...body, outlet_id: outletId } }), 'Tables added').then((ok) => ok && setBulk(false))} />}
      {qrFor && <QrSheet table={qrFor} onClose={() => setQrFor(null)} />}
      <ConfirmDialog
        open={!!rotate}
        onClose={() => setRotate(null)}
        title={`New QR code for ${rotate?.label}?`}
        description="Every printed copy of the current QR stops working immediately. Print and place the new one."
        confirmLabel="Make new QR"
        tone="primary"
        onConfirm={() => void mutate(() => api(`/tables/${rotate!.id}/rotate-qr`, { method: 'POST' }), 'New QR created').then((ok) => ok && setRotate(null))}
      />
      <ConfirmDialog
        open={!!retire}
        onClose={() => setRetire(null)}
        title={`Remove ${retire?.label}?`}
        description="Its QR stops working. Past orders keep the table name."
        confirmLabel="Remove table"
        onConfirm={() => void mutate(() => api(`/tables/${retire!.id}`, { method: 'DELETE' }), 'Table removed').then((ok) => ok && setRetire(null))}
      />
    </div>
  );
}

function TableEditor({ table, zones, onClose, onSave }: { table: TableDTO | null; zones: string[]; onClose: () => void; onSave: (b: object) => void }) {
  const [label, setLabel] = useState(table?.label ?? '');
  const [seats, setSeats] = useState(table?.seats ?? 4);
  const [zone, setZone] = useState(table?.zone ?? zones[0] ?? '');
  return (
    <Sheet open onClose={onClose} title={table ? `Edit ${table.label}` : 'New table'} footer={<Button block onClick={() => onSave({ label, seats, zone: zone || null })} disabled={!label.trim()}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Table name" hint="Short, as printed on the table: T4, C12, PD1">{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={20} />}</Field>
        <Field label="Seats">{(id) => <Input id={id} type="number" min={1} max={50} value={seats} onChange={(e) => setSeats(Number(e.target.value))} />}</Field>
        <Field label="Area" hint="e.g. Courtyard, Poolside, Terrace">
          {(id) => (
            <>
              <Input id={id} value={zone} onChange={(e) => setZone(e.target.value)} list="zones" />
              <datalist id="zones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      </div>
    </Sheet>
  );
}

function BulkSheet({ zones, onClose, onSave }: { zones: string[]; onClose: () => void; onSave: (b: object) => void }) {
  const [prefix, setPrefix] = useState('T');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(10);
  const [seats, setSeats] = useState(4);
  const [zone, setZone] = useState(zones[0] ?? '');
  return (
    <Sheet open onClose={onClose} title="Add many tables" footer={<Button block onClick={() => onSave({ prefix, from, to, seats, zone: zone || null })}>Add {Math.max(0, to - from + 1)} tables</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name starts with">{(id) => <Input id={id} value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={10} />}</Field>
        <Field label="Seats each">{(id) => <Input id={id} type="number" value={seats} onChange={(e) => setSeats(Number(e.target.value))} />}</Field>
        <Field label="From number">{(id) => <Input id={id} type="number" value={from} onChange={(e) => setFrom(Number(e.target.value))} />}</Field>
        <Field label="To number">{(id) => <Input id={id} type="number" value={to} onChange={(e) => setTo(Number(e.target.value))} />}</Field>
        <Field label="Area" className="col-span-2">{(id) => <Input id={id} value={zone} onChange={(e) => setZone(e.target.value)} />}</Field>
      </div>
      <p className="mt-3 text-sm text-ink-faint">
        Creates {prefix}
        {from} to {prefix}
        {to}. Names that already exist are skipped.
      </p>
    </Sheet>
  );
}

function QrSheet({ table, onClose }: { table: TableDTO; onClose: () => void }) {
  const { api, token } = useStaff();
  const { data } = useQuery({ queryKey: ['qr', table.id, table.qr_token_version], queryFn: () => api<{ url: string; svg: string }>(`/tables/${table.id}/qr`) });
  const downloadPng = async () => {
    const url = await apiBlobUrl(`/tables/${table.id}/qr?format=png`, token);
    const a = document.createElement('a');
    a.href = url;
    a.download = `table-${table.label}-qr.png`;
    a.click();
  };
  return (
    <Sheet open onClose={onClose} title={`Table ${table.label}`}>
      {data ? (
        <div className="text-center">
          <div className="mx-auto w-64 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: data.svg }} />
          <p className="mt-3 text-xs break-all text-ink-faint">{data.url}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" onClick={() => void downloadPng()}>
              <Download className="size-4" /> PNG
            </Button>
            <Button variant="outline" onClick={() => window.open(data.url, '_blank')}>
              <ExternalLink className="size-4" /> Open guest menu
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid place-items-center py-12">
          <Spinner />
        </div>
      )}
    </Sheet>
  );
}
