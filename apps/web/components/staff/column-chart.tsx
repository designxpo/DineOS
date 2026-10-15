'use client';

import { useState } from 'react';
import { cn } from '@/components/ui/cn';

export interface Column {
  key: string;
  label: string;
  value: number;
  /** Tooltip / table text for the value. */
  display: string;
}

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Single-series column chart: one hue, columns at most 24px wide with 4px rounded caps,
 * hairline gridlines, compact ticks, a tooltip per column and a table view for screen readers.
 */
export function ColumnChart({
  data,
  title,
  height = 180,
  tickFormat = (v: number) => compact.format(v),
}: {
  data: Column[];
  title: string;
  height?: number;
  tickFormat?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const ticks = [0, max / 2, max];

  return (
    <figure>
      <div className="mb-2 flex items-center justify-between">
        <figcaption className="text-sm font-semibold text-ink">{title}</figcaption>
        <button onClick={() => setTable((t) => !t)} className="cursor-pointer text-xs text-ink-faint underline-offset-2 hover:underline">
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {table ? (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {data.map((d) => (
              <tr key={d.key}>
                <td className="py-1.5 text-ink-soft">{d.label}</td>
                <td className="py-1.5 text-right tabular">{d.display}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="flex gap-2" aria-hidden={false}>
          <div className="flex flex-col justify-between pb-6 text-right text-[11px] text-ink-faint tabular" style={{ height }}>
            {[...ticks].reverse().map((t) => (
              <span key={t} className="-translate-y-1/2 leading-none first:translate-y-0 last:translate-y-0">
                {tickFormat(t)}
              </span>
            ))}
          </div>
          <div className="relative flex-1" style={{ height }}>
            <div className="absolute inset-x-0 top-0 bottom-6">
              {ticks.map((t) => (
                <div key={t} className="absolute inset-x-0 h-px bg-line" style={{ bottom: `${(t / max) * 100}%` }} />
              ))}
              <div className="absolute inset-0 flex items-end gap-[2px]" role="list" aria-label={title}>
                {data.map((d, i) => (
                  <div
                    key={d.key}
                    role="listitem"
                    aria-label={`${d.label}: ${d.display}`}
                    tabIndex={0}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="relative flex h-full flex-1 items-end justify-center outline-none"
                  >
                    <div
                      className={cn('w-full max-w-6 rounded-t-[4px] bg-brand-500 transition-opacity', hover !== null && hover !== i && 'opacity-40')}
                      style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? 2 : 0 }}
                    />
                    {hover === i && (
                      <div className="pointer-events-none absolute bottom-full z-10 mb-1 rounded-lg bg-ink px-2 py-1 text-xs whitespace-nowrap text-white shadow-[var(--shadow-pop)]">
                        <span className="text-white/70">{d.label}</span> · <span className="font-semibold tabular">{d.display}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 flex h-5 gap-[2px] text-[10px] text-ink-faint">
              {data.map((d, i) => (
                <span key={d.key} className="flex-1 text-center">
                  {i % Math.ceil(data.length / 8) === 0 ? d.label : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </figure>
  );
}
