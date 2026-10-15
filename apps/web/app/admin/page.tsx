'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, LogOut, Plus, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { rupeesToPaise } from '@dineos/shared/money';
import { ApiError, apiFetch, errorMessage, type RequestOptions } from '@/lib/api';
import { date, formatPaise, rupeesInput } from '@/lib/format';
import { readLocal, writeLocal } from '@/lib/storage';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, Field, Input, Segmented, Select, Spinner, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = 'tenants' | 'invoices' | 'plans' | 'usage';

function useAdminApi() {
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const t = readLocal<string | null>('dineos.admin.token', null);
    if (!t) router.replace('/admin/login');
    setToken(t);
  }, [router]);
  const api = async <T,>(path: string, opts: Omit<RequestOptions, 'token'> = {}) => {
    try {
      return await apiFetch<T>(path, { ...opts, token });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        writeLocal('dineos.admin.token', null);
        router.replace('/admin/login');
      }
      throw err;
    }
  };
  return { token, api };
}

export default function AdminPage() {
  const { token, api } = useAdminApi();
  const [tab, setTab] = useState<Tab>('tenants');
  const router = useRouter();
  if (!token) return null;
  return (
    <div className="min-h-dvh">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-6 py-3">
        <ShieldCheck className="size-6 text-[var(--brand)]" />
        <h1 className="font-semibold">DineOS admin</h1>
        <Segmented value={tab} onChange={setTab} className="ml-4" options={[{ value: 'tenants', label: 'Restaurants' }, { value: 'invoices', label: 'Invoices' }, { value: 'plans', label: 'Plans' }, { value: 'usage', label: 'Usage' }]} />
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() =>
            void api('/admin/auth/logout', { method: 'POST' }).finally(() => {
              writeLocal('dineos.admin.token', null);
              router.replace('/admin/login');
            })
          }
        >
          <LogOut className="size-4" /> Sign out
        </Button>
      </header>
      <main className="p-6">
        {tab === 'tenants' && <Tenants api={api} />}
        {tab === 'invoices' && <Invoices api={api} />}
        {tab === 'plans' && <Plans api={api} />}
        {tab === 'usage' && <Usage api={api} />}
      </main>
    </div>
  );
}

type Api = ReturnType<typeof useAdminApi>['api'];

