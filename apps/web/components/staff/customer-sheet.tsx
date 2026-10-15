'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CustomerDTO } from '@dineos/shared/dto';
import { errorMessage } from '@/lib/api';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/overlay';
import { Field, Input } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

/** The consent tick is required: without it the API stores nothing (spec §12). */
export function NewCustomerSheet({ onClose, onCreated, initialPhone = '' }: { onClose: () => void; onCreated: (id: string, c: CustomerDTO) => void; initialPhone?: string }) {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [phone, setPhone] = useState(initialPhone);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const c = await api<CustomerDTO>('/customers', { method: 'POST', body: { outlet_id: outletId, phone, name: name.trim() || null, consent: true, marketing_opt_in: marketing } });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onCreated(c.id, c);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title="Add customer" footer={<Button block onClick={save} loading={busy} disabled={!consent || phone.replace(/\D/g, '').length < 10}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Phone">{(id) => <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoFocus placeholder="98765 43210" />}</Field>
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-sm">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 accent-[var(--brand)]" />
          <span>
            <span className="font-medium">I asked, and the customer agreed</span> to us saving their number for bills and loyalty points.
          </span>
        </label>
        <label className="flex cursor-pointer items-center gap-3 px-3 text-sm text-ink-soft">
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="size-4 accent-[var(--brand)]" />
          They also want offers by SMS or WhatsApp
        </label>
      </div>
    </Sheet>
  );
}
