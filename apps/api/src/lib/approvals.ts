import type { ApprovalAction } from '@mezmitra/shared/permissions';
import type { Tx } from '../context';
import { can, type StaffAuth } from './auth';
import { sha256 } from './crypto';
import { AppError } from './errors';

/**
 * For actions that need a manager (spec §8). Returns the approving manager's user id:
 * the caller themself if they hold the permission, otherwise the manager who issued
 * `approvalToken` by entering their PIN (POST /v1/approvals). Single use, 2 minute lifetime.
 */
export async function requireApproval(
  tx: Tx,
  auth: StaffAuth,
  outletId: string,
  action: ApprovalAction,
  approvalToken: string | undefined | null,
): Promise<string> {
  if (can(auth, outletId, action)) return auth.userId;
  if (!approvalToken) {
    throw new AppError(403, 'approval_required', 'A manager needs to approve this', { action });
  }
  const row = await tx.db
    .updateTable('approval_tokens')
    .set({ used_at: new Date() })
    .where('token_hash', '=', sha256(approvalToken))
    .where('outlet_id', '=', outletId)
    .where('action', '=', action)
    .where('requested_by', '=', auth.userId)
    .where('used_at', 'is', null)
    .where('expires_at', '>', new Date())
    .returning('approver_id')
    .executeTakeFirst();
  if (!row) throw new AppError(403, 'approval_invalid', 'Manager approval expired or was already used', { action });
  return row.approver_id;
}

export function approvalHeader(headers: Record<string, unknown>): string | undefined {
  const v = headers['x-approval-token'];
  return typeof v === 'string' ? v : undefined;
}
