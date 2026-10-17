'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, LifeBuoy } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { SupportCaseDTO } from '@mezmitra/shared/dto';
import { errorMessage } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Card, EmptyState, Spinner, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { NewCaseSheet, SEVERITY, STATUS, needsOutlet, targetWords, useHelpCases } from '@/components/staff/help';
import { PageHeader } from '@/components/staff/shell';

export default function HelpPage() {
  return (
    <Suspense fallback={null}>
      <Help />
    </Suspense>
  );
}

function Help() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('case');
  const { data, isLoading } = useHelpCases();
  const [asking, setAsking] = useState(false);
  const open = (id: string | null) => router.replace(id ? `/app/help?case=${id}` : '/app/help', { scroll: false });

  return (
    <div className="pb-8">
      <PageHeader
        title={t('help.title')}
        subtitle={t('help.page_hint')}
        actions={
          <Button onClick={() => setAsking(true)}>
            <LifeBuoy className="size-4" /> {t('help.ask')}
          </Button>
        }
      />
      <div className="grid gap-4 px-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:px-8">
        <div className={cn('space-y-2', selected && 'hidden lg:block')}>
          {isLoading && <Spinner />}
          {data?.length === 0 && <EmptyState icon={<LifeBuoy className="size-6" />} title={t('help.none')} hint={t('help.none_hint')} />}
          {data?.map((c) => (
            <button
              key={c.id}
              onClick={() => open(c.id)}
              className={cn(
                'block w-full cursor-pointer rounded-2xl border p-3 text-left transition active:scale-[0.99]',
                c.id === selected ? 'border-[var(--brand)] bg-brand-50' : 'border-line bg-surface hover:bg-stone-50',
              )}
            >
              <span className="flex items-center gap-2 text-xs text-ink-faint">
                <span className="tabular">#{c.number}</span>
                <span className={cn('rounded-full border px-2 py-0.5 font-medium', SEVERITY[c.severity].tone)}>{t(SEVERITY[c.severity].label)}</span>
                <span className="ml-auto">{ago(c.last_message_at)}</span>
              </span>
              <span className="mt-1 block truncate text-sm font-medium">{c.summary}</span>
              <span className={cn('block text-xs', needsOutlet(c) ? 'font-semibold text-rose-700' : 'text-ink-faint')}>{t(STATUS[c.status])}</span>
            </button>
          ))}
        </div>
        {selected ? (
          <CaseDetail id={selected} onBack={() => open(null)} />
        ) : (
          data &&
          data.length > 0 && (
            <Card className="hidden place-items-center p-10 text-sm text-ink-faint lg:grid">
              <p>{t('help.pick_case')}</p>
            </Card>
          )
        )}
      </div>
      <NewCaseSheet open={asking} onClose={() => setAsking(false)} onCreated={(c) => open(c.id)} />
    </div>
  );
}

