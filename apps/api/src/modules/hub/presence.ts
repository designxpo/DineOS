import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';

const HUB_STALE_MS = 3 * 60_000;

/**
 * QR orders pause while the outlet is cut off: its hub has not checked in for a few minutes and no
 * staff screen is connected. Guests on mobile data could otherwise order into a kitchen that
 * cannot see them. With the hub merely switched off, staff screens are still live and QR goes on.
 */
export async function assertOutletReachable(ctx: AppContext, tenantId: string, outletId: string): Promise<void> {
  if (!ctx.presence) return;
  const hub = await ctx.tx(tenantId, (tx) =>
    tx.db
      .selectFrom('outlets')
      .leftJoin('devices', 'devices.id', 'outlets.hub_device_id')
      .select(['outlets.hub_device_id', 'devices.last_seen_at'])
      .where('outlets.id', '=', outletId)
      .executeTakeFirst(),
  );
  if (!hub?.hub_device_id) return;
  const stale = !hub.last_seen_at || Date.now() - hub.last_seen_at.getTime() > HUB_STALE_MS;
  if (!stale || (await ctx.presence(tenantId, outletId)) > 0) return;
  throw new AppError(503, 'outlet_offline', 'The restaurant is offline for a moment. Please order with your waiter.');
}
