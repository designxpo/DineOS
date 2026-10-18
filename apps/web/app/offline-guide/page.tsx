import type { Metadata } from 'next';
import { ArrowLeft, Check, Clock } from 'lucide-react';
import { OFFLINE_CHECKLIST, OFFLINE_LEVELS } from '@mezmitra/shared/offline';

export const metadata: Metadata = {
  title: 'When the internet drops',
  description: 'Exactly what keeps working in Mezmitra when a restaurant’s internet goes down, what waits for the line, and what to do.',
};

/** The published offline list: what keeps working, what waits, and the recovery steps. */
export default function OfflineGuide() {
  return (
    <div data-marketing className="min-h-dvh bg-paper text-ink">
      <header className="border-b border-line/70">
        <nav className="mx-auto flex h-16 max-w-4xl items-center gap-4 px-4 sm:px-6" aria-label="Main">
          <a href="/" className="flex shrink-0 items-center" aria-label="Mezmitra, home">
            <img src="/brand/wordmark.svg" alt="Mezmitra" className="h-7 w-auto" width={166} height={44} />
          </a>
          <a href="/#demo" className="ml-auto inline-flex h-10 items-center rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-white transition hover:brightness-110">
            Book a demo
          </a>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-14 sm:px-6 sm:py-20">
        <p className="text-sm font-semibold tracking-wide text-[var(--brand)] uppercase">Offline, plainly</p>
        <h1 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">When the internet drops</h1>
        <p className="mt-5 max-w-2xl text-lg text-ink-soft">
          What keeps working in Mezmitra, what waits for the line to come back, and what your team does. We rehearse this with you, internet unplugged, before you go live.
        </p>

        <div className="mt-12 space-y-6">
          {OFFLINE_LEVELS.map((l) => (
            <section key={l.id} className="rounded-3xl border border-line bg-surface p-6 sm:p-8">
              <h2 className="font-display text-2xl font-semibold">{l.title.en}</h2>
              <p className="mt-2 text-ink-soft">{l.summary.en}</p>
              <div className="mt-6 grid gap-6 md:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold tracking-wide text-emerald-800 uppercase">Keeps working</h3>
                  <ul className="mt-3 space-y-2.5">
                    {l.works.map((w) => (
                      <li key={w.en} className="flex gap-2.5">
                        <Check className="mt-0.5 size-4 shrink-0 text-emerald-700" />
                        {w.en}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-semibold tracking-wide text-ink-faint uppercase">Waits for the internet</h3>
                  <ul className="mt-3 space-y-2.5 text-ink-soft">
                    {l.waits.map((w) => (
                      <li key={w.en} className="flex gap-2.5">
                        <Clock className="mt-0.5 size-4 shrink-0 text-ink-faint" />
                        {w.en}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ))}
        </div>

        <section className="mt-12">
          <h2 className="font-display text-2xl font-semibold">What your team does</h2>
          <ol className="mt-4 list-decimal space-y-2.5 pl-6 text-ink-soft">
            {OFFLINE_CHECKLIST.map((c) => (
              <li key={c.en}>{c.en}</li>
            ))}
          </ol>
          <p className="mt-6 text-sm text-ink-faint">Every change made offline carries its own key, so a change that is sent again is never counted twice.</p>
        </section>

        <a href="/" className="mt-12 inline-flex items-center gap-2 text-sm font-medium text-ink-soft hover:text-ink">
          <ArrowLeft className="size-4" /> Back to Mezmitra
        </a>
      </main>
    </div>
  );
}
