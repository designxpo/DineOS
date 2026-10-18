'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { OutletDTO } from '@mezmitra/shared/dto';
import { CURRENT_SYSTEMS, noContract } from '@mezmitra/shared/leads';
import { API_URL, errorMessage } from '@/lib/api';
import { dateTime, formatPaise, formatRate } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { Badge, Card, Field, Input, Segmented, Select, Spinner, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { CamerasSettings } from '@/components/staff/cameras';
import { PrinterSettings } from '@/components/staff/printer-settings';
import { PickupScreenSettings, TableSettings } from '@/components/staff/table-settings';
import { useSaveOutlet } from '@/components/staff/use-save-outlet';
import { Forbidden, PageHeader } from '@/components/staff/shell';
import { ScreensPanel, ScreensStatus } from '@/components/staff/screens-status';
import { BrandKit } from '@/components/staff/brand-kit';
import { GoliveRehearsal } from '@/components/staff/golive';

type Tab = 'outlet' | 'golive' | 'orders' | 'billing' | 'guests' | 'printers' | 'screens' | 'cameras' | 'brand' | 'outlets' | 'account' | 'audit';

export default function SettingsPage() {
  const { can, me } = useStaff();
  const owner = me.tenant_roles.includes('owner');
  const [tab, setTab] = useState<Tab>('outlet');
  if (!can('outlet.settings')) return <Forbidden />;
  const tabs: { value: Tab; label: string }[] = [
    { value: 'outlet', label: 'Outlet & GST' },
    { value: 'golive', label: 'Go-live' },
    { value: 'orders', label: 'Ordering' },
    { value: 'billing', label: 'Billing & UPI' },
    { value: 'guests', label: 'Loyalty & stock' },
    { value: 'printers', label: 'Printers' },
    { value: 'screens', label: 'Screens' },
    { value: 'cameras', label: 'Cameras' },
    ...(owner ? [{ value: 'brand' as Tab, label: 'Brand & plan' }, { value: 'outlets' as Tab, label: 'Outlets' }] : []),
    { value: 'account', label: 'My PIN' },
    { value: 'audit', label: 'Audit log' },
  ];
  return (
    <div className="pb-12">
      <PageHeader title="Settings" />
      <div className="px-4 pb-4 lg:px-8">
        <Select value={tab} onChange={(e) => setTab(e.target.value as Tab)} aria-label="Settings section" className="sm:hidden">
          {tabs.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Segmented value={tab} onChange={setTab} options={tabs} className="hidden sm:inline-flex" />
      </div>
      <div className="max-w-3xl px-4 lg:px-8">
        {tab !== 'screens' && <ScreensStatus className="mb-4" />}
        {tab === 'outlet' && <OutletForm fields={['name', 'legal_name', 'address', 'city', 'state_code', 'phone', 'gstin', 'fssai_no', 'invoice_prefix']} />}
        {tab === 'golive' && <GoliveRehearsal />}
        {tab === 'orders' && <OrderingForm />}
        {tab === 'billing' && <BillingForm />}
        {tab === 'guests' && <GuestsForm />}
        {tab === 'printers' && <PrinterSettings />}
        {tab === 'screens' && <ScreensPanel />}
        {tab === 'cameras' && <CamerasSettings />}
        {tab === 'brand' && <Brand />}
        {tab === 'outlets' && <Outlets />}
        {tab === 'account' && <MyPin />}
        {tab === 'audit' && <Audit />}
      </div>
    </div>
  );
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
        <Row
          title="Still check the first order at each table"
          hint="Stops prank orders while auto-accept is on. Once staff accept one order at a table, or a waiter seats it, the other phones there go straight through. A phone that was at the table in an earlier visit is always checked."
        >
          <Switch label="Check the first order at each table" checked={outlet.approve_flagged_orders} onChange={(v) => void save({ approve_flagged_orders: v })} />
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
      <TableSettings />
      <PickupScreenSettings />
    </div>
  );
}

function BillingForm() {
  const { outlet } = useStaff();
  const save = useSaveOutlet();
  const [sc, setSc] = useState('0');
  const [upi, setUpi] = useState({ vpa: '', name: '' });
  const [commission, setCommission] = useState({ zomato: '', swiggy: '' });
  const [compAlert, setCompAlert] = useState('');
  useEffect(() => {
    if (!outlet) return;
    setSc(String(outlet.service_charge_bp / 100));
    setCompAlert(outlet.comp_alert_paise == null ? '' : String(outlet.comp_alert_paise / 100));
    setUpi({ vpa: outlet.upi_vpa ?? '', name: outlet.upi_payee_name ?? '' });
    const pctOf = (bp: number | undefined) => (bp == null ? '' : String(bp / 100));
    setCommission({ zomato: pctOf(outlet.delivery_commission_bp.zomato), swiggy: pctOf(outlet.delivery_commission_bp.swiggy) });
  }, [outlet]);
  if (!outlet) return <Spinner />;
  const rates = [0, 500, 1200, 1800, 2800];
  return (
    <div className="space-y-4">
      <WhereBills />
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
        <Row title="Charge bills to hotel rooms" hint="For restaurants inside a hotel: cashiers can put a bill on a guest's room. The front desk sees them under Reports → Room charges.">
          <Switch label="Charge bills to hotel rooms" checked={outlet.room_charge_enabled} onChange={(v) => void save({ room_charge_enabled: v })} />
        </Row>
        <Row title="Delivery app commission (%)" hint="What Zomato and Swiggy keep from each order. Reports → Delivery uses it to show the payout to expect.">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={commission.zomato} onChange={(e) => setCommission({ ...commission, zomato: e.target.value })} className="w-20" inputMode="decimal" placeholder="Zomato" aria-label="Zomato commission percent" />
            <Input value={commission.swiggy} onChange={(e) => setCommission({ ...commission, swiggy: e.target.value })} className="w-20" inputMode="decimal" placeholder="Swiggy" aria-label="Swiggy commission percent" />
            <Button
              variant="outline"
              onClick={() =>
                void save({
                  delivery_commission_bp: {
                    ...(commission.zomato ? { zomato: Math.round(Number(commission.zomato) * 100) } : {}),
                    ...(commission.swiggy ? { swiggy: Math.round(Number(commission.swiggy) * 100) } : {}),
                  },
                })
              }
            >
              Save
            </Button>
          </div>
        </Row>
        <Row title="Service charge (%)" hint="Optional. Staff can remove it from any bill; it can't be compulsory for guests.">
          <div className="flex gap-2">
            <Input value={sc} onChange={(e) => setSc(e.target.value)} className="w-20" inputMode="decimal" aria-label="Service charge percent" />
            <Button variant="outline" onClick={() => void save({ service_charge_bp: Math.round(Number(sc || 0) * 100) })}>
              Save
            </Button>
          </div>
        </Row>
        <Row
          title="Free food and drinks alert (₹)"
          hint="Owners, managers and cashiers can give dishes free (a waiter needs a manager's PIN). Your phone hears about anything given free worth this much or more. Leave empty for no alerts; everything is in Reports → Free items either way."
        >
          <div className="flex gap-2">
            <Input value={compAlert} onChange={(e) => setCompAlert(e.target.value)} className="w-24" inputMode="numeric" placeholder="Off" aria-label="Alert above rupees" />
            <Button variant="outline" onClick={() => void save({ comp_alert_paise: compAlert.trim() ? Math.round(Number(compAlert) * 100) : null })}>
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
  const [form, setForm] = useState({ minutes: '90' });
  useEffect(() => {
    if (!outlet) return;
    setForm({ minutes: String(outlet.reservation_minutes) });
  }, [outlet]);
  if (!outlet) return <Spinner />;
  return (
    <div className="space-y-4">
      <Card className="divide-y divide-line">
        <Row title="Loyalty programme" hint="Points, stamp cards, levels, birthday and comeback rewards: set up from a template or build your own.">
          <Link href="/app/loyalty" className="inline-flex h-10 items-center rounded-xl border border-line px-4 text-sm font-medium hover:bg-stone-50">
            Open Loyalty
          </Link>
        </Row>
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

/**
 * Which system makes this outlet's bills. An outlet that paid a year ahead for another one keeps
 * billing there and uses the money check meanwhile; billing moves here when that year ends.
 */
function WhereBills() {
  const { outlet } = useStaff();
  const save = useSaveOutlet();
  const [system, setSystem] = useState('');
  if (!outlet) return null;
  const elsewhere = outlet.billing_elsewhere;
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Where this outlet bills</h2>
        <Badge tone={elsewhere ? 'blue' : 'green'}>{elsewhere ? `On ${elsewhere}` : 'On Mezmitra'}</Badge>
      </div>
      {elsewhere ? (
        <>
          <p className="text-sm text-ink-soft">
            Orders and bills are made on {elsewhere}, so Mezmitra takes none: the QR menu is for reading and calling a waiter. Upload {elsewhere}&rsquo;s sales export and your bank statement under{' '}
            <Link href="/app/reconcile" className="font-medium text-brand-700 underline">
              Money check
            </Link>{' '}
            to see every UPI payment that never reached the bank.
          </p>
          <Button variant="outline" onClick={() => void save({ billing_elsewhere: null })}>
            Move billing to Mezmitra
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-soft">
            Already paid a year of another billing system? Keep billing there until it ends and use Mezmitra to check the money meanwhile. Nothing is billed twice.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Billing system it uses" className="w-64">
              {(id) => <Input id={id} list="billing-systems" value={system} onChange={(e) => setSystem(e.target.value)} placeholder="e.g. Petpooja" maxLength={40} />}
            </Field>
            <datalist id="billing-systems">
              {CURRENT_SYSTEMS.filter((s) => !noContract(s) && s !== 'Other software').map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <Button variant="outline" disabled={!system.trim()} onClick={() => void save({ billing_elsewhere: system.trim() })}>
              Bill there for now
            </Button>
          </div>
        </>
      )}
    </Card>
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

function Brand() {
  const { api, token } = useStaff();
  const sub = useQuery({
    queryKey: ['subscription'],
    queryFn: () =>
      api<{ plan: { name: string; price_paise: number }; subscription: { period_start: string; period_end: string; status: string } | null; invoices: { id: string; number: string; amount_paise: number; status: string; period_start: string; period_end: string }[] }>('/subscription'),
  });
  const exportData = async () => {
    const res = await fetch(`${API_URL}/v1/tenant/export`, { headers: { authorization: `Bearer ${token}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mezmitra-export.json';
    a.click();
  };

  return (
    <div className="space-y-4">
      <BrandKit />
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
        <p className="mt-1 text-sm text-ink-soft">Download everything Mezmitra holds for your business as one file. To close your account and delete your data, contact support.</p>
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
            <span className="text-ink-soft">{a.actor_admin_id ? 'Mezmitra support' : a.actor_name}</span>
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