function Tenants({ api }: { api: Api }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['admin-tenants', q], queryFn: () => api<any[]>(`/admin/tenants${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or code" className="max-w-sm" aria-label="Search restaurants" />
        <Button className="ml-auto" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New restaurant
        </Button>
      </div>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-xs text-ink-faint">
            <tr>
              {['Restaurant', 'Code', 'Plan', 'Status', 'Outlets', 'Orders (30d)', 'Unpaid invoices', 'Since'].map((h) => (
                <th key={h} className="px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(data ?? []).map((t) => (
              <tr key={t.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpen(t.id)}>
                <td className="px-4 py-2.5 font-medium">{t.name}</td>
                <td className="px-4 py-2.5 text-ink-soft">{t.slug}</td>
                <td className="px-4 py-2.5">{t.plan_name}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={t.status === 'active' ? 'green' : t.status === 'suspended' ? 'amber' : 'neutral'}>{t.status}</Badge>
                </td>
                <td className="px-4 py-2.5 tabular">{t.outlets}</td>
                <td className="px-4 py-2.5 tabular">{t.orders_30d}</td>
                <td className="px-4 py-2.5 tabular">{t.unpaid_invoices || ''}</td>
                <td className="px-4 py-2.5 text-ink-faint">{date(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data && (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        )}
      </Card>
      {creating && <CreateTenant api={api} onClose={() => setCreating(false)} />}
      {open && <TenantDetail api={api} id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CreateTenant({ api, onClose }: { api: Api; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api<any[]>('/admin/plans') });
  const [f, setF] = useState({ name: '', slug: '', plan_code: 'trial', owner_name: '', owner_email: '', owner_phone: '', password: '', outlet: '', prefix: '', gstin: '', state_code: '' });
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const submit = async () => {
    try {
      await api('/admin/tenants', {
        method: 'POST',
        body: {
          name: f.name,
          slug: f.slug,
          plan_code: f.plan_code,
          owner: { name: f.owner_name, email: f.owner_email || null, phone: f.owner_phone || null, password: f.password },
          outlet: { name: f.outlet || f.name, invoice_prefix: f.prefix || undefined, gstin: f.gstin || null, state_code: f.state_code || null },
        },
      });
      await qc.invalidateQueries({ queryKey: ['admin-tenants'] });
      toast(`Created. The owner signs in with code "${f.slug}".`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <Sheet open wide onClose={onClose} title="New restaurant" footer={<Button block onClick={() => void submit()}>Create</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Business name">{(id) => <Input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
        <Field label="Restaurant code" hint="Lowercase, used to sign in">{(id) => <Input id={id} value={f.slug} onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />}</Field>
        <Field label="Plan">
          {(id) => (
            <Select id={id} value={f.plan_code} onChange={(e) => set('plan_code', e.target.value)}>
              {(plans.data ?? []).map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="First outlet name">{(id) => <Input id={id} value={f.outlet} onChange={(e) => set('outlet', e.target.value)} />}</Field>
        <Field label="Owner name">{(id) => <Input id={id} value={f.owner_name} onChange={(e) => set('owner_name', e.target.value)} />}</Field>
        <Field label="Owner email">{(id) => <Input id={id} value={f.owner_email} onChange={(e) => set('owner_email', e.target.value)} />}</Field>
        <Field label="Owner phone">{(id) => <Input id={id} value={f.owner_phone} onChange={(e) => set('owner_phone', e.target.value)} />}</Field>
        <Field label="Temporary password" hint="Share it with the owner; they can change it">{(id) => <Input id={id} value={f.password} onChange={(e) => set('password', e.target.value)} />}</Field>
        <Field label="Invoice prefix">{(id) => <Input id={id} value={f.prefix} onChange={(e) => set('prefix', e.target.value.toUpperCase())} maxLength={4} />}</Field>
        <Field label="GSTIN">{(id) => <Input id={id} value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} maxLength={15} />}</Field>
      </div>
    </Sheet>
  );
}

function TenantDetail({ api, id, onClose }: { api: Api; id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin-tenant', id], queryFn: () => api<any>(`/admin/tenants/${id}`) });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api<any[]>('/admin/plans') });
  const [reason, setReason] = useState('');
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['admin-tenant', id] }), qc.invalidateQueries({ queryKey: ['admin-tenants'] })]);
  const patch = async (body: object, done: string) => {
    try {
      await api(`/admin/tenants/${id}`, { method: 'PATCH', body });
      await refresh();
      toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const impersonate = async () => {
    if (reason.trim().length < 5) return toast('Write why you need access (it is shown in their audit log)', 'error');
    try {
      const res = await api<{ token: string }>(`/admin/tenants/${id}/impersonate`, { method: 'POST', body: { reason } });
      writeLocal('dineos.staff.token', res.token);
      window.open('/app', '_blank');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  if (!data) return null;
  const t = data.tenant;
  return (
    <Sheet open wide onClose={onClose} title={t.name}>
      <div className="space-y-5 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={t.status === 'active' ? 'green' : 'amber'}>{t.status}</Badge>
          <span className="text-ink-faint">code {t.slug}</span>
          <Select value={t.plan_code} onChange={(e) => void patch({ plan_code: e.target.value }, 'Plan changed')} className="h-10 w-48" aria-label="Plan">
            {(plans.data ?? []).map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <p className="mb-1 font-medium">Owners</p>
          {data.owners.map((o: any) => (
            <p key={o.id} className="text-ink-soft">
              {o.name} · {o.email ?? o.phone}
            </p>
          ))}
        </div>
        <div>
          <p className="mb-1 font-medium">Outlets</p>
          {data.outlets.map((o: any) => (
            <p key={o.id} className="text-ink-soft">
              {o.name} {o.city ? `· ${o.city}` : ''} {o.gstin ? `· ${o.gstin}` : ''}
            </p>
          ))}
        </div>
        <div className="rounded-2xl bg-stone-50 p-4">
          <Field label="Reason (recorded in the restaurant's audit log)">{(fid) => <Textarea id={fid} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Owner asked for help setting up GST; invoice overdue 45 days" />}</Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void impersonate()}>
              <ExternalLink className="size-4" /> Open as owner (1 hour)
            </Button>
            {t.status === 'active' ? (
              <Button variant="danger" onClick={() => void patch({ status: 'suspended', reason }, 'Suspended')}>
                Suspend
              </Button>
            ) : (
              <Button variant="success" onClick={() => void patch({ status: 'active', reason: reason || 'Reactivated' }, 'Reactivated')}>
                Reactivate
              </Button>
            )}
          </div>
        </div>
        <div>
          <p className="mb-1 font-medium">Devices</p>
          {data.devices.length === 0 ? <p className="text-ink-faint">None</p> : data.devices.map((d: any) => <p key={d.id} className="text-ink-soft">{d.name} · {d.status}</p>)}
        </div>
      </div>
    </Sheet>
  );
}

function Invoices({ api }: { api: Api }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin-invoices'], queryFn: () => api<any[]>('/admin/invoices') });
  const tenants = useQuery({ queryKey: ['admin-tenants', ''], queryFn: () => api<any[]>('/admin/tenants') });
  const [form, setForm] = useState({ tenant_id: '', period_start: '', period_end: '', amount: '' });
  const [paying, setPaying] = useState<any | null>(null);
  const [ref, setRef] = useState('');
  const create = async () => {
    try {
      await api('/admin/invoices', { method: 'POST', body: { tenant_id: form.tenant_id, period_start: form.period_start, period_end: form.period_end, ...(form.amount ? { amount_paise: rupeesToPaise(form.amount) } : {}) } });
      await qc.invalidateQueries({ queryKey: ['admin-invoices'] });
      toast('Invoice created');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Restaurant">
          {(id) => (
            <Select id={id} value={form.tenant_id} onChange={(e) => setForm({ ...form, tenant_id: e.target.value })} className="w-56">
              <option value="">Choose…</option>
              {(tenants.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="From">{(id) => <Input id={id} type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} />}</Field>
        <Field label="Amount (₹)" hint="Empty = plan price">{(id) => <Input id={id} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-32" />}</Field>
        <Button onClick={() => void create()} disabled={!form.tenant_id || !form.period_start || !form.period_end}>
          Create invoice
        </Button>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-xs text-ink-faint">
            <tr>
              {['Number', 'Restaurant', 'Period', 'Amount', 'Status', ''].map((h) => (
                <th key={h} className="px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(data ?? []).map((i) => (
              <tr key={i.id}>
                <td className="px-4 py-2.5 font-medium">{i.number}</td>
                <td className="px-4 py-2.5">{i.tenant_name}</td>
                <td className="px-4 py-2.5 text-ink-soft">
                  {i.period_start} – {i.period_end}
                </td>
                <td className="px-4 py-2.5 tabular">{formatPaise(i.amount_paise)}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={i.status === 'paid' ? 'green' : i.status === 'void' ? 'neutral' : 'amber'}>{i.status}</Badge>
                  {i.paid_reference && <span className="ml-2 text-xs text-ink-faint">{i.paid_reference}</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {i.status === 'unpaid' && (
                    <Button size="sm" variant="outline" onClick={() => setPaying(i)}>
                      Mark paid
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Sheet
        open={!!paying}
        onClose={() => setPaying(null)}
        title={`Mark ${paying?.number} paid`}
        footer={
          <Button
            block
            onClick={() =>
              void api(`/admin/invoices/${paying.id}/mark-paid`, { method: 'POST', body: { reference: ref } })
                .then(() => qc.invalidateQueries({ queryKey: ['admin-invoices'] }))
                .then(() => {
                  setPaying(null);
                  setRef('');
                  toast('Marked paid');
                })
                .catch((err) => toast(errorMessage(err), 'error'))
            }
          >
            Confirm payment received
          </Button>
        }
      >
        <Field label="UPI UTR or bank reference">{(id) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
      </Sheet>
    </div>
  );
}

function Plans({ api }: { api: Api }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin-plans'], queryFn: () => api<any[]>('/admin/plans') });
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {(data ?? []).map((p) => (
        <PlanCard
          key={p.code}
          plan={p}
          onSave={(price, features) =>
            void api(`/admin/plans/${p.code}`, { method: 'PATCH', body: { price_paise: price, features } })
              .then(() => qc.invalidateQueries({ queryKey: ['admin-plans'] }))
              .then(() => toast('Plan saved'))
              .catch((err) => toast(errorMessage(err), 'error'))
          }
        />
      ))}
    </div>
  );
}

function PlanCard({ plan, onSave }: { plan: any; onSave: (price: number, features: object) => void }) {
  const [price, setPrice] = useState(rupeesInput(plan.price_paise));
  const [features, setFeatures] = useState(JSON.stringify(plan.features, null, 2));
  return (
    <Card className="space-y-3 p-4">
      <p className="font-semibold">
        {plan.name} <span className="text-xs text-ink-faint">({plan.code})</span>
      </p>
      <Field label="Price per month (₹)">{(id) => <Input id={id} value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
      <Field label="Features (JSON)">{(id) => <Textarea id={id} value={features} onChange={(e) => setFeatures(e.target.value)} className="min-h-40 font-mono text-xs" />}</Field>
      <Button
        variant="outline"
        onClick={() => {
          try {
            onSave(rupeesToPaise(price), JSON.parse(features));
          } catch {
            /* invalid JSON: leave as is */
          }
        }}
      >
        Save
      </Button>
    </Card>
  );
}

function Usage({ api }: { api: Api }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const { data } = useQuery({ queryKey: ['admin-usage', month], queryFn: () => api<{ tenants: any[] }>(`/admin/usage?month=${month}`) });
  return (
    <div className="space-y-4">
      <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-48" aria-label="Month" />
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-xs text-ink-faint">
            <tr>
              {['Restaurant', 'Plan', 'Outlets', 'Tables', 'Orders', 'From QR', 'GMV', 'Devices online'].map((h) => (
                <th key={h} className="px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(data?.tenants ?? []).map((t) => (
              <tr key={t.tenant_id}>
                <td className="px-4 py-2.5 font-medium">{t.name}</td>
                <td className="px-4 py-2.5">{t.plan_code}</td>
                <td className="px-4 py-2.5 tabular">{t.outlets}</td>
                <td className="px-4 py-2.5 tabular">{t.tables}</td>
                <td className="px-4 py-2.5 tabular">{t.orders}</td>
                <td className="px-4 py-2.5 tabular">{t.orders ? `${Math.round((t.qr_orders / t.orders) * 100)}%` : '—'}</td>
                <td className="px-4 py-2.5 tabular">{formatPaise(t.gmv_paise)}</td>
                <td className="px-4 py-2.5 tabular">{t.active_devices}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
