// Small, faithful pictures of the product at the moment each promise is kept: the same words and
// colours the screens use, with tidy example data.

import { BellRing, Check, CircleAlert, Gift, LifeBuoy, Printer, ReceiptIndianRupee, ServerCog, Users, WifiOff } from 'lucide-react';
import { cn } from '@/components/ui/cn';

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('rounded-2xl border border-line bg-surface p-4 shadow-[0_18px_40px_-20px_rgb(28_25_23/0.35)]', className)}>{children}</div>;
}

function Toast({ icon: Icon, tone, title, body, meta }: { icon: React.ComponentType<{ className?: string }>; tone: string; title: string; body: string; meta: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface p-3 shadow-sm">
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', tone)}>
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="text-sm text-ink-soft">{body}</p>
        <p className="mt-0.5 text-xs text-ink-faint">{meta}</p>
      </div>
    </div>
  );
}

/** Nothing slips: the right person hears about the right table. */
export function ServiceAlerts() {
  return (
    <Panel className="space-y-2.5 bg-stone-50">
      <Toast icon={BellRing} tone="bg-emerald-100 text-emerald-800" title="Bar · Table C4" body="2 Cold Coffee ready to serve" meta="Sent to Ravi, the table's waiter · just now" />
      <Toast icon={Users} tone="bg-sky-100 text-sky-800" title="Floor · Table P2" body="Guests waiting 5 min and nobody has seated them" meta="Floor staff alerted" />
      <Toast icon={ReceiptIndianRupee} tone="bg-violet-100 text-violet-800" title="Table C7 asked for the bill" body="From the guest's phone · ₹2,340" meta="Cashier and Ravi alerted" />
      <Toast icon={Printer} tone="bg-rose-100 text-rose-800" title="Kitchen ticket #142 did not print" body="The tandoor printer did not respond" meta="Showing on every screen until it is reprinted" />
    </Panel>
  );
}

function Line({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'rose' | 'amber' | 'green' }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        {note && <p className="text-xs text-ink-faint">{note}</p>}
      </div>
      <span
        className={cn(
          'shrink-0 rounded-md px-2 py-0.5 text-sm font-semibold tabular',
          tone === 'rose' ? 'bg-rose-50 text-rose-700' : tone === 'amber' ? 'bg-amber-50 text-amber-800' : tone === 'green' ? 'bg-emerald-50 text-emerald-800' : 'text-ink',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Every rupee explained: the day-end page, with what needs a look first. */
export function DayEnd() {
  return (
    <Panel>
      <div className="flex items-baseline justify-between border-b border-line pb-3">
        <p className="font-display text-lg font-semibold">Day end · Saturday</p>
        <p className="text-sm text-ink-faint">86 bills</p>
      </div>
      <div className="divide-y divide-line">
        <Line label="Cash expected in the drawer" value="₹18,450" note="Cash bills and wallet top-ups, less cash refunds" />
        <Line label="UPI not in your bank statement" value="2 · ₹2,310" note="Table 7 · ₹1,240 and Takeaway #31 · ₹1,070" tone="rose" />
        <Line label="Served, never billed" value="C9 · ₹940" note="Flagged at 11:12 pm, before the table left" tone="amber" />
        <Line label="Given free" value="4 · ₹980" note="Mishap made right ×2 · Celebration ×2 · approved by Arjun" />
        <Line label="Invoices" value="AGC/000141–226" note="No gaps · 1 voided, number kept" tone="green" />
      </div>
    </Panel>
  );
}

/** Service continues: the outlet hub while the internet is down. */
export function Outage() {
  return (
    <Panel className="space-y-3">
      <div className="flex items-center gap-3 rounded-xl bg-amber-50 px-3 py-2.5 text-amber-950">
        <WifiOff className="size-5 shrink-0" />
        <div>
          <p className="text-sm font-semibold">Internet is down. You are running on the outlet hub.</p>
          <p className="text-xs">Orders, kitchen tickets, bills and printing carry on.</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ['14', 'orders'],
          ['31', 'tickets printed'],
          ['9', 'bills'],
        ].map(([n, l]) => (
          <div key={l} className="rounded-xl bg-stone-50 py-3">
            <p className="font-display text-2xl font-semibold tabular">{n}</p>
            <p className="text-xs text-ink-faint">{l}</p>
          </div>
        ))}
      </div>
      <p className="flex items-center gap-2 text-sm text-ink-soft">
        <ServerCog className="size-4 text-ink-faint" /> Saved on the counter PC · sends everything when the internet is back
      </p>
    </Panel>
  );
}

/** Helped until it is fixed: a help case the outlet can follow. */
export function HelpCase() {
  return (
    <Panel className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="tabular text-ink-faint">#1042</span>
        <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 font-medium text-rose-900">Service has stopped</span>
        <span className="rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-900">Support is working on it</span>
      </div>
      <p className="font-semibold">Bills are not printing at the counter</p>
      <p className="flex items-center gap-2 text-sm text-ink-soft">
        <LifeBuoy className="size-4 text-ink-faint" /> Asha from Mezmitra support is handling this · first answer in 4 min
      </p>
      <div className="space-y-2 rounded-xl bg-stone-50 p-3 text-sm">
        <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-[var(--brand)] px-3 py-2 text-white">The counter printer stopped at 8 pm.</p>
        <p className="w-fit max-w-[85%] rounded-2xl border border-line bg-surface px-3 py-2">Switched it to the backup printer. Try a bill now?</p>
        <p className="text-center text-xs text-ink-faint">The outlet says service is running again · 8:52 pm</p>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-emerald-800">
        <Check className="size-3.5" /> Closes only when you confirm it works
      </p>
    </Panel>
  );
}

/** Free food with a name on it. */
export function FreeItem() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-sm shadow-sm">
      <span className="grid size-9 place-items-center rounded-lg bg-emerald-100 text-emerald-800">
        <Gift className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Gulab Jamun · given free</p>
        <p className="text-xs text-ink-faint">Celebration · by Ravi · approved by Arjun with his PIN</p>
      </div>
      <span className="text-xs font-semibold tabular text-ink-soft">₹180</span>
    </div>
  );
}

export function UpiMissing() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-rose-200 bg-surface p-3 text-sm shadow-sm">
      <span className="grid size-9 place-items-center rounded-lg bg-rose-100 text-rose-800">
        <CircleAlert className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">UPI ₹1,240 · Table 7</p>
        <p className="text-xs text-ink-faint">Not in your bank statement · confirmed by Priya at 9:15 pm</p>
      </div>
    </div>
  );
}
