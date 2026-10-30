'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, ClipboardCheck, FileSignature, Printer, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { GOLIVE_SCENARIOS, GOLIVE_TEXT, type GoliveResult } from '@mezmitra/shared/golive';
import type { GoliveCheckDTO, GoliveRehearsalDTO } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Badge, Card, Field, Input, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

const RESULT: Record<GoliveResult, { label: string; tone: 'green' | 'rose' | 'neutral' }> = {
  passed: { label: 'Passed', tone: 'green' },
  failed: { label: 'Failed', tone: 'rose' },
  out_of_scope: { label: 'Out of scope', tone: 'neutral' },
};

/** Figures the plan tracks: hours from setup to sign-off, and scenarios passed first time. */
export function goliveMeasures(r: GoliveRehearsalDTO) {
  const end = r.signed_at ? Date.parse(r.signed_at) : Date.now();
  const passed = r.checks.filter((c) => c.result === 'passed');
  return {
    setupHours: Math.max(0, Math.round((end - Date.parse(r.outlet_created_at)) / 3_600_000)),
    rehearsalHours: Math.max(0, Math.round(((end - Date.parse(r.started_at)) / 3_600_000) * 10) / 10),
    firstTime: passed.filter((c) => c.failures === 0).length,
    passed: passed.length,
    outOfScope: r.checks.filter((c) => c.result === 'out_of_scope').length,
  };
}

/**
 * The go-live rehearsal in Settings: the restaurant's hardest moments, run on its own devices,
 * each marked with what Mezvaan saw; the owner signs the acceptance sheet at the end.
 */
export function GoliveRehearsal() {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['golive', outletId],
    queryFn: () => api<GoliveRehearsalDTO | null>(`/golive?outlet_id=${outletId}`),
    // What Mezvaan sees updates as the team works through the scenarios.
    refetchInterval: (q) => (q.state.data && !q.state.data.signed_at ? 15_000 : false),
  });
  const set = (r: GoliveRehearsalDTO) => qc.setQueryData(['golive', outletId], r);
  const start = async () => {
    setBusy(true);
    try {
      set(await api<GoliveRehearsalDTO>('/golive', { method: 'POST', body: { outlet_id: outletId } }));
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <Spinner />;
  if (!data) {
    return (
      <Card className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-[var(--brand)]">
            <ClipboardCheck className="size-5" />
          </span>
          <div>
            <h2 className="font-semibold">Rehearse before you go live</h2>
            <p className="mt-1 text-sm text-ink-soft">
              Run your restaurant’s hardest moments on your own phones, tablets and printers, with your cashier. Mezvaan shows what it saw for each. When everything you need has passed, the owner signs the acceptance sheet, and full payment starts after that.
            </p>
          </div>
        </div>
        <ol className="grid gap-1.5 text-sm sm:grid-cols-2">
          {GOLIVE_SCENARIOS.map((s, i) => (
            <li key={s} className="flex gap-2">
              <span className="w-5 text-ink-faint tabular">{i + 1}.</span>
              {GOLIVE_TEXT[s].title}
            </li>
          ))}
        </ol>
        <Button onClick={() => void start()} loading={busy}>
          Start the rehearsal
        </Button>
      </Card>
    );
  }
  if (data.signed_at) return <Signed r={data} onRestart={() => void start()} busy={busy} />;

  const marked = data.checks.filter((c) => c.result).length;
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Go-live rehearsal</h2>
          <p className="text-sm text-ink-soft">
            Started {dateTime(data.started_at)}
            {data.started_by_name && ` by ${data.started_by_name}`}. Mezvaan counts what happens from then on.
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tabular">
            {marked}/{data.checks.length}
          </p>
          <p className="text-xs text-ink-faint">marked</p>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100">
          <div className="h-full rounded-full bg-[var(--brand)] transition-[width]" style={{ width: `${(marked / data.checks.length) * 100}%` }} />
        </div>
      </Card>
      <ol className="space-y-3">
        {data.checks.map((c, i) => (
          <ScenarioCard key={c.scenario} n={i + 1} c={c} rehearsalId={data.id} onChange={set} />
        ))}
      </ol>
      <SignCard r={data} onSigned={set} />
    </div>
  );
}

