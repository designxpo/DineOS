'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, Plus, Printer, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { OutletDTO } from '@dineos/shared/dto';
import { API_URL, errorMessage } from '@/lib/api';
import { dateTime, formatPaise, formatRate } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, Field, Input, Segmented, Select, Spinner, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { CamerasSettings } from '@/components/staff/cameras';
import { Forbidden, PageHeader } from '@/components/staff/shell';

type Tab = 'outlet' | 'orders' | 'billing' | 'guests' | 'printers' | 'cameras' | 'brand' | 'outlets' | 'account' | 'audit';

export default function SettingsPage() {
  const { can, me } = useStaff();
  const owner = me.tenant_roles.includes('owner');
  const [tab, setTab] = useState<Tab>('outlet');
  if (!can('outlet.settings')) return <Forbidden />;
  const tabs: { value: Tab; label: string }[] = [
    { value: 'outlet', label: 'Outlet & GST' },
    { value: 'orders', label: 'Ordering' },
    { value: 'billing', label: 'Billing & UPI' },
    { value: 'guests', label: 'Loyalty & stock' },
    { value: 'printers', label: 'Printers' },
    { value: 'cameras', label: 'Cameras' },
    ...(owner ? [{ value: 'brand' as Tab, label: 'Brand & plan' }, { value: 'outlets' as Tab, label: 'Outlets' }] : []),
    { value: 'account', label: 'My PIN' },
    { value: 'audit', label: 'Audit log' },
  ];
  return (
    <div className="pb-12">
      <PageHeader title="Settings" />
      <div className="px-4 pb-4 lg:px-8">
        <Segmented value={tab} onChange={setTab} options={tabs} className="max-w-full overflow-x-auto" />
      </div>
      <div className="max-w-3xl px-4 lg:px-8">
        {tab === 'outlet' && <OutletForm fields={['name', 'legal_name', 'address', 'city', 'state_code', 'phone', 'gstin', 'fssai_no', 'invoice_prefix']} />}
        {tab === 'orders' && <OrderingForm />}
        {tab === 'billing' && <BillingForm />}
        {tab === 'guests' && <GuestsForm />}
        {tab === 'printers' && <Printers />}
        {tab === 'cameras' && <CamerasSettings />}
        {tab === 'brand' && <Brand />}
        {tab === 'outlets' && <Outlets />}
        {tab === 'account' && <MyPin />}
        {tab === 'audit' && <Audit />}
      </div>
    </div>
  );
}

function useSaveOutlet() {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  return async (body: Partial<OutletDTO>) => {
    try {
      await api(`/outlets/${outletId}`, { method: 'PATCH', body });
      await qc.invalidateQueries({ queryKey: ['outlet'] });
      toast('Saved');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
}

const LABELS: Record<string, { label: string; hint?: string }> = {
  name: { label: 'Outlet name' },
  legal_name: { label: 'Legal business name', hint: 'As registered for GST; printed on invoices' },
  address: { label: 'Address' },
  city: { label: 'City' },
  state_code: { label: 'GST state code', hint: 'Two digits, e.g. 29 for Karnataka, 27 for Maharashtra' },
  phone: { label: 'Phone' },
  gstin: { label: 'GSTIN', hint: '15 characters' },
  fssai_no: { label: 'FSSAI licence number', hint: '14 digits; printed on bills' },
  invoice_prefix: { label: 'Invoice prefix', hint: 'Up to 4 letters, e.g. AGC → AGC/2627/000123' },
};

function OutletForm({ fields }: { fields: (keyof OutletDTO)[] }) {
  const { outlet } = useStaff();
  const save = useSaveOutlet();
  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => {
    if (outlet) setForm(Object.fromEntries(fields.map((f) => [f, String(outlet[f] ?? '')])));
  }, [outlet]);
  if (!outlet) return <Spinner />;
  return (
    <Card className="space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f} label={LABELS[f]?.label ?? f} hint={LABELS[f]?.hint} className={f === 'address' ? 'sm:col-span-2' : undefined}>
            {(id) => <Input id={id} value={form[f] ?? ''} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />}
          </Field>
        ))}
      </div>
      <Button onClick={() => void save(Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' && k !== 'name' && k !== 'invoice_prefix' ? null : v.trim()])) as Partial<OutletDTO>)}>Save</Button>
    </Card>
  );
}

