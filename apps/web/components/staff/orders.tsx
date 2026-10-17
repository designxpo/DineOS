'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Ban, Clock, HandPlatter, Pencil, Printer, QrCode, ShieldAlert, Smartphone, StickyNote, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { OrderDTO } from '@dineos/shared/dto';
import type { OrderStatus } from '@dineos/shared/enums';
import { ApiError, errorMessage } from '@/lib/api';
import { ago, formatPaise, minutesSince } from '@/lib/format';
import { send } from '@/lib/outbox';
import { orderTitle } from '@/components/staff/order-title';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { Button, IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { ConfirmDialog } from '@/components/ui/overlay';
import { Badge, Textarea, VegMark } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useWithApproval } from './approval';
import { EditOrderSheet } from './edit-order';

export const STATUS_TONE: Record<OrderStatus, 'amber' | 'blue' | 'violet' | 'green' | 'neutral' | 'rose'> = {
  placed: 'amber',
  accepted: 'blue',
  preparing: 'violet',
  ready: 'green',
  served: 'neutral',
  billed: 'neutral',
  rejected: 'rose',
  cancelled: 'rose',
};

const SOURCE: Record<OrderDTO['source'], { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  guest_qr: { label: 'QR', icon: QrCode },
  waiter: { label: 'Waiter', icon: UserRound },
  pos: { label: 'POS', icon: Smartphone },
};

const REJECT_REASONS = ['Item not available', 'Kitchen is closing', 'Duplicate order', 'Wrong table / not a real order'];