function ScenarioCard({ n, c, rehearsalId, onChange }: { n: number; c: GoliveCheckDTO; rehearsalId: string; onChange: (r: GoliveRehearsalDTO) => void }) {
  const { api } = useStaff();
  const toast = useToast();
  const [asking, setAsking] = useState<'failed' | 'out_of_scope' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const text = GOLIVE_TEXT[c.scenario];
  const send = async (result: GoliveResult, withNote?: string) => {
    setBusy(true);
    try {
      onChange(await api<GoliveRehearsalDTO>(`/golive/${rehearsalId}/checks/${c.scenario}`, { method: 'PUT', body: { result, note: withNote ?? null } }));
      setAsking(null);
      setNote('');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <Card className={cn('space-y-3 p-4', c.result === 'failed' && 'border-rose-200')}>
        <div className="flex flex-wrap items-start gap-2">
          <span className="w-6 pt-0.5 text-sm text-ink-faint tabular">{n}.</span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{text.title}</h3>
            <p className="mt-0.5 text-sm text-ink-soft">{text.how}</p>
            <p className="mt-1 text-sm">
              <span className="font-medium">Passes when:</span> {text.pass}
            </p>
          </div>
          {c.result && <Badge tone={RESULT[c.result].tone}>{RESULT[c.result].label}</Badge>}
        </div>
        <div className={cn('ml-8 rounded-xl px-3 py-2 text-sm', c.evidence.seen ? 'bg-emerald-50 text-emerald-950' : 'bg-stone-50 text-ink-soft')}>
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
            {c.evidence.seen ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
            {c.evidence.seen ? 'Mezvaan saw it' : 'Not seen yet'}
          </p>
          {c.evidence.lines.map((l) => (
            <p key={l} className="mt-0.5">
              {l}
            </p>
          ))}
        </div>
        {c.note && <p className="ml-8 text-sm text-ink-soft">Note: {c.note}</p>}
        {c.result === 'passed' && !c.evidence.seen && <p className="ml-8 text-xs text-ink-faint">Marked passed without Mezvaan seeing it: the sheet will say it was checked by staff.</p>}
        {(c.checked_by_name || c.failures > 0) && (
          <p className="ml-8 text-xs text-ink-faint">
            {c.checked_by_name && `Marked by ${c.checked_by_name}${c.checked_at ? `, ${dateTime(c.checked_at)}` : ''}`}
            {c.result === 'failed' ? c.failures > 1 && ` · failed ${c.failures} times` : c.failures > 0 && ` · after ${c.failures} failed ${c.failures === 1 ? 'try' : 'tries'}`}
          </p>
        )}
        {asking ? (
          <div className="ml-8 flex flex-wrap items-end gap-2">
            <Field label={asking === 'failed' ? 'What went wrong?' : 'Why is this not part of this go-live?'} className="min-w-60 flex-1">
              {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus />}
            </Field>
            <Button onClick={() => void send(asking, note.trim())} disabled={!note.trim()} loading={busy}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Back
            </Button>
          </div>
        ) : (
          <div className="ml-8 flex flex-wrap gap-2">
            <Button variant={c.result === 'passed' ? 'primary' : 'outline'} onClick={() => void send('passed')} loading={busy && !asking}>
              Passed
            </Button>
            <Button variant="outline" onClick={() => setAsking('failed')}>
              Failed
            </Button>
            <Button variant="ghost" onClick={() => setAsking('out_of_scope')}>
              Out of scope
            </Button>
          </div>
        )}
      </Card>
    </li>
  );
}

function SignCard({ r, onSigned }: { r: GoliveRehearsalDTO; onSigned: (r: GoliveRehearsalDTO) => void }) {
  const { api, me } = useStaff();
  const toast = useToast();
  const owner = me.tenant_roles.includes('owner');
  const [name, setName] = useState(me.user.name);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const failed = r.checks.filter((c) => c.result === 'failed').length;
  const left = r.checks.filter((c) => !c.result).length;
  const sign = async () => {
    setBusy(true);
    try {
      onSigned(await api<GoliveRehearsalDTO>(`/golive/${r.id}/sign`, { method: 'POST', body: { signer_name: name.trim(), confirm } }));
      toast('Acceptance sheet signed');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <FileSignature className="size-4" /> Acceptance sheet
      </h2>
      {!r.ready ? (
        <p className="text-sm text-ink-soft">
          {left > 0 && `${left} scenario${left === 1 ? '' : 's'} still to mark. `}
          {failed > 0 && `${failed} failed: run ${failed === 1 ? 'it' : 'them'} again until ${failed === 1 ? 'it passes' : 'they pass'}, or agree to leave ${failed === 1 ? 'it' : 'them'} out. `}
          The owner signs once every scenario passed or was agreed out of scope.
        </p>
      ) : owner ? (
        <>
          <p className="text-sm text-ink-soft">Everything is marked. Signing keeps the sheet exactly as it is now, with the devices you used.</p>
          <Field label="Your name, as signed" className="max-w-sm">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />}
          </Field>
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 size-4 accent-[var(--brand)]" />
            <span>We ran these scenarios on our own devices. What is marked passed worked; what is out of scope is agreed.</span>
          </label>
          <Button onClick={() => void sign()} disabled={!confirm || name.trim().length < 2} loading={busy}>
            Sign the acceptance sheet
          </Button>
        </>
      ) : (
        <p className="text-sm text-ink-soft">Everything is marked. Ask the owner to sign it here.</p>
      )}
    </Card>
  );
}

function Signed({ r, onRestart, busy }: { r: GoliveRehearsalDTO; onRestart: () => void; busy: boolean }) {
  const m = goliveMeasures(r);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
          <CheckCircle2 className="size-5" />
        </span>
        <div>
          <h2 className="font-semibold">Go-live accepted</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Signed by {r.signer_name} on {dateTime(r.signed_at!)}. {m.passed} scenario{m.passed === 1 ? '' : 's'} passed ({m.firstTime} first time){m.outOfScope ? `, ${m.outOfScope} agreed out of scope` : ''}.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={`/print/acceptance/${r.id}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-xl border border-line px-3.5 text-sm font-medium hover:bg-stone-50">
          <Printer className="size-4" /> Open the acceptance sheet
        </a>
        <Button variant="ghost" onClick={onRestart} loading={busy}>
          <RotateCcw className="size-4" /> Rehearse again
        </Button>
      </div>
    </Card>
  );
}