function OrderingForm() {
  const { outlet } = useStaff();
  const save = useSaveOutlet();
  const [stations, setStations] = useState<string[]>([]);
  useEffect(() => setStations(outlet?.kitchen_stations ?? []), [outlet]);
  if (!outlet) return <Spinner />;
  return (
    <div className="space-y-4">
      <Card className="divide-y divide-line">
        <Row title="Accept QR orders automatically" hint="Off: every guest order waits in the inbox for staff to accept. On: orders go straight to the kitchen.">
          <Switch label="Accept QR orders automatically" checked={outlet.auto_accept} onChange={(v) => void save({ auto_accept: v })} />
        </Row>
        <Row title="Still check the first order from each new phone" hint="Stops prank orders while auto-accept is on. The order is flagged in the inbox.">
          <Switch label="Check first order from new phones" checked={outlet.approve_flagged_orders} onChange={(v) => void save({ approve_flagged_orders: v })} />
        </Row>
      </Card>
      <Card className="space-y-3 p-5">
        <div>
          <h2 className="font-semibold">Kitchen stations</h2>
          <p className="text-sm text-ink-faint">Each dish goes to one station. Each station gets its own kitchen tickets and KDS filter.</p>
        </div>
        {stations.map((s, i) => (
          <div key={i} className="flex gap-2">
            <Input value={s} onChange={(e) => setStations(stations.map((x, j) => (j === i ? e.target.value.toLowerCase() : x)))} aria-label="Station name" />
            <IconButton label="Remove station" onClick={() => setStations(stations.filter((_, j) => j !== i))} disabled={stations.length === 1}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setStations([...stations, ''])}>
            <Plus className="size-4" /> Add station
          </Button>
          <Button onClick={() => void save({ kitchen_stations: stations.filter(Boolean) })}>Save stations</Button>
        </div>
      </Card>
    </div>
  );
}

function BillingForm() {
  const { outlet } = useStaff();
  const save = useSaveOutlet();
  const [sc, setSc] = useState('0');
  const [upi, setUpi] = useState({ vpa: '', name: '' });
  useEffect(() => {
    if (!outlet) return;
    setSc(String(outlet.service_charge_bp / 100));
    setUpi({ vpa: outlet.upi_vpa ?? '', name: outlet.upi_payee_name ?? '' });
  }, [outlet]);
  if (!outlet) return <Spinner />;
  const rates = [0, 500, 1200, 1800, 2800];
  return (
    <div className="space-y-4">
      <Card className="divide-y divide-line">
        <Row title="Menu prices include GST" hint="Turn on only if your printed menu prices already include tax.">
          <Switch label="Menu prices include GST" checked={outlet.prices_include_tax} onChange={(v) => void save({ prices_include_tax: v })} />
        </Row>
        <Row title="Default GST rate for new dishes" hint="Confirm the right rate for your outlet with your accountant.">
          <Select value={outlet.default_tax_rate_bp} onChange={(e) => void save({ default_tax_rate_bp: Number(e.target.value) })} className="w-28" aria-label="Default GST rate">
            {rates.map((r) => (
              <option key={r} value={r}>
                {formatRate(r)}
              </option>
            ))}
          </Select>
        </Row>
        <Row title="Service charge (%)" hint="Optional. Staff can remove it from any bill; it can't be compulsory for guests.">
          <div className="flex gap-2">
            <Input value={sc} onChange={(e) => setSc(e.target.value)} className="w-20" inputMode="decimal" aria-label="Service charge percent" />
            <Button variant="outline" onClick={() => void save({ service_charge_bp: Math.round(Number(sc || 0) * 100) })}>
              Save
            </Button>
          </div>
        </Row>
      </Card>
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Your UPI ID</h2>
          <p className="text-sm text-ink-faint">Guests and bills show a QR for this UPI ID. Money goes straight to you; staff confirm each payment.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="UPI ID">{(id) => <Input id={id} value={upi.vpa} onChange={(e) => setUpi({ ...upi, vpa: e.target.value })} placeholder="yourname@okaxis" />}</Field>
          <Field label="Name shown in UPI apps">{(id) => <Input id={id} value={upi.name} onChange={(e) => setUpi({ ...upi, name: e.target.value })} />}</Field>
        </div>
        <Button onClick={() => void save({ upi_vpa: upi.vpa.trim() || null, upi_payee_name: upi.name.trim() || null })}>Save UPI details</Button>
      </Card>
    </div>
  );
}

function GuestsForm() {
  const { outlet } = useStaff();
  const save = useSaveOutlet();
  const [form, setForm] = useState({ earn: '5', value: '1', min: '100', minutes: '90' });
  useEffect(() => {
    if (!outlet) return;
    setForm({
      earn: String(outlet.loyalty_earn_bp / 100),
      value: String(outlet.loyalty_point_value_paise / 100),
      min: String(outlet.loyalty_min_redeem_points),
      minutes: String(outlet.reservation_minutes),
    });
  }, [outlet]);
  if (!outlet) return <Spinner />;
  const earn = Number(form.earn);
  const value = Number(form.value);
  const example = earn > 0 && value > 0 ? Math.floor((1000 * earn) / 100 / value) : 0;
  return (
    <div className="space-y-4">
      <Card className="divide-y divide-line">
        <Row title="Loyalty points" hint="Guests who share their number (with consent) earn points on paid bills and spend them as a discount.">
          <Switch label="Loyalty points" checked={outlet.loyalty_enabled} onChange={(v) => void save({ loyalty_enabled: v })} />
        </Row>
        {outlet.loyalty_enabled && (
          <div className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Points back (%)" hint="Of the bill total">
                {(id) => <Input id={id} value={form.earn} onChange={(e) => setForm({ ...form, earn: e.target.value })} inputMode="decimal" />}
              </Field>
              <Field label="1 point is worth (₹)">{(id) => <Input id={id} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} inputMode="decimal" />}</Field>
              <Field label="Use from (points)" hint="Smallest redemption">
                {(id) => <Input id={id} value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} inputMode="numeric" />}
              </Field>
            </div>
            <p className="rounded-xl bg-stone-50 px-3 py-2 text-sm text-ink-soft">
              A ₹1,000 bill earns <span className="font-semibold text-ink">{example} points</span>, worth ₹{(example * value).toFixed(0)} on a later visit.
            </p>
            <Button
              onClick={() =>
                void save({
                  loyalty_earn_bp: Math.round(earn * 100),
                  loyalty_point_value_paise: Math.round(value * 100),
                  loyalty_min_redeem_points: Math.round(Number(form.min) || 0),
                })
              }
              disabled={!(earn >= 0 && earn <= 50 && value > 0)}
            >
              Save loyalty rules
            </Button>
          </div>
        )}
      </Card>
      <Card className="divide-y divide-line">
        <Row title="Default booking length" hint="How long a table is held for a reservation, unless changed on the booking.">
          <div className="flex gap-2">
            <Select value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} className="w-28" aria-label="Default booking length">
              {[45, 60, 75, 90, 105, 120, 150, 180].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </Select>
            <Button variant="outline" onClick={() => void save({ reservation_minutes: Number(form.minutes) })}>
              Save
            </Button>
          </div>
        </Row>
        <Row title="Sold out when an ingredient runs out" hint="With recipes set up, dishes needing an empty ingredient are greyed out on every menu automatically.">
          <Switch label="Auto sold-out from stock" checked={outlet.inventory_auto_stockout} onChange={(v) => void save({ inventory_auto_stockout: v })} />
        </Row>
      </Card>
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 p-4">
      <div>
        <p className="text-sm font-medium">{title}</p>
        {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

interface Device {
  id: string;
  kind: string;
  name: string;
  status: string;
  online: boolean;
  last_seen_at: string | null;
  config: { printers?: Record<string, { address: string; width: number }> };
}

function Printers() {
  const { api, outletId, outlet } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: all } = useQuery({ queryKey: ['devices', outletId], queryFn: () => api<Device[]>(`/devices?outlet_id=${outletId}`), refetchInterval: 30_000 });
  // Camera boxes are managed under Cameras.
  const devices = all?.filter((d) => d.kind === 'print_agent');
  const [created, setCreated] = useState<string | null>(null);
  const [editing, setEditing] = useState<Device | null>(null);
  const targets = ['bill', ...(outlet?.kitchen_stations ?? [])];

  const add = async () => {
    try {
      const res = await api<{ token: string }>('/devices', { method: 'POST', body: { outlet_id: outletId, name: 'Print agent' } });
      setCreated(res.token);
      await qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const test = async (target: string) => {
    try {
      await api('/print/test', { method: 'POST', body: { outlet_id: outletId, target } });
      toast(`Test page sent to ${target}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="font-semibold">Kitchen and bill printers</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Install the DineOS print agent on one computer at the outlet that is on the same network as your thermal printers. It connects out to DineOS, so no router setup is needed. Without it,
          the kitchen display and browser printing still work.
        </p>
        <Button className="mt-3" onClick={() => void add()}>
          <Plus className="size-4" /> Add print agent
        </Button>
      </Card>
      {(devices ?? []).map((d) => (
        <Card key={d.id} className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold">{d.name}</p>
              <p className="text-xs text-ink-faint">{d.last_seen_at ? `Last seen ${dateTime(d.last_seen_at)}` : 'Never connected'}</p>
            </div>
            <Badge tone={d.status === 'revoked' ? 'rose' : d.online ? 'green' : 'neutral'}>{d.status === 'revoked' ? 'Revoked' : d.online ? 'Online' : 'Offline'}</Badge>
          </div>
          <ul className="mt-3 space-y-1.5 text-sm">
            {targets.map((t) => (
              <li key={t} className="flex items-center gap-3">
                <span className="w-24 font-medium capitalize">{t}</span>
                <span className="flex-1 text-ink-faint">{d.config.printers?.[t]?.address ?? 'not set'}</span>
                {d.config.printers?.[t] && (
                  <Button size="sm" variant="ghost" onClick={() => void test(t)}>
                    <Printer className="size-4" /> Test
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(d)}>
              Set printer addresses
            </Button>
            {d.status !== 'revoked' && (
              <Button size="sm" variant="ghost" className="text-rose-700" onClick={() => void api(`/devices/${d.id}`, { method: 'PATCH', body: { status: 'revoked' } }).then(() => qc.invalidateQueries({ queryKey: ['devices'] }))}>
                Revoke
              </Button>
            )}
          </div>
        </Card>
      ))}
      <Sheet open={!!created} onClose={() => setCreated(null)} title="Print agent created">
        <p className="text-sm text-ink-soft">Run this on the outlet computer. This token is shown only once; keep it safe.</p>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-stone-900 p-3 text-xs text-stone-100">{`DINEOS_API_URL=${API_URL} \\\nDINEOS_DEVICE_TOKEN=${created} \\\nnpx dineos-print-agent`}</pre>
        <Button className="mt-3" variant="outline" onClick={() => void navigator.clipboard.writeText(created ?? '').then(() => toast('Token copied'))}>
          <Copy className="size-4" /> Copy token
        </Button>
      </Sheet>
      {editing && <PrinterMap device={editing} targets={targets} onClose={() => setEditing(null)} />}
      {(devices ?? []).some((d) => d.status === 'active') && <HubSettings devices={(devices ?? []).filter((d) => d.status === 'active')} />}
    </div>
  );
}

/** One print agent can also run as the outlet hub that keeps the outlet trading offline. */
function HubSettings({ devices }: { devices: Device[] }) {
  const { outlet } = useStaff();
  const save = useSaveOutlet();
  const [deviceId, setDeviceId] = useState(outlet?.hub_device_id ?? '');
  const [url, setUrl] = useState(outlet?.hub_url ?? '');
  useEffect(() => {
    setDeviceId(outlet?.hub_device_id ?? '');
    setUrl(outlet?.hub_url ?? '');
  }, [outlet?.hub_device_id, outlet?.hub_url]);
  const hub = devices.find((d) => d.id === outlet?.hub_device_id);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Offline mode (outlet hub)</h2>
          <p className="mt-1 text-sm text-ink-soft">
            When the internet goes down, staff screens can switch to this computer on your Wi-Fi and keep taking orders, sending kitchen tickets and printing GST bills. Everything is sent to
            DineOS when the connection returns.
          </p>
        </div>
        {hub && <Badge tone={hub.online ? 'green' : 'amber'}>{hub.online ? 'Hub ready' : 'Hub not connected'}</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Computer that runs the hub">
          {(id) => (
            <Select id={id} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Off</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Its address on your Wi-Fi" hint="Give the computer a fixed IP in your router">
          {(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:4100" />}
        </Field>
      </div>
      {deviceId && (
        <pre className="overflow-x-auto rounded-xl bg-stone-900 p-3 text-xs text-stone-100">{`DINEOS_HUB=1 DINEOS_HUB_PORT=4100 DINEOS_HUB_DATA=./dineos-hub.json \\\nDINEOS_API_URL=${API_URL} DINEOS_DEVICE_TOKEN=dv_... \\\nnpx dineos-print-agent`}</pre>
      )}
      <Button onClick={() => void save({ hub_device_id: deviceId || null, hub_url: deviceId ? url.trim() || null : null })} disabled={!!deviceId && !/^https?:\/\/\S+$/.test(url.trim())}>
        Save offline mode
      </Button>
    </Card>
  );
}

function PrinterMap({ device, targets, onClose }: { device: Device; targets: string[]; onClose: () => void }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [map, setMap] = useState<Record<string, { address: string; width: number }>>(device.config.printers ?? {});
  const save = async () => {
    const printers = Object.fromEntries(Object.entries(map).filter(([, v]) => v.address.trim()));
    try {
      await api(`/devices/${device.id}`, { method: 'PATCH', body: { config: { printers } } });
      await qc.invalidateQueries({ queryKey: ['devices'] });
      toast('Printers saved. Restart the agent to pick them up.');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <Sheet open onClose={onClose} title="Printer addresses" footer={<Button block onClick={() => void save()}>Save</Button>}>
      <p className="mb-3 text-sm text-ink-soft">Network printers usually listen on port 9100, e.g. 192.168.1.50:9100. 80 mm paper is 48 characters wide, 58 mm is 32.</p>
      <div className="space-y-3">
        {targets.map((t) => (
          <div key={t} className="flex items-end gap-2">
            <Field label={t === 'bill' ? 'Bills' : `${t} tickets`} className="flex-1">
              {(id) => <Input id={id} value={map[t]?.address ?? ''} onChange={(e) => setMap({ ...map, [t]: { address: e.target.value, width: map[t]?.width ?? 48 } })} placeholder="192.168.1.50:9100" />}
            </Field>
            <Select value={map[t]?.width ?? 48} onChange={(e) => setMap({ ...map, [t]: { address: map[t]?.address ?? '', width: Number(e.target.value) } })} className="w-28" aria-label="Paper width">
              <option value={48}>80 mm</option>
              <option value={42}>80 mm (42)</option>
              <option value={32}>58 mm</option>
            </Select>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

function Brand() {
  const { api, token } = useStaff();
  const toast = useToast();
  const qc = useQueryClient();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => api<{ name: string; branding: { primary_color?: string; logo_url?: string }; plan_name: string }>('/tenant') });
  const sub = useQuery({
    queryKey: ['subscription'],
    queryFn: () =>
      api<{ plan: { name: string; price_paise: number }; subscription: { period_start: string; period_end: string; status: string } | null; invoices: { id: string; number: string; amount_paise: number; status: string; period_start: string; period_end: string }[] }>('/subscription'),
  });
  const [color, setColor] = useState('#a8441a');
  useEffect(() => setColor(tenant.data?.branding.primary_color ?? '#a8441a'), [tenant.data]);

  const upload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await fetch(`${API_URL}/v1/tenant/logo`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
    if (!res.ok) return toast('Upload failed', 'error');
    await qc.invalidateQueries({ queryKey: ['tenant'] });
    toast('Logo updated');
  };
  const exportData = async () => {
    const res = await fetch(`${API_URL}/v1/tenant/export`, { headers: { authorization: `Bearer ${token}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dineos-export.json';
    a.click();
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">Guest menu look</h2>
        <div className="flex items-center gap-4">
          {tenant.data?.branding.logo_url ? <img src={tenant.data.branding.logo_url} alt="Logo" className="size-16 rounded-2xl border border-line object-cover" /> : <div className="size-16 rounded-2xl bg-stone-100" />}
          <label className="inline-flex h-11 cursor-pointer items-center rounded-xl border border-line px-4 text-sm font-medium hover:bg-stone-50">
            Upload logo
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="size-11 cursor-pointer rounded-xl border border-line" aria-label="Brand colour" />
          <Button variant="outline" onClick={() => void api('/tenant', { method: 'PATCH', body: { branding: { primary_color: color } } }).then(() => toast('Colour saved'))}>
            Save colour
          </Button>
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="font-semibold">Plan</h2>
        {sub.data ? (
          <>
            <p className="mt-1 text-sm">
              {sub.data.plan.name} · {formatPaise(sub.data.plan.price_paise)}/month
              {sub.data.subscription && ` · current period ${sub.data.subscription.period_start} to ${sub.data.subscription.period_end}`}
            </p>
            <ul className="mt-3 divide-y divide-line text-sm">
              {sub.data.invoices.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-2">
                  <span>
                    {i.number} · {i.period_start} – {i.period_end}
                  </span>
                  <span className="flex items-center gap-2">
                    {formatPaise(i.amount_paise)} <Badge tone={i.status === 'paid' ? 'green' : i.status === 'void' ? 'neutral' : 'amber'}>{i.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Spinner />
        )}
      </Card>
      <Card className="p-5">
        <h2 className="font-semibold">Your data</h2>
        <p className="mt-1 text-sm text-ink-soft">Download everything DineOS holds for your business as one file. To close your account and delete your data, contact support.</p>
        <Button className="mt-3" variant="outline" onClick={() => void exportData()}>
          <Download className="size-4" /> Export data
        </Button>
      </Card>
    </div>
  );
}

function MyPin() {
  const { api } = useStaff();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  return (
    <Card className="max-w-md space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Approval PIN</h2>
        <p className="mt-1 text-sm text-ink-soft">Managers type this PIN on a cashier&apos;s screen to approve voids, refunds, large discounts and cancellations.</p>
      </div>
      <Field label="Your password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      <Field label="New PIN (4 to 6 digits)">{(id) => <Input id={id} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={6} type="password" />}</Field>
      <Button
        disabled={pin.length < 4 || !password}
        onClick={() =>
          void api('/auth/pin', { method: 'POST', body: { password, pin } })
            .then(() => {
              toast('PIN saved');
              setPassword('');
              setPin('');
            })
            .catch((err) => toast(errorMessage(err), 'error'))
        }
      >
        Save PIN
      </Button>
    </Card>
  );
}

function Audit() {
  const { api, outletId } = useStaff();
  const { data } = useQuery({
    queryKey: ['audit', outletId],
    queryFn: () => api<{ id: string; action: string; entity: string; reason: string | null; created_at: string; actor_name: string | null; approved_by_name: string | null; actor_admin_id: string | null }[]>(`/audit?outlet_id=${outletId}&limit=200`),
  });
  if (!data) return <Spinner />;
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line text-sm">
        {data.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="w-36 text-xs text-ink-faint">{dateTime(a.created_at)}</span>
            <span className="font-medium">{a.action}</span>
            <span className="text-ink-soft">{a.actor_admin_id ? 'DineOS support' : a.actor_name}</span>
            {a.approved_by_name && <Badge tone="violet">approved by {a.approved_by_name}</Badge>}
            {a.reason && <span className="text-ink-faint">“{a.reason}”</span>}
          </li>
        ))}
        {data.length === 0 && <li className="px-4 py-8 text-center text-ink-faint">Nothing recorded yet.</li>}
      </ul>
    </Card>
  );
}

function Outlets() {
  const { api, me, setOutletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['outlets'], queryFn: () => api<OutletDTO[]>('/outlets') });
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const outlet = await api<OutletDTO>('/outlets', { method: 'POST', body: { name: name.trim(), ...(prefix ? { invoice_prefix: prefix } : {}) } });
      await qc.invalidateQueries({ queryKey: ['outlets'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast(`${outlet.name} added. Switch to it to set up its menu and tables.`);
      setName('');
      setPrefix('');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line text-sm">
          {(data ?? []).map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1">
                <p className="font-medium">{o.name}</p>
                <p className="text-xs text-ink-faint">{[o.city, o.gstin, `invoices ${o.invoice_prefix}/…`].filter(Boolean).join(' · ')}</p>
              </div>
              {me.outlets.some((m) => m.id === o.id) && (
                <Button size="sm" variant="ghost" onClick={() => setOutletId(o.id)}>
                  Switch to
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">Add an outlet</h2>
        <p className="text-sm text-ink-soft">Each outlet has its own menu, tables, kitchen stations, GST details and invoice series. Your plan sets how many you can have.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Outlet name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Invoice prefix" hint="Up to 4 letters, different from your other outlets">{(id) => <Input id={id} value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} maxLength={4} />}</Field>
        </div>
        <Button onClick={() => void add()} disabled={!name.trim()} loading={busy}>
          Add outlet
        </Button>
      </Card>
    </div>
  );
}