/** Status changes go through the offline outbox so a short network drop never loses a tap. */
export function useOrderActions() {
  const { token, api } = useStaff();
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const withApproval = useWithApproval();
  const [busy, setBusy] = useState<string | null>(null);

  async function setStatus(order: OrderDTO, status: OrderStatus, reason?: string) {
    setBusy(`${order.id}:${status}`);
    try {
      const run = (approvalToken: string | null) =>
        send<OrderDTO>(token, `/orders/${order.id}/status`, {
          method: 'PATCH',
          body: { status, reason },
          label: t('outbox.order_label', { n: order.order_no, status: t(`order.${status}` as I18nKey) }),
          approvalToken,
        });
      const res = await withApproval(run);
      if (res?.queued) toast(t('offline.saved_order', { n: order.order_no }), 'info');
      await qc.invalidateQueries({ queryKey: ['orders'] });
      await qc.invalidateQueries({ queryKey: ['kds'] });
      return res;
    } catch (err) {
      toast(errorMessage(err), 'error');
      if (err instanceof ApiError && err.code === 'invalid_transition') void qc.invalidateQueries({ queryKey: ['orders'] });
    } finally {
      setBusy(null);
    }
  }

  /** The drinks went out while the food still cooks: only the ready items become served. */
  async function serveReady(order: OrderDTO) {
    const ids = order.items.filter((i) => i.status === 'ready').map((i) => i.id);
    if (ids.length === 0) return;
    setBusy(`${order.id}:serve-ready`);
    try {
      const res = await send<OrderDTO>(token, `/orders/${order.id}/items/status`, {
        method: 'PATCH',
        body: { item_ids: ids, status: 'served' },
        label: t('outbox.order_label', { n: order.order_no, status: t('act.serve_ready', { n: ids.length }) }),
      });
      if (res.queued) toast(t('offline.saved_order', { n: order.order_no }), 'info');
      await qc.invalidateQueries({ queryKey: ['orders'] });
      await qc.invalidateQueries({ queryKey: ['kds'] });
    } catch (err) {
      toast(errorMessage(err), 'error');
      if (err instanceof ApiError && err.code === 'invalid_transition') void qc.invalidateQueries({ queryKey: ['orders'] });
    } finally {
      setBusy(null);
    }
  }

  async function reprint(order: OrderDTO) {
    try {
      const res = await api<{ queued: number; message?: string }>(`/orders/${order.id}/reprint-kot`, { method: 'POST', body: {} });
      if (res.queued) toast(`Kitchen ticket sent to printer`);
      else window.open(`/print/kot/${order.id}`, '_blank');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return { setStatus, serveReady, reprint, busy };
}

export function OrderCard({ order, highlight, compact }: { order: OrderDTO; highlight?: boolean; compact?: boolean }) {
  const { can } = useStaff();
  const { t } = useI18n();
  const { setStatus, serveReady, reprint, busy } = useOrderActions();
  const [rejecting, setRejecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const mins = minutesSince(order.accepted_at ?? order.placed_at);
  const late = order.status !== 'placed' && order.status !== 'served' && mins >= 20;
  const Source = SOURCE[order.source];
  const isBusy = (s: OrderStatus) => busy === `${order.id}:${s}`;

  // Part of the order is at the pass (the bar's drinks) while the rest still cooks.
  const readyItems = order.items.filter((i) => i.status === 'ready').reduce((n, i) => n + i.qty, 0);
  const serveSome = readyItems > 0 && (order.status === 'accepted' || order.status === 'preparing') && can('order.serve');

  const kitchenOrServe: { status: OrderStatus; label: string; variant?: 'primary' | 'success' } | null =
    order.status === 'placed' && can('order.accept')
      ? { status: 'accepted', label: t('act.accept') }
      : order.status === 'accepted' && can('order.kitchen')
        ? { status: 'preparing', label: t('act.start') }
        : order.status === 'preparing' && can('order.kitchen')
          ? { status: 'ready', label: t('act.ready'), variant: 'success' }
          : order.status === 'ready' && can('order.serve')
            ? { status: 'served', label: t('act.served'), variant: 'success' }
            : (order.status === 'accepted' || order.status === 'preparing') && can('order.serve')
              ? { status: 'served', label: t('act.served') }
              : null;
  // Serving what is ready comes first; marking the whole order served would also tick off the
  // dishes still cooking (that stays one tap away as "skip kitchen steps").
  const primary = serveSome && kitchenOrServe?.status === 'served' ? null : kitchenOrServe;

  return (
    <article
      className={cn(
        'rounded-[var(--radius-card)] border bg-surface shadow-[var(--shadow-card)] transition',
        highlight ? 'animate-pulse-ring border-amber-300' : 'border-line',
        order.status === 'placed' && 'border-l-4 border-l-amber-500',
      )}
    >
      <header className="p-4 pb-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-lg font-semibold text-ink">{orderTitle(order, t)}</h3>
          <p className="shrink-0 pt-0.5 text-sm font-semibold tabular">{formatPaise(order.subtotal_paise)}</p>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
          <Badge tone={STATUS_TONE[order.status]}>{t(`order.${order.status}` as I18nKey)}</Badge>
          <span className="font-medium text-ink-soft">#{order.order_no}</span>
          <span className="inline-flex items-center gap-1">
            <Source.icon className="size-3.5" /> {Source.label}
            {order.created_by_name ? ` · ${order.created_by_name}` : ''}
          </span>
          <span className={cn('inline-flex items-center gap-1', late && 'font-semibold text-rose-700')}>
            <Clock className="size-3.5" /> {ago(order.placed_at)}
          </span>
          {order.customer_name && <span>{order.customer_name}</span>}
        </p>
      </header>

      {order.flagged && order.status === 'placed' && (
        <p className="mx-4 mb-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-900">
          <ShieldAlert className="size-3.5" /> {t(order.flag_reason === 'returning_device' ? 'order.returning_device' : 'order.new_device')}
        </p>
      )}

      <ul className={cn('space-y-1.5 px-4', compact ? 'pb-3' : 'pb-3')}>
        {order.items.map((i) => (
          <li key={i.id} className={cn('flex items-start gap-2 text-sm', i.status === 'cancelled' && 'text-ink-faint line-through')}>
            <VegMark veg={i.is_veg} className="mt-0.5" />
            <span className="min-w-6 font-semibold tabular">{i.qty}×</span>
            <span className="flex-1">
              {i.name}
              {i.seat_no && <span className="ml-1 text-xs text-ink-faint">seat {i.seat_no}</span>}
              {i.modifiers.length > 0 && <span className="block text-xs text-ink-faint">{i.modifiers.map((m) => m.name).join(', ')}</span>}
              {i.note && <span className="block text-xs font-medium text-amber-800">“{i.note}”</span>}
            </span>
            {order.status !== 'placed' && i.status !== order.status && i.status !== 'cancelled' && (
              <Badge tone={STATUS_TONE[i.status as OrderStatus] ?? 'neutral'} className="text-[10px]">
                {t(`item.${i.status}` as I18nKey)}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      {order.note && (
        <p className="mx-4 mb-3 flex items-start gap-1.5 rounded-lg bg-stone-50 px-2.5 py-1.5 text-xs text-ink-soft">
          <StickyNote className="mt-0.5 size-3.5 shrink-0" /> {order.note}
        </p>
      )}
      {order.rejected_reason && <p className="mx-4 mb-3 text-xs text-rose-700">Rejected: {order.rejected_reason}</p>}
      {order.cancelled_reason && <p className="mx-4 mb-3 text-xs text-rose-700">Cancelled: {order.cancelled_reason}</p>}

      {!compact && ['placed', 'accepted', 'preparing', 'ready'].includes(order.status) && (
        // Narrow columns wrap the less-used actions onto their own row instead of pushing them out.
        <footer className="flex flex-wrap items-center gap-2 border-t border-line p-3">
          {serveSome && (
            <Button
              className="min-w-32 flex-1"
              variant="success"
              title={t('act.serve_ready_hint')}
              loading={busy === `${order.id}:serve-ready`}
              onClick={() => void serveReady(order)}
            >
              {t('act.serve_ready', { n: readyItems })}
            </Button>
          )}
          {primary && (
            <Button
              className="min-w-32 flex-1"
              variant={serveSome ? 'outline' : (primary.variant ?? 'primary')}
              loading={isBusy(primary.status)}
              onClick={() => void setStatus(order, primary.status)}
            >
              {primary.label}
            </Button>
          )}
          {order.status === 'placed' && can('order.accept') && (
            <Button variant="outline" onClick={() => setRejecting(true)}>
              {t('act.reject')}
            </Button>
          )}
          {order.status === 'placed' && can('order.edit_items') && (
            <IconButton label={t('act.edit')} onClick={() => setEditing(true)} className="ml-auto">
              <Pencil className="size-[18px]" />
            </IconButton>
          )}
          {order.status !== 'placed' && (
            <div className="ml-auto flex shrink-0 items-center">
              {can('order.edit_items') && (
                <IconButton label={t('act.edit')} onClick={() => setEditing(true)}>
                  <Pencil className="size-[18px]" />
                </IconButton>
              )}
              {(order.status === 'accepted' || order.status === 'preparing') && can('order.serve') && primary?.status !== 'served' && (
                <IconButton label={t('act.skip_served')} onClick={() => void setStatus(order, 'served')}>
                  <HandPlatter className="size-[18px]" />
                </IconButton>
              )}
              <IconButton label={t('act.reprint')} onClick={() => void reprint(order)}>
                <Printer className="size-[18px]" />
              </IconButton>
              {can('order.edit_items') && (
                <IconButton label={t('act.cancel')} onClick={() => setCancelling(true)}>
                  <Ban className="size-[18px]" />
                </IconButton>
              )}
            </div>
          )}
        </footer>
      )}

      {editing && <EditOrderSheet order={order} open={editing} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={`Reject order #${order.order_no}?`}
        description="The guest sees this reason on their phone."
        confirmLabel="Reject order"
        busy={isBusy('rejected')}
        onConfirm={async () => {
          if (!reason.trim()) return;
          const res = await setStatus(order, 'rejected', reason.trim());
          if (res) setRejecting(false);
        }}
      >
        <ReasonPicker reasons={REJECT_REASONS} value={reason} onChange={setReason} />
      </ConfirmDialog>
      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={`Cancel order #${order.order_no}?`}
        description="The kitchen gets a cancellation ticket. A manager must approve because the kitchen already has it."
        confirmLabel="Cancel order"
        busy={isBusy('cancelled')}
        onConfirm={async () => {
          if (!reason.trim()) return;
          const res = await setStatus(order, 'cancelled', reason.trim());
          if (res) setCancelling(false);
        }}
      >
        <ReasonPicker reasons={['Guest left', 'Guest changed mind', 'Entered by mistake', 'Took too long']} value={reason} onChange={setReason} />
      </ConfirmDialog>
    </article>
  );
}

export function ReasonPicker({ reasons, value, onChange }: { reasons: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        {reasons.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            className={cn('h-9 cursor-pointer rounded-full border px-3 text-sm', value === r ? 'border-[var(--brand)] bg-brand-50 text-brand-700' : 'border-line text-ink-soft hover:bg-stone-50')}
          >
            {r}
          </button>
        ))}
      </div>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder="Or type a reason" maxLength={300} aria-label="Reason" />
    </div>
  );
}
