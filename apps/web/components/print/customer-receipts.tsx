'use client';

import { useEffect, useRef, useState } from 'react';
import { apiBase, apiFetch, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { AnimatedReceiptPrinter } from './animated-receipt-printer';
import { BillReceipt, type PrintableInvoice } from './bill-receipt';

/** Guest credentials or an unguessable tracking link; never uses the staff token. */
export function CustomerReceipts({ path, token }: { path: string; token?: string | null }) {
  const [invoices, setInvoices] = useState<PrintableInvoice[]>([]);
  const [preview, setPreview] = useState<PrintableInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef(true);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; controller.current?.abort(); };
  }, []);
  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      controller.current = new AbortController();
      const data = await apiFetch<PrintableInvoice[]>(path, { token, signal: controller.current.signal });
      if (!active.current) return;
      setInvoices(data);
      setPreview(data[0] ?? null);
      if (!data.length) setMessage('Your bill will be available here once the restaurant finalises it. Please try again shortly.');
    } catch (error) { if (active.current) setMessage(errorMessage(error)); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  const download = async (invoice: PrintableInvoice) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    controller.current = new AbortController();
    try {
      const response = await fetch(`${apiBase()}/v1${path}?format=pdf&bill_id=${encodeURIComponent(invoice.bill.id)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.current.signal,
      });
      if (!response.ok) throw new Error('The bill could not be downloaded. Please try again.');
      const blob = await response.blob();
      if (!active.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bill-${(invoice.bill.invoice_no ?? invoice.bill.id).replace(/[^\w-]/g, '-')}.pdf`;
      document.body.append(link);
      link.click();
      link.remove();
      // Give browsers time to consume the object URL before releasing it.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (active.current) setMessage(errorMessage(error)); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  return (
    <section className="mt-4 space-y-3 rounded-2xl border border-line bg-surface p-4" aria-label="Your bills">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Your bill</h3>
        <Button variant="outline" loading={busy} onClick={() => void load()}>View bill</Button>
      </div>
      {message && <p role="status" className="text-sm text-ink-soft">{message}</p>}
      {invoices.map((invoice) => (
        <div key={invoice.bill.id} className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => setPreview(invoice)}>{invoice.bill.invoice_no ?? 'Receipt'}{invoice.bill.split_label ? ` · ${invoice.bill.split_label}` : ''}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void download(invoice)}>Download PDF</Button>
        </div>
      ))}
      {preview && <AnimatedReceiptPrinter key={preview.bill.id} onDismiss={() => setPreview(null)}><BillReceipt data={preview} /></AnimatedReceiptPrinter>}
    </section>
  );
}
