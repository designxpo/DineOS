import type { Tx } from '../context';
import { json } from '../db';
import type { StaffAuth } from './auth';

export interface AuditEntry {
  outletId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  approvedBy?: string | null;
}

/** Writes an audit_log row in the caller's transaction (voids, discounts, refunds, plan changes...). */
export async function audit(tx: Tx, actor: StaffAuth | { adminId: string } | null, e: AuditEntry): Promise<void> {
  await tx.db
    .insertInto('audit_log')
    .values({
      tenant_id: tx.tenantId,
      outlet_id: e.outletId ?? null,
      actor_user_id: actor && 'userId' in actor ? actor.userId : null,
      actor_admin_id: actor && 'adminId' in actor ? actor.adminId : actor && 'impersonatedBy' in actor ? actor.impersonatedBy : null,
      approved_by: e.approvedBy ?? null,
      action: e.action,
      entity: e.entity,
      entity_id: e.entityId ?? null,
      before: e.before === undefined ? null : json(e.before),
      after: e.after === undefined ? null : json(e.after),
      reason: e.reason ?? null,
    })
    .execute();
}
