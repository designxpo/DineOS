import { waitUntil } from '@vercel/functions';
import type { Role } from '@mezmitra/shared/enums';
import type { AppContext } from '../../context';
import { pushFor, wantsAlert, type PushAlert, type PushDevice, type PushSender } from '../../lib/push';

/**
 * Sends committed outlet events that need a person (a guest order, a waiter call, a bill request,
 * food ready at the pass) to the phones of staff who can act on them. Runs after commit; on
 * Vercel, waitUntil keeps the function alive until the sends finish. Returns the unsubscribe
 * function.
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

async function deliver(ctx: AppContext, sender: PushSender, tenantId: string, outletId: string, alert: PushAlert) {
  const rows = await ctx.tx(tenantId, (tx) =>
    tx.db
      .selectFrom('push_subscriptions')
      .innerJoin('users', 'users.id', 'push_subscriptions.user_id')
      .innerJoin('user_outlet_roles', 'user_outlet_roles.user_id', 'push_subscriptions.user_id')
      .select([
        'push_subscriptions.id',
        'push_subscriptions.user_id',
        'push_subscriptions.endpoint',
        'push_subscriptions.p256dh',
        'push_subscriptions.auth',
        'user_outlet_roles.role',
        'user_outlet_roles.outlet_id as role_outlet_id',
      ])
      .where('push_subscriptions.outlet_id', '=', outletId)
      .where('users.status', '=', 'active')
      .execute(),
  );
  // A role counts at this outlet, or everywhere when it has no outlet (the owner).
  const subscribers = new Map<string, PushDevice & { userId: string; roles: Role[] }>();
  for (const r of rows) {
    if (r.role_outlet_id !== null && r.role_outlet_id !== outletId) continue;
    const s = subscribers.get(r.id) ?? { endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, userId: r.user_id, roles: [] };
    s.roles.push(r.role as Role);
    subscribers.set(r.id, s);
  }
  const devices = [...subscribers].filter(([, s]) => wantsAlert(alert, s.userId, s.roles));
  const gone: string[] = [];
  await Promise.all(
    devices.map(async ([id, device]) => {
      const result = await sender.send(device, alert.message).catch((err) => {
        ctx.log.warn({ err }, 'push send failed');
        return 'ok' as const;
      });
      if (result === 'gone') gone.push(id);
    }),
  );
  if (gone.length) await ctx.tx(tenantId, (tx) => tx.db.deleteFrom('push_subscriptions').where('id', 'in', gone).execute());
}
