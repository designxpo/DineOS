'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, UserRound } from 'lucide-react';
import { useState } from 'react';
import { ROLES, type Role } from '@mezmitra/shared/enums';
import { errorMessage } from '@/lib/api';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Input, Spinner, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { Forbidden, PageHeader } from '@/components/staff/shell';

interface StaffMember {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: 'active' | 'disabled';
  has_pin: boolean;
  roles: { outlet_id: string | null; role: Role }[];
}

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, every outlet',
  manager: 'Runs the outlet, approves voids and refunds',
  cashier: 'POS, bills and payments',
  waiter: 'Takes orders, serves, manages tables',
  kitchen: 'Kitchen display and stock',
};

export default function StaffPage() {
  const { api, outletId, can, me } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<StaffMember | 'new' | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['staff', outletId], enabled: can('staff.manage'), queryFn: () => api<StaffMember[]>(`/staff?outlet_id=${outletId}`) });

  if (!can('staff.manage')) return <Forbidden />;

  const save = async (member: StaffMember | null, body: object) => {
    try {
      await api(member ? `/staff/${member.id}` : '/staff', { method: member ? 'PATCH' : 'POST', body });
      await qc.invalidateQueries({ queryKey: ['staff'] });
      toast(member ? 'Saved' : 'Staff member added. Share their login and password with them.');
      setEditing(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="pb-12">
      <PageHeader
        title="Staff"
        subtitle="Everyone signs in with the restaurant code, their email or phone, and their password"
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" /> Add staff
          </Button>
        }
      />
      <div className="px-4 lg:px-8">
        <Card className="overflow-hidden">
          {isLoading ? (
            <div className="grid place-items-center py-16">
              <Spinner />
            </div>
          ) : !data?.length ? (
            <EmptyState icon={<UserRound className="size-5" />} title="No staff yet" />
          ) : (
            <ul className="divide-y divide-line">
              {data.map((s) => (
                <li key={s.id} className={cn('flex items-center gap-3 px-4 py-3', s.status === 'disabled' && 'opacity-50')}>
                  <div className="grid size-10 shrink-0 place-items-center rounded-full bg-stone-100 font-semibold text-ink-soft">{s.name.slice(0, 1)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {s.name} {s.id === me.user.id && <span className="text-xs text-ink-faint">(you)</span>}
                    </p>
                    <p className="truncate text-xs text-ink-faint">{[s.email, s.phone].filter(Boolean).join(' · ')}</p>
                  </div>
                  <div className="hidden flex-wrap gap-1 sm:flex">
                    {[...new Set(s.roles.map((r) => r.role))].map((r) => (
                      <Badge key={r} tone={r === 'owner' ? 'brand' : r === 'manager' ? 'violet' : 'neutral'} className="capitalize">
                        {r}
                      </Badge>
                    ))}
                    {s.has_pin && (
                      <Badge tone="green">
                        <KeyRound className="size-3" /> PIN
                      </Badge>
                    )}
                    {s.status === 'disabled' && <Badge tone="rose">Disabled</Badge>}
                  </div>
                  <IconButton label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                    <Pencil className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <p className="mt-3 text-xs text-ink-faint">Managers set their own approval PIN from Settings → My PIN.</p>
      </div>
      {editing && <StaffEditor member={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function StaffEditor({ member, onClose, onSave }: { member: StaffMember | null; onClose: () => void; onSave: (m: StaffMember | null, body: object) => void }) {
  const { me, outletId } = useStaff();
  const isOwner = me.tenant_roles.includes('owner');
  const [name, setName] = useState(member?.name ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [phone, setPhone] = useState(member?.phone ?? '');
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(member?.status !== 'disabled');
  const [role, setRole] = useState<Role>(member?.roles.find((r) => r.outlet_id === outletId || r.outlet_id === null)?.role ?? 'waiter');
  const [everyOutlet, setEveryOutlet] = useState(member?.roles.some((r) => r.outlet_id === null) ?? false);
  // Outlets this person works at (when the business has several).
  const manageable = me.outlets.filter((o) => isOwner || o.roles.includes('manager'));
  const [outlets, setOutlets] = useState<string[]>(() => {
    const current = (member?.roles ?? []).map((r) => r.outlet_id).filter((x): x is string => !!x);
    return current.length ? [...new Set(current)] : [outletId];
  });
  const grantable = ROLES.filter((r) => isOwner || !['owner', 'manager'].includes(r));

  const submit = () => {
    const body: Record<string, unknown> = {
      name,
      email: email || null,
      phone: phone || null,
      roles: everyOutlet || role === 'owner' ? [{ outlet_id: null, role }] : outlets.map((o) => ({ outlet_id: o, role })),
    };
    if (password) body.password = password;
    if (member) body.status = active ? 'active' : 'disabled';
    onSave(member, body);
  };

  return (
    <Sheet open onClose={onClose} title={member ? `Edit ${member.name}` : 'Add staff'} footer={<Button block onClick={submit} disabled={!name || (!member && password.length < 8) || (!email && !phone)}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">{(id) => <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />}</Field>
          <Field label="Email">{(id) => <Input id={id} value={email} onChange={(e) => setEmail(e.target.value)} type="email" />}</Field>
        </div>
        <Field label={member ? 'New password' : 'Password'} hint={member ? 'Leave empty to keep the current one. Changing it signs them out everywhere.' : 'At least 8 characters'}>
          {(id) => <Input id={id} value={password} onChange={(e) => setPassword(e.target.value)} type="text" autoComplete="new-password" />}
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium">Role</p>
          <div className="space-y-2">
            {grantable.map((r) => (
              <button key={r} type="button" onClick={() => setRole(r)} className={cn('flex w-full cursor-pointer items-center justify-between rounded-xl border px-3 py-2.5 text-left', role === r ? 'border-[var(--brand)] bg-brand-50' : 'border-line hover:bg-stone-50')}>
                <span className="text-sm font-medium capitalize">{r}</span>
                <span className="text-xs text-ink-faint">{ROLE_HELP[r]}</span>
              </button>
            ))}
          </div>
        </div>
        {isOwner && role !== 'owner' && me.outlets.length > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-sm">Works at every outlet</span>
            <Switch label="Works at every outlet" checked={everyOutlet} onChange={setEveryOutlet} />
          </div>
        )}
        {!everyOutlet && role !== 'owner' && manageable.length > 1 && (
          <div>
            <p className="mb-2 text-sm font-medium">Works at</p>
            <div className="flex flex-wrap gap-2">
              {manageable.map((o) => {
                const on = outlets.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setOutlets(on ? outlets.filter((x) => x !== o.id) : [...outlets, o.id])}
                    className={cn('h-9 cursor-pointer rounded-full border px-3 text-sm', on ? 'border-[var(--brand)] bg-brand-50 font-medium text-brand-700' : 'border-line')}
                  >
                    {o.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {member && (
          <div className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2">
            <span className="text-sm">Can sign in</span>
            <Switch label="Can sign in" checked={active} onChange={setActive} />
          </div>
        )}
      </div>
    </Sheet>
  );
}
