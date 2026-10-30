// Help cases: raised by outlet staff, worked by Mezvaan support. Every change leaves a message in
// the case's thread (from the outlet, support, or the system) and tells the outlet's screens.

import { sql, type Kysely } from 'kysely';
import type { AdminSupportCaseDTO, SupportCaseDTO, SupportMessageDTO } from '@mezmitra/shared/dto';
import { missedTarget, type SupportSeverity, type SupportStatus } from '@mezmitra/shared/support';
import type { Tx } from '../../context';
import type { DB } from '../../db';
import { conflict, notFound } from '../../lib/errors';

const STATUS_WORDS: Record<SupportStatus, string> = {
  open: 'Waiting for support',
  in_progress: 'Support is working on it',
  waiting_on_outlet: 'Support asked you something',
  resolved: 'Support says it is fixed: please confirm',
  closed: 'Closed',
};
export const statusWords = (s: SupportStatus) => STATUS_WORDS[s];

/** The case columns both views read, with names joined in. Works on the tenant or admin connection. */
function caseQuery(db: Kysely<DB>) {
  return db
    .selectFrom('support_cases')
    .leftJoin('users', 'users.id', 'support_cases.raised_by')
    .leftJoin('platform_admins', 'platform_admins.id', 'support_cases.assignee_admin_id')
    .selectAll('support_cases')
    .select((eb) => [
      'users.name as raised_by_name',
      'platform_admins.name as assignee_name',
      eb.selectFrom('support_messages').select((m) => m.fn.max('created_at').as('at')).whereRef('support_messages.case_id', '=', 'support_cases.id').as('last_message_at'),
    ]);
}
type CaseRow = Awaited<ReturnType<ReturnType<typeof caseQuery>['executeTakeFirstOrThrow']>>;

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function caseDto(r: CaseRow): SupportCaseDTO {
  return {
    id: r.id,
    number: r.number,
    outlet_id: r.outlet_id,
    severity: r.severity as SupportSeverity,
    status: r.status as SupportStatus,
    summary: r.summary,
    raised_by_name: r.raised_by_name,
    assignee_name: r.assignee_name,
    created_at: r.created_at.toISOString(),
    first_response_at: iso(r.first_response_at),
    resumed_at: iso(r.resumed_at),
    resolved_at: iso(r.resolved_at),
    closed_at: iso(r.closed_at),
    reopened: r.reopened,
    last_message_at: (r.last_message_at ? new Date(r.last_message_at as unknown as string) : r.created_at).toISOString(),
  };
}

export async function messages(db: Kysely<DB>, caseId: string): Promise<SupportMessageDTO[]> {
  const rows = await db
    .selectFrom('support_messages')
    .leftJoin('users', 'users.id', 'support_messages.user_id')
    .leftJoin('platform_admins', 'platform_admins.id', 'support_messages.admin_id')
    .select(['support_messages.id', 'support_messages.author', 'support_messages.body', 'support_messages.created_at', 'users.name as user_name', 'platform_admins.name as admin_name'])
    .where('support_messages.case_id', '=', caseId)
    .orderBy('support_messages.created_at')
    .orderBy('support_messages.id')
    .execute();
  return rows.map((m) => ({
    id: m.id,
    author: m.author as SupportMessageDTO['author'],
    author_name: m.author === 'support' ? m.admin_name : m.author === 'outlet' ? m.user_name : null,
    body: m.body,
    created_at: m.created_at.toISOString(),
  }));
}

export async function loadCase(tx: Tx, id: string, outletId?: string): Promise<SupportCaseDTO> {
  let q = caseQuery(tx.db).where('support_cases.id', '=', id);
  if (outletId) q = q.where('support_cases.outlet_id', '=', outletId);
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Case');
  return { ...caseDto(row), messages: await messages(tx.db, id) };
}

export async function listCases(tx: Tx, outletId: string): Promise<SupportCaseDTO[]> {
  const rows = await caseQuery(tx.db).where('support_cases.outlet_id', '=', outletId).orderBy('support_cases.created_at', 'desc').limit(50).execute();
  return rows.map(caseDto);
}

/** Every open case across restaurants for support: the most urgent and oldest first; closed ones last. */
export async function supportQueue(adminDb: Kysely<DB>, include: 'open' | 'all'): Promise<AdminSupportCaseDTO[]> {
  let q = caseQuery(adminDb)
    .innerJoin('tenants', 'tenants.id', 'support_cases.tenant_id')
    .innerJoin('outlets', 'outlets.id', 'support_cases.outlet_id')
    .select(['tenants.name as tenant_name', 'outlets.name as outlet_name']);
  if (include === 'open') q = q.where('support_cases.status', '<>', 'closed');
  const rows = await q
    .orderBy(sql`case support_cases.status when 'closed' then 2 when 'resolved' then 1 else 0 end`)
    .orderBy(sql`case support_cases.severity when 'stopped' then 0 when 'degraded' then 1 else 2 end`)
    .orderBy('support_cases.created_at')
    .limit(200)
    .execute();
  return rows.map((r) => {
    const dto = caseDto(r);
    return { ...dto, tenant_id: r.tenant_id, tenant_name: r.tenant_name, outlet_name: r.outlet_name, diagnostics: (r.diagnostics ?? null) as Record<string, unknown> | null, missed_target: missedTarget(dto) };
  });
}

export async function addMessage(tx: Tx, caseId: string, author: SupportMessageDTO['author'], body: string, who: { userId?: string | null; adminId?: string | null } = {}): Promise<void> {
  await tx.db
    .insertInto('support_messages')
    .values({ tenant_id: tx.tenantId, case_id: caseId, author, body, user_id: who.userId ?? null, admin_id: who.adminId ?? null })
    .execute();
}

/**
 * Tells the outlet's screens the case changed; a reply from support also reaches the phone of
 * whoever raised it.
 */
export async function announce(tx: Tx, caseId: string, opts: { notify?: boolean } = {}): Promise<void> {
  const c = await tx.db.selectFrom('support_cases').select(['outlet_id', 'number', 'status', 'summary', 'raised_by']).where('id', '=', caseId).executeTakeFirstOrThrow();
  const last = opts.notify
    ? await tx.db.selectFrom('support_messages').select('body').where('case_id', '=', caseId).where('author', '=', 'support').orderBy('created_at', 'desc').executeTakeFirst()
    : undefined;
  await tx.emit({
    outletId: c.outlet_id,
    type: 'support.updated',
    channels: ['outlet'],
    payload: {
      case_id: caseId,
      number: c.number,
      status: c.status,
      status_words: statusWords(c.status as SupportStatus),
      notify_user_id: opts.notify ? c.raised_by : null,
      reply: last?.body.slice(0, 160) ?? null,
    },
  });
}

export async function lockCase(tx: Tx, id: string) {
  const c = await tx.db.selectFrom('support_cases').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!c) throw notFound('Case');
  return c;
}

export function assertOpen(status: string): void {
  if (status === 'closed') throw conflict('case_closed', 'This case is closed. Reopen it if the problem is back.');
}

