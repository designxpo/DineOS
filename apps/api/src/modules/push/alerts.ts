import { waitUntil } from '@vercel/functions';
import type { Role } from '@dineos/shared/enums';
import { roleCan } from '@dineos/shared/permissions';
import type { AppContext } from '../../context';
import { pushFor, type PushDevice, type PushMessage, type PushSender } from '../../lib/push';
import type { Action } from '@dineos/shared/permissions';

/**
 * Sends committed outlet events that need a person (a guest order, a waiter call, a bill request)
 * to the phones of staff who can act on them. Runs after commit; on Vercel, waitUntil keeps the
 * function alive until the sends finish. Returns the unsubscribe function.
 */
export function registerPushAlerts(ctx: AppContext): () => void {
  return ctx.bus.subscribe((tenantId, events) => {
    const sender = ctx.push;
    if (!sender) return;
    for (const event of events) {
      const alert = pushFor(event);
      if (!alert) continue;
      waitUntil(deliver(ctx, sender, tenantId, event.outlet_id, alert).catch((err) => ctx.log.warn({ err }, 'push alert failed')));
    }
  });
}

async function deliver(ctx: AppContext, sender: PushSender, tenantId: string, outletId: string, alert: { message: PushMessage; action: Action }) {
  const rows = await ctx.tx(tenantId, (tx) =>
    tx.db
      .selectFrom('push_subscriptions')
      .innerJoin('users', 'users.id', 'push_subscriptions.user_id')
      .innerJoin('user_outlet_roles', 'user_outlet_roles.user_id', 'push_subscriptions.user_id')
      .select(['push_subscriptions.id', 'push_subscriptions.endpoint', 'push_subscriptions.p256dh', 'push_subscriptions.auth', 'user_outlet_roles.role', 'user_outlet_roles.outlet_id as role_outlet_id'])
      .where('push_subscriptions.outlet_id', '=', outletId)
      .where('users.status', '=', 'active')
      .execute(),
  );
  // A role counts at this outlet, or everywhere when it has no outlet (the owner).
  const devices = new Map<string, PushDevice>();
  for (const r of rows) {
    if ((r.role_outlet_id === null || r.role_outlet_id === outletId) && roleCan(r.role as Role, alert.action)) devices.set(r.id, r);
  }
  const gone: string[] = [];
  await Promise.all(
    [...devices].map(async ([id, device]) => {
      const result = await sender.send(device, alert.message).catch((err) => {
        ctx.log.warn({ err }, 'push send failed');
        return 'ok' as const;
      });
      if (result === 'gone') gone.push(id);
    }),
  );
  if (gone.length) await ctx.tx(tenantId, (tx) => tx.db.deleteFrom('push_subscriptions').where('id', 'in', gone).execute());
}
