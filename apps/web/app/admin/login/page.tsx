'use client';

import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/api';
import { writeLocal } from '@/lib/storage';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/primitives';

export default function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ token: string }>('/admin/auth/login', { method: 'POST', body: { email, password } });
      writeLocal('dineos.admin.token', res.token);
      router.replace('/admin');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <main className="grid min-h-dvh place-items-center bg-stone-900 p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl bg-surface p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-6 text-[var(--brand)]" />
          <h1 className="text-xl font-semibold">DineOS platform admin</h1>
        </div>
        <Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />}</Field>
        {error && <p className="text-sm text-rose-700">{error}</p>}
        <Button type="submit" block loading={busy}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
