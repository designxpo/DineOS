'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { PlanCheckoutDTO, PlanOfferDTO, PlansPageDTO } from '@mezmitra/shared/dto';
import { ALL_PLANS_INCLUDE, PLAN_LINES, type PlanFeatures } from '@mezmitra/shared/plans';
import { errorMessage } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { Forbidden, PageHeader } from '@/components/staff/shell';

// Plans: what each one includes, and a self-serve upgrade paid with Razorpay. The price shown is the
// one the server charges; the plan changes only after the server has checked the payment.

interface RazorpayCheckout {
  open(): void;
  on(event: 'payment.failed', handler: (r: { error?: { description?: string } }) => void): void;
}
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayCheckout;
declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

const CHECKOUT_JS = 'https://checkout.razorpay.com/v1/checkout.js';

function loadCheckout(): Promise<RazorpayCtor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_JS;
    script.async = true;
    script.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay did not load')));
    script.onerror = () => reject(new Error('Could not load Razorpay. Check your connection and try again.'));
    document.body.appendChild(script);
  });
}

const per = (p: { billing_period: 'monthly' | 'yearly' }) => (p.billing_period === 'yearly' ? 'year' : 'month');
const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

function featureLine(line: (typeof PLAN_LINES)[number], f: PlanFeatures): { on: boolean; text: string } {
  const v = f[line.key];
  if (line.kind === 'count') {
    if (typeof v !== 'number') return { on: true, text: `${line.label}: no limit` };
    return { on: v > 0, text: `${line.label}: up to ${v}` };
  }
  return { on: v === true, text: line.label };
}

