'use client';

import { useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/api';
import { readStaffToken } from '@/lib/staff';

/** Loads data with the staff token, renders an 80 mm page and opens the print dialog. */
export function usePrintData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const token = readStaffToken();
    if (!token) return setError('Sign in first');
    apiFetch<T>(path, { token })
      .then(setData)
      .catch((err) => setError(errorMessage(err)));
  }, [path]);
  useEffect(() => {
    if (data) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [data]);
  return { data, error };
}

export function Receipt({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-[80mm] p-3 font-mono text-[12px] leading-snug">
      {children}
      <button onClick={() => window.print()} className="no-print mt-6 w-full cursor-pointer rounded-lg bg-black py-2 font-sans text-sm text-white">
        Print
      </button>
    </div>
  );
}

export const Rule = () => <div className="my-1.5 border-t border-dashed border-black" />;

export function Line({ left, right, bold }: { left: React.ReactNode; right: React.ReactNode; bold?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${bold ? 'font-bold' : ''}`}>
      <span>{left}</span>
      <span className="text-right whitespace-nowrap">{right}</span>
    </div>
  );
}
