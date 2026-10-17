import type { OrderDTO, ServiceRequestDTO } from '@dineos/shared/dto';
import type { OutletEvent } from '@dineos/shared/events';
import type { Action } from '@dineos/shared/permissions';

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
 * The alert for an outlet event, and who may get it, or null when nobody needs a phone buzz:
 * guests' orders (staff entering their own do not), waiter calls and bill requests.
 */
export function pushFor(event: OutletEvent): { message: PushMessage; action: Action } | null {
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
      message: {
        title: event.type === 'waiter.called' ? `Table ${request.table_label} is calling a waiter` : `Table ${request.table_label} asked for the bill`,
        body: 'Tap to open the floor',
        url: '/app/floor',
        tag: `request-${request.id}`,
      },
    };
  }
  return null;
}