export default function PlanPage() {
  const { me, api } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [chosen, setChosen] = useState<PlanOfferDTO | null>(null);
  const [paying, setPaying] = useState(false);
  const owner = me.tenant_roles.includes('owner');
  const { data, isLoading } = useQuery({ queryKey: ['plans'], enabled: owner, queryFn: () => api<PlansPageDTO>('/plans') });
  if (!owner) return <Forbidden />;
  if (isLoading || !data) return <Spinner />;
  const current = data.plans.find((p) => p.current);

  async function upgrade(plan: PlanOfferDTO) {
    setPaying(true);
    try {
      const order = await api<PlanCheckoutDTO>('/plan/checkout', { method: 'POST', body: { plan_code: plan.code } });
      const Razorpay = await loadCheckout();
      const checkout = new Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount_paise,
        currency: order.currency,
        name: 'Mezmitra',
        description: `${order.plan_name} plan for ${order.business_name}`,
        prefill: { name: order.prefill.name ?? undefined, email: order.prefill.email ?? undefined, contact: order.prefill.contact ?? undefined },
        theme: { color: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || undefined },
        handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          try {
            const page = await api<PlansPageDTO>('/plan/confirm', { method: 'POST', body: r });
            qc.setQueryData(['plans'], page);
            // Plan features change what the rest of the app shows (brand, Talko AI, limits).
            await qc.invalidateQueries();
            setChosen(null);
            toast(`You're on ${page.current.name}`);
          } catch (err) {
            // Paid but not confirmed yet: Razorpay's webhook finishes the upgrade.
            toast(errorMessage(err), 'error');
            await qc.invalidateQueries({ queryKey: ['plans'] });
          } finally {
            setPaying(false);
          }
        },
        modal: { ondismiss: () => setPaying(false) },
      });
      checkout.on('payment.failed', (r) => toast(r.error?.description ?? 'The payment did not go through', 'error'));
      checkout.open();
    } catch (err) {
      toast(errorMessage(err), 'error');
      setPaying(false);
    }
  }

  return (
    <div className="pb-12">
      <PageHeader title="Plan" subtitle="What each plan includes. Upgrade here and pay online; the new plan starts as soon as the payment goes through." />
      <div className="max-w-5xl space-y-6 px-4 lg:px-8">
        <Card className="space-y-3 p-5">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-semibold">You&apos;re on {data.current.name}</h2>
            <span className="text-sm text-ink-soft">
              {data.current.price_paise ? `${formatPaise(data.current.price_paise)} a ${per(data.current)}` : 'Free'}
              {data.current.period_end && ` · current period ends ${day(data.current.period_end)}`}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Usage label="Outlets" used={data.current.usage.outlets} max={data.current.features.max_outlets} />
            <Usage label="Tables" used={data.current.usage.tables} max={data.current.features.max_tables} />
          </div>
          {data.last_failed && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950">
              Your last payment for {data.last_failed.plan_name} did not go through: {data.last_failed.error}
            </p>
          )}
        </Card>

        <div className="grid gap-4 md:grid-cols-3">
          {data.plans.map((plan) => (
            <Card key={plan.code} className={cn('flex flex-col gap-4 p-5', plan.current && 'ring-2 ring-[var(--brand)]')}>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-xl font-semibold">{plan.name}</h3>
                  {plan.current && <Badge tone="brand">Current</Badge>}
                </div>
                <p className="mt-1 text-2xl font-semibold">
                  {plan.price_paise ? formatPaise(plan.price_paise) : 'Free'}
                  {plan.price_paise > 0 && <span className="text-sm font-normal text-ink-soft"> / {per(plan)}</span>}
                </p>
              </div>
              <ul className="flex-1 space-y-2 text-sm">
                {PLAN_LINES.map((line) => {
                  const l = featureLine(line, plan.features);
                  return (
                    <li key={line.key} className={cn('flex gap-2', !l.on && 'text-ink-faint')}>
                      {l.on ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <Minus className="mt-0.5 size-4 shrink-0" />}
                      {l.text}
                    </li>
                  );
                })}
              </ul>
              {plan.current ? (
                <p className="text-sm text-ink-faint">Your plan</p>
              ) : plan.upgrade && data.online_payment ? (
                <Button onClick={() => setChosen(plan)} disabled={paying}>
                  Upgrade to {plan.name}
                </Button>
              ) : plan.upgrade ? (
                <p className="text-sm text-ink-soft">
                  Online payment is not set up yet. <Link href="/app/help" className="font-medium text-brand-700 underline">Ask support</Link> to upgrade.
                </p>
              ) : (
                <p className="text-sm text-ink-soft">
                  To move to {plan.name}, <Link href="/app/help" className="font-medium text-brand-700 underline">contact support</Link>.
                </p>
              )}
            </Card>
          ))}
        </div>

        <Card className="p-5">
          <h2 className="font-semibold">Every plan includes</h2>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {ALL_PLANS_INCLUDE.map((f) => (
              <li key={f} className="flex gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                {f}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Sheet
        open={!!chosen}
        onClose={() => !paying && setChosen(null)}
        title={chosen ? `Upgrade to ${chosen.name}` : ''}
        footer={
          chosen?.upgrade && (
            <Button block size="lg" loading={paying} onClick={() => void upgrade(chosen)}>
              Pay {formatPaise(chosen.upgrade.amount_paise)}
            </Button>
          )
        }
      >
        {chosen?.upgrade && (
          <div className="space-y-3 text-sm">
            <p>
              {chosen.name} starts as soon as you pay, for {day(chosen.upgrade.period_start)} to {day(chosen.upgrade.period_end)}.
            </p>
            <dl className="divide-y divide-line rounded-xl border border-line">
              <div className="flex justify-between p-3">
                <dt>{chosen.name}, one {per(chosen)}</dt>
                <dd>{formatPaise(chosen.price_paise)}</dd>
              </div>
              {chosen.upgrade.credit_paise > 0 && current && (
                <div className="flex justify-between p-3 text-emerald-800">
                  <dt>Unused days of {current.name}</dt>
                  <dd>−{formatPaise(chosen.upgrade.credit_paise)}</dd>
                </div>
              )}
              <div className="flex justify-between p-3 font-semibold">
                <dt>You pay now</dt>
                <dd>{formatPaise(chosen.upgrade.amount_paise)}</dd>
              </div>
            </dl>
            <p className="text-xs text-ink-faint">Paid securely through Razorpay (UPI, cards, netbanking). The receipt appears under Settings → Brand &amp; plan.</p>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Usage({ label, used, max }: { label: string; used: number; max: number | undefined }) {
  const full = max !== undefined && used >= max;
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className={cn(full && 'font-medium text-amber-800')}>
          {used} of {max ?? 'no limit'}
        </span>
      </div>
      {max !== undefined && max > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
          <div className={cn('h-full rounded-full', full ? 'bg-amber-500' : 'bg-[var(--brand)]')} style={{ width: `${Math.min(100, (used / max) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
