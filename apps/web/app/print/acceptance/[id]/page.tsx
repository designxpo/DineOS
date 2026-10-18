'use client';

import { useParams } from 'next/navigation';
import { GOLIVE_TEXT } from '@mezmitra/shared/golive';
import type { GoliveRehearsalDTO } from '@mezmitra/shared/dto';
import { usePrintData } from '@/components/print/receipt';
import { goliveMeasures } from '@/components/staff/golive';

const RESULT = { passed: 'Passed', failed: 'Failed', out_of_scope: 'Out of scope' } as const;
// A signed record: dates carry the year.
const dateTime = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

/** The go-live acceptance sheet on A4: what was run, what passed, what is out of scope, who signed. */
export default function PrintAcceptance() {
  const { id } = useParams<{ id: string }>();
  const { data: r, error } = usePrintData<GoliveRehearsalDTO>(`/golive/${id}`);
  if (error) return <p className="p-6">{error}</p>;
  if (!r) return <p className="p-6">Loading…</p>;
  const m = goliveMeasures(r);
  return (
    <div className="mx-auto max-w-[190mm] p-8 text-[12.5px] leading-relaxed">
      {/* This page is A4, unlike the 80 mm receipts. */}
      <style>{'@media print { @page { size: A4; margin: 14mm; } }'}</style>
      <header className="flex items-start justify-between gap-6 border-b border-black pb-3">
        <div>
          <p className="text-[11px] tracking-wide uppercase">Go-live acceptance sheet</p>
          <h1 className="text-xl font-bold">{r.tenant_name}</h1>
          <p>{r.outlet_name}</p>
        </div>
        <img src="/brand/logo.svg" alt="Mezmitra" className="h-10 w-auto" />
      </header>
      {!r.signed_at && <p className="mt-3 border border-black px-3 py-2 font-bold">DRAFT: not signed yet.</p>}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1">
        <dt className="text-neutral-600">Rehearsal started</dt>
        <dd>
          {dateTime(r.started_at)}
          {r.started_by_name && ` by ${r.started_by_name}`}
        </dd>
        <dt className="text-neutral-600">Signed</dt>
        <dd>{r.signed_at ? `${dateTime(r.signed_at)} by ${r.signer_name}` : '—'}</dd>
        <dt className="text-neutral-600">Set up in Mezmitra to sign-off</dt>
        <dd>{m.setupHours} hours</dd>
        <dt className="text-neutral-600">Passed first time</dt>
        <dd>
          {m.firstTime} of {m.passed} passed
          {m.outOfScope ? `; ${m.outOfScope} agreed out of scope` : ''}
        </dd>
      </dl>

      <table className="mt-5 w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-black text-[11px] uppercase">
            <th className="py-1.5 pr-2">#</th>
            <th className="py-1.5 pr-2">Scenario</th>
            <th className="py-1.5 pr-2">Result</th>
            <th className="py-1.5">What Mezmitra saw, and notes</th>
          </tr>
        </thead>
        <tbody>
          {r.checks.map((c, i) => (
            <tr key={c.scenario} className="border-b border-neutral-300 align-top [break-inside:avoid]">
              <td className="py-2 pr-2">{i + 1}</td>
              <td className="py-2 pr-2">
                <p className="font-semibold">{GOLIVE_TEXT[c.scenario].title}</p>
                <p className="text-[11px] text-neutral-600">Passes when: {GOLIVE_TEXT[c.scenario].pass}</p>
              </td>
              <td className="py-2 pr-2 font-semibold whitespace-nowrap">
                {c.result ? RESULT[c.result] : '—'}
                {c.failures > 0 && <span className="block text-[11px] font-normal">after {c.failures} failed {c.failures === 1 ? 'try' : 'tries'}</span>}
              </td>
              <td className="py-2">
                {/* A pass Mezmitra did not see rests on the staff's own check, and says so. */}
                {!c.evidence.seen && <p className="font-semibold">{c.result === 'passed' ? 'Checked by staff; not seen by Mezmitra.' : 'Not seen by Mezmitra.'}</p>}
                {c.evidence.lines.map((l) => (
                  <p key={l}>{l}</p>
                ))}
                {c.note && <p className="italic">Note: {c.note}</p>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {r.devices.length > 0 && (
        <section className="mt-5 [break-inside:avoid]">
          <h2 className="font-bold">Devices used</h2>
          <ul className="mt-1 list-disc pl-5">
            {r.devices.map((d, i) => (
              <li key={i}>
                {d.name}
                {d.kind === 'print_computer' ? ' (print computer)' : ''}
                {d.detail ? `: ${d.detail}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6 border-t border-black pt-3 [break-inside:avoid]">
        <p>
          The scenarios marked passed were run on the restaurant’s own devices and worked. Those out of scope are agreed as not part of this go-live. Full payment starts from the date signed.
        </p>
        <p className="mt-4">
          {r.signed_at ? (
            <>
              Signed electronically in Mezmitra by <span className="font-semibold">{r.signer_name}</span> on {dateTime(r.signed_at)}.
            </>
          ) : (
            'Owner’s signature: ______________________   Date: ____________'
          )}
        </p>
      </section>
      <button onClick={() => window.print()} className="no-print mt-8 cursor-pointer rounded-lg bg-black px-4 py-2 text-sm text-white">
        Print
      </button>
    </div>
  );
}
