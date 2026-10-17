import type { ItemsReadyDTO, OrderDTO, ServiceRequestDTO } from '@mezmitra/shared/dto';
import type { Role } from '@mezmitra/shared/enums';
import type { OutletEvent } from '@mezmitra/shared/events';
import { PIN_LOCK_MINUTES, PIN_MAX_ATTEMPTS, roleCan, type Action } from '@mezmitra/shared/permissions';

/** What a staff phone shows. `tag` lets a newer alert for the same thing replace the older one. */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Delivers Web Push messages. `gone`: the push service no longer knows the device. */
export interface PushSender {
  publicKey: string;
  send(device: PushDevice, message: PushMessage): Promise<'ok' | 'gone'>;
}

export function webPushSender(cfg: { publicKey: string; privateKey: string; subject: string }): PushSender {
  return {
    publicKey: cfg.publicKey,
    async send(device, message) {
      const webpush = (await import('web-push')).default;
      try {
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          JSON.stringify(message),
          { TTL: 300, urgency: 'high', vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey } },
        );
        return 'ok';
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return 'gone';
        throw err;
      }
    },
  };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * An alert and who should get it: staff who can do `action` at the outlet, only these `roles`
 * when given, and, for a table with an assigned waiter, not the other floor-only waiters.
 */
export interface PushAlert {
  message: PushMessage;
  action: Action;
  roles?: readonly Role[];
  assignedWaiterId?: string | null;
  /** Only this person (e.g. whoever raised a help case). */
  userId?: string;
}

/** Whether a staff member with these roles at the outlet should get the alert on their phone. */
export function wantsAlert(alert: PushAlert, userId: string, roles: readonly Role[]): boolean {
  if (alert.userId) return alert.userId === userId;
  if (!roles.some((r) => roleCan(r, alert.action) && (!alert.roles || alert.roles.includes(r)))) return false;
  // Waiters with no other duties handle their own tables and unassigned ones, as on screen.
  const floorOnly = roles.length > 0 && roles.every((r) => r === 'waiter');
  return !floorOnly || !alert.assignedWaiterId || alert.assignedWaiterId === userId;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ORDER_KIND: Record<ItemsReadyDTO['order_type'], string> = { dine_in: 'Order', takeaway: 'Takeaway', counter: 'Counter', delivery: 'Delivery' };
const CHANNEL: Record<NonNullable<ItemsReadyDTO['channel']>, string> = { zomato: 'Zomato', swiggy: 'Swiggy', own: 'Delivery' };

/** What staff call an order: "Table C4", "Zomato #4821", "Takeaway #12". */
function orderWhere(o: Pick<ItemsReadyDTO, 'table_label' | 'order_type' | 'order_no' | 'channel' | 'channel_ref'>): string {
  if (o.table_label) return `Table ${o.table_label}`;
  if (o.order_type === 'delivery' && o.channel) return `${CHANNEL[o.channel]} #${o.channel_ref ?? o.order_no}`;
  return `${ORDER_KIND[o.order_type]} #${o.order_no}`;
}

/**
 * The alert for an outlet event, or null when nobody needs a phone buzz: guests' orders (staff
 * entering their own do not), waiter calls, bill requests, and food or drinks ready to serve.
 */
export function pushFor(event: OutletEvent): PushAlert | null {
  if (event.type === 'support.updated') {
    const p = event.payload as { case_id: string; number: number; status_words: string; notify_user_id: string | null; reply: string | null };
    if (!p.notify_user_id) return null;
    return {
      action: 'order.view',
      userId: p.notify_user_id,
      message: { title: `Help case #${p.number}: ${p.status_words}`, body: p.reply ?? 'Tap to see the reply', url: `/app/help?case=${p.case_id}`, tag: `support-${p.case_id}` },
    };
  }
  if (event.type === 'order.placed') {
    const order = (event.payload as { order: OrderDTO }).order;
    if (order.source !== 'guest_qr') return null;
    const where = order.table_label ? `Table ${order.table_label}` : 'Takeaway';
    const items = order.items.filter((i) => i.status !== 'cancelled').reduce((a, i) => a + i.qty, 0);
    return {
      action: 'order.accept',
      message: {
        title: order.status === 'placed' ? 'New order to accept' : 'New order',
        body: `${where} · ${items} ${items === 1 ? 'item' : 'items'} · ${rupees(order.subtotal_paise)}`,
        url: '/app/inbox',
        tag: `order-${order.id}`,
      },
    };
  }
  if (event.type === 'waiter.called' || event.type === 'bill.requested') {
    const request = (event.payload as { request: ServiceRequestDTO }).request;
    return {
      action: 'service_request.handle',
      assignedWaiterId: request.assigned_waiter_id,
      message: {
        title: event.type === 'waiter.called' ? `Table ${request.table_label} is calling a waiter` : `Table ${request.table_label} asked for the bill`,
        body: 'Tap to open the floor',
        url: '/app/floor',
        tag: `request-${request.id}`,
      },
    };
  }
  if (event.type === 'order.items_ready') {
    const ready = event.payload as ItemsReadyDTO;
    const where = orderWhere(ready);
    const what = ready.complete ? 'order ready' : `${ready.stations.map(capital).join(' and ')} ready`;
    return {
      action: 'order.serve',
      // The people who carry it out: waiters for tables, the counter too for parcels.
      roles: ready.table_id ? ['waiter'] : ['waiter', 'cashier'],
      assignedWaiterId: ready.assigned_waiter_id,
      message: {
        title: `${where} · ${capital(what)}`,
        body: ready.items.map((i) => `${i.qty}× ${i.name}`).join(', '),
        url: '/app/inbox',
        // The whole order being ready replaces the earlier "drinks ready" on the lock screen.
        tag: `ready-${ready.order_id}`,
      },
    };
  }
  if (event.type === 'comp.given') {
    const p = event.payload as { alert: boolean; value_paise: number; items: string; where: string | null };
    if (!p.alert) return null;
    return {
      action: 'report.view',
      roles: ['owner'],
      message: {
        title: `Given free: ${rupees(p.value_paise)}`,
        body: `${p.items}${p.where ? ` · ${/^#/.test(p.where) ? `order ${p.where}` : `table ${p.where}`}` : ''}`,
        url: '/app/reports',
        tag: `comp-${event.seq}`,
      },
    };
  }
  if (event.type === 'staff.pin_locked') {
    const p = event.payload as { user_name: string; requested_by_name: string | null };
    return {
      // Security notices go to the owner.
      action: 'staff.manage',
      roles: ['owner'],
      message: {
        title: `${p.user_name}'s manager PIN is locked`,
        body: `${p.requested_by_name ?? 'Someone'} entered a wrong PIN ${PIN_MAX_ATTEMPTS} times in a row. It unlocks in ${PIN_LOCK_MINUTES} minutes.`,
        url: '/app/settings',
        tag: `pin-locked-${p.user_name}`,
      },
    };
  }
  return null;
}
