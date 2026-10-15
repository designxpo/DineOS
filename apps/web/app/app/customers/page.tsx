'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookUser, Download, Gift, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import type { CustomerDTO, LoyaltyEntryDTO } from '@dineos/shared/dto';
import { apiBlobUrl, errorMessage } from '@/lib/api';
import { date, formatPaise } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { ConfirmDialog, Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Input, Segmented, Spinner, Switch, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { NewCustomerSheet } from '@/components/staff/customer-sheet';
import { Forbidden, PageHeader } from '@/components/staff/shell';

interface CustomerDetail {
  customer: CustomerDTO;
  ledger: LoyaltyEntryDTO[];
  bills: { id: string; invoice_no: string | null; invoice_date: string | null; total_paise: number; status: string }[];
}

const KIND_LABEL: Record<LoyaltyEntryDTO['kind'], string> = { earn: 'Earned', redeem: 'Redeemed', reverse: 'Returned (void)', adjust: 'Correction' };

export default function CustomersPage() {
  const { api, outletId, outlet, can, token } = useStaff();
  const toast = useToast();
  const [q, setQ] = useState('');
  const term = useDeferredValue(q.trim());
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['customers', outletId, term],
    enabled: can('customer.view'),
    queryFn: () => api<CustomerDTO[]>(`/customers?outlet_id=${outletId}&limit=100${term ? `&q=${encodeURIComponent(term)}` : ''}`),
  });

  if (!can('customer.view')) return <Forbidden />;

  const exportCsv = async () => {
    try {
      const url = await apiBlobUrl(`/customers/export.csv?outlet_id=${outletId}`, token);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'customers.csv';
      a.click();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="pb-12">
      <PageHeader
        title="Customers"
        subtitle={
          outlet?.loyalty_enabled
            ? `Loyalty on: ${(outlet.loyalty_earn_bp / 100).toFixed(outlet.loyalty_earn_bp % 100 ? 1 : 0)}% back in points, 1 point = ${formatPaise(outlet.loyalty_point_value_paise)}`
            : 'Guests who agreed to share their number. Turn on loyalty points in Settings.'
        }
        actions={
          <>
            {can('customer.adjust') && (
              <Button variant="outline" onClick={() => void exportCsv()}>
                <Download className="size-4" /> Export
              </Button>
            )}
            {can('customer.manage') && (
              <Button onClick={() => setOpen('new')}>
                <Plus className="size-4" /> Add customer
              </Button>
            )}
          </>
        }
      />
      <div className="px-4 lg:px-8">
        <div className="relative mb-3 max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or phone" className="pl-10" aria-label="Search customers" />
        </div>
        <Card className="overflow-hidden">
          {list.isLoading ? (
            <div className="grid place-items-center py-16">
              <Spinner />
            </div>
          ) : !list.data?.length ? (
            <EmptyState
              icon={<BookUser className="size-5" />}
              title={term ? 'No match' : 'No customers yet'}
              hint={term ? undefined : 'Guests join from the table QR, or staff add them at billing with their consent.'}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-stone-50 text-left text-xs tracking-wide text-ink-faint uppercase">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Visits</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Spent</th>
                  <th className="px-4 py-2.5 text-right font-medium">Points</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">Last visit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c.id)} className="cursor-pointer hover:bg-stone-50">
                    <td className="px-4 py-3">
                      <p className="font-medium">{c.name ?? 'Guest'}</p>
                      <p className="text-xs text-ink-faint tabular">{c.phone}</p>
                    </td>
                    <td className="hidden px-4 py-3 text-right tabular sm:table-cell">{c.visits}</td>
                    <td className="hidden px-4 py-3 text-right tabular md:table-cell">{formatPaise(c.total_spend_paise)}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular">{c.points}</td>
                    <td className="hidden px-4 py-3 text-right text-ink-faint lg:table-cell">{c.last_visit_at ? date(c.last_visit_at) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {open === 'new' && <NewCustomerSheet onClose={() => setOpen(null)} onCreated={(id) => setOpen(id)} />}
      {open && open !== 'new' && <CustomerSheet id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CustomerSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { api, outletId, can } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'profile' | 'points' | 'bills'>('profile');
  const [adjusting, setAdjusting] = useState(false);
  const [erasing, setErasing] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['customers', 'detail', id], queryFn: () => api<CustomerDetail>(`/customers/${id}?outlet_id=${outletId}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['customers'] });

  const erase = async () => {
    try {
      await api(`/customers/${id}/erase`, { method: 'POST', body: { outlet_id: outletId } });
      await refresh();
      toast('Personal details erased');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const c = data?.customer;
  return (
    <Sheet open onClose={onClose} title={c ? (c.name ?? c.phone) : 'Customer'} wide>
      {isLoading || !c ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Points', c.points],
              ['Visits', c.visits],
              ['Spent', formatPaise(c.total_spend_paise)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-stone-50 px-3 py-2.5">
                <p className="text-xs text-ink-faint">{label}</p>
                <p className="text-lg font-semibold tabular">{value}</p>
              </div>
            ))}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-ink-faint">
            <ShieldCheck className="size-3.5 text-emerald-700" />
            Consent given {date(c.consent_at)} {c.consent_source === 'guest' ? 'by the guest at the table' : 'to staff'}
            {c.marketing_opt_in && ' · wants offers'}
          </p>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'profile', label: 'Profile' },
              { value: 'points', label: 'Points', count: data.ledger.length },
              { value: 'bills', label: 'Bills', count: data.bills.length },
            ]}
          />
          {tab === 'profile' && <ProfileForm customer={c} onSaved={refresh} readOnly={!can('customer.manage')} />}
          {tab === 'points' && (
            <div>
              {can('customer.adjust') && (
                <Button size="sm" variant="outline" className="mb-3" onClick={() => setAdjusting(true)}>
                  <Gift className="size-4" /> Correct points
                </Button>
              )}
              {!data.ledger.length ? (
                <p className="py-6 text-center text-sm text-ink-faint">No points yet.</p>
              ) : (
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {data.ledger.map((l) => (
                    <li key={l.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{KIND_LABEL[l.kind]}</p>
                        <p className="truncate text-xs text-ink-faint">{[date(l.created_at), l.invoice_no, l.note].filter(Boolean).join(' · ')}</p>
                      </div>
                      <span className={cn('font-semibold tabular', l.points > 0 ? 'text-emerald-700' : 'text-rose-700')}>
                        {l.points > 0 ? '+' : ''}
                        {l.points}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {tab === 'bills' &&
            (!data.bills.length ? (
              <p className="py-6 text-center text-sm text-ink-faint">No bills yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {data.bills.map((b) => (
                  <li key={b.id}>
                    <a href={`/app/bills/${b.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-stone-50">
                      <span className="flex-1 font-medium tabular">{b.invoice_no}</span>
                      <span className="text-ink-faint">{b.invoice_date}</span>
                      <Badge tone={b.status === 'paid' ? 'green' : 'amber'} className="capitalize">
                        {b.status}
                      </Badge>
                      <span className="w-24 text-right font-semibold tabular">{formatPaise(b.total_paise)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ))}
          {can('customer.adjust') && (
            <div className="border-t border-line pt-4">
              <Button variant="ghost" size="sm" className="text-rose-700" onClick={() => setErasing(true)}>
                <Trash2 className="size-4" /> Erase personal details
              </Button>
            </div>
          )}
        </div>
      )}
      {adjusting && c && <AdjustPoints customer={c} onClose={() => setAdjusting(false)} onSaved={refresh} />}
      <ConfirmDialog
        open={erasing}
        onClose={() => setErasing(false)}
        title="Erase this customer?"
        description="Their name, phone, email and notes are removed for good and their points are cancelled. Past bills stay for the accounts, without their details."
        confirmLabel="Erase"
        onConfirm={() => void erase()}
      />
    </Sheet>
  );
}

function ProfileForm({ customer, onSaved, readOnly }: { customer: CustomerDTO; onSaved: () => void; readOnly: boolean }) {
  const { api, outletId } = useStaff();
  const toast = useToast();
  const [name, setName] = useState(customer.name ?? '');
  const [email, setEmail] = useState(customer.email ?? '');
  const [birthday, setBirthday] = useState(customer.birthday ?? '');
  const [notes, setNotes] = useState(customer.notes ?? '');
  const [marketing, setMarketing] = useState(customer.marketing_opt_in);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/customers/${customer.id}`, {
        method: 'PATCH',
        body: { outlet_id: outletId, name: name.trim() || null, email: email.trim() || null, birthday: birthday || null, notes: notes.trim() || null, marketing_opt_in: marketing },
      });
      onSaved();
      toast('Saved');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} value={customer.phone} disabled />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Birthday">{(id) => <Input id={id} type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />}</Field>
      </div>
      <Field label="Notes" hint="Preferences the team should know: allergies, favourite table…">
        {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}
      </Field>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Wants offers by SMS or WhatsApp</span>
        <Switch checked={marketing} onChange={setMarketing} label="Marketing opt-in" disabled={readOnly} />
      </div>
      {!readOnly && (
        <Button onClick={save} loading={busy}>
          Save profile
        </Button>
      )}
    </fieldset>
  );
}

function AdjustPoints({ customer, onClose, onSaved }: { customer: CustomerDTO; onClose: () => void; onSaved: () => void }) {
  const { api, outletId } = useStaff();
  const toast = useToast();
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const n = Number(points);
  const save = async () => {
    try {
      await api(`/customers/${customer.id}/points`, { method: 'POST', body: { outlet_id: outletId, points: n, note } });
      onSaved();
      toast('Points updated');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <Sheet open onClose={onClose} title="Correct points" footer={<Button block onClick={save} disabled={!Number.isInteger(n) || n === 0 || note.trim().length < 3}>Save</Button>}>
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">Balance now: {customer.points}. Use a minus sign to take points away.</p>
        <Field label="Points">{(id) => <Input id={id} value={points} onChange={(e) => setPoints(e.target.value)} inputMode="numeric" placeholder="e.g. 100 or -50" />}</Field>
        <Field label="Reason" hint="Kept in the audit log">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Goodwill for a late order" />}</Field>
      </div>
    </Sheet>
  );
}