/** One case: who owns it, where it stands, the conversation, and the outlet's next move. */
function CaseDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useI18n();
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [reply, setReply] = useState('');
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: c } = useQuery({
    queryKey: ['support', outletId, id],
    queryFn: () => api<SupportCaseDTO>(`/support/cases/${id}?outlet_id=${outletId}`),
  });
  if (!c) return <Spinner />;

  const act = async (path: string, body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    try {
      await api(`/support/cases/${id}/${path}`, { method: 'POST', body: { outlet_id: outletId, ...body } });
      await qc.invalidateQueries({ queryKey: ['support'] });
      setReply('');
      setReopening(false);
      if (done) toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const closed = c.status === 'closed';
  const resolved = c.status === 'resolved';
  const urgent = c.severity !== 'question';

  return (
    <Card className="overflow-hidden">
      <div className="space-y-2 border-b border-line p-4">
        <button onClick={onBack} className="-ml-1 flex cursor-pointer items-center gap-1 text-sm text-ink-soft lg:hidden">
          <ChevronLeft className="size-4" /> {t('help.back')}
        </button>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="tabular text-ink-faint">#{c.number}</span>
          <span className={cn('rounded-full border px-2 py-0.5 font-medium', SEVERITY[c.severity].tone)}>{t(SEVERITY[c.severity].label)}</span>
          <span className={cn('rounded-full px-2 py-0.5 font-semibold', needsOutlet(c) ? 'bg-rose-100 text-rose-800' : closed ? 'bg-stone-100 text-ink-soft' : 'bg-sky-100 text-sky-900')}>{t(STATUS[c.status])}</span>
        </div>
        <h2 className="text-lg font-semibold">{c.summary}</h2>
        <p className="text-sm text-ink-soft">{c.assignee_name ? t('help.owner', { name: c.assignee_name }) : t('help.no_owner', { target: targetWords(t, c.severity) })}</p>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-faint">
          <div>
            <dt className="inline">{t('help.raised')}: </dt>
            <dd className="inline">
              {dateTime(c.created_at)}
              {c.raised_by_name && ` · ${c.raised_by_name}`}
            </dd>
          </div>
          {c.first_response_at && (
            <div>
              <dt className="inline">{t('help.first_answer')}: </dt>
              <dd className="inline">{dateTime(c.first_response_at)}</dd>
            </div>
          )}
          {c.resumed_at && (
            <div>
              <dt className="inline">{t('help.resumed')}: </dt>
              <dd className="inline">{dateTime(c.resumed_at)}</dd>
            </div>
          )}
          {c.reopened > 0 && <div>{t('help.reopened_n', { n: c.reopened })}</div>}
        </dl>
      </div>

      <ol className="space-y-3 bg-stone-50/60 p-4" aria-label={t('help.thread')}>
        {(c.messages ?? []).map((m) =>
          m.author === 'system' ? (
            <li key={m.id} className="text-center text-xs text-ink-faint">
              {m.body} · {ago(m.created_at)}
            </li>
          ) : (
            <li key={m.id} className={cn('flex', m.author === 'outlet' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm', m.author === 'outlet' ? 'bg-[var(--brand)] text-white' : 'border border-line bg-surface')}>
                <p className={cn('mb-0.5 text-xs font-medium', m.author === 'outlet' ? 'text-white/80' : 'text-ink-faint')}>
                  {m.author === 'support' ? `${m.author_name ?? ''} · ${t('help.support')}` : m.author_name} · {ago(m.created_at)}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
            </li>
          ),
        )}
      </ol>

      <div className="space-y-3 border-t border-line p-4">
        {urgent && !c.resumed_at && !closed && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-950">
            <p className="min-w-0 flex-1">{t('help.running_again_hint')}</p>
            <Button size="sm" variant="success" disabled={busy} onClick={() => void act('resumed', {}, t('help.running_again_done'))}>
              {t('help.running_again')}
            </Button>
          </div>
        )}
        {(resolved || closed) && !reopening && (
          <div className="flex flex-wrap gap-2">
            {resolved && (
              <Button variant="success" disabled={busy} onClick={() => void act('close', {}, t('help.closed_toast'))}>
                {t('help.works')}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => setReopening(true)}>
              {t('help.not_working')}
            </Button>
          </div>
        )}
        {reopening && (
          <div className="space-y-2">
            <Textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('help.reopen_ph')} maxLength={4000} aria-label={t('help.not_working')} autoFocus />
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void act('reopen', { body: reply.trim() || null }, t('help.reopened'))}>
                {t('help.not_working')}
              </Button>
              <Button variant="ghost" onClick={() => setReopening(false)}>
                {t('help.cancel')}
              </Button>
            </div>
          </div>
        )}
        {!closed && !reopening && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (reply.trim()) void act('messages', { body: reply.trim() });
            }}
          >
            <Textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('help.reply_ph')} maxLength={4000} aria-label={t('help.reply_ph')} className="min-h-11 flex-1" rows={1} />
            <Button type="submit" disabled={busy || !reply.trim()}>
              {t('help.send_reply')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
