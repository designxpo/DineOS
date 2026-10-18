// Room charges for hotel restaurants: what the front desk must post to guests' folios. A refund of
// a room charge is listed as a negative line for the same room.

import { sql } from 'kysely';
import type { Tx } from '../../context';
import type { Range } from '../reports/service';

export interface RoomChargeRow {
  payment_id: string;
  bill_id: string;
  kind: 'payment' | 'refund';
  at: string;
  room_no: string;
  room_guest: string | null;
  invoice_no: string | null;
  table_label: string | null;
  /** Negative for refunds. */
  amount_paise: number;
  confirmed_by_name: string | null;
  posted_at: string | null;
  posted_by_name: string | null;
  status: 'pending' | 'posted' | 'rejected';
  rejected_at: string | null;
  reject_reason: string | null;
}

export async function roomCharges(tx: Tx, r: Range, opts: { unpostedOnly?: boolean } = {}) {
  const day = sql<string>`(payments.created_at at time zone ${r.timezone})::date`;
  let q = tx.db
    .selectFrom('payments')
    .innerJoin('bills', 'bills.id', 'payments.bill_id')
    .leftJoin('table_sessions', 'table_sessions.id', 'bills.table_session_id')
    .leftJoin('tables', 'tables.id', 'table_sessions.table_id')
    .leftJoin('users as cashier', 'cashier.id', 'payments.confirmed_by')
    .leftJoin('users as poster', 'poster.id', 'payments.room_posted_by')
    .select([
      'payments.id',
      'payments.bill_id',
      'payments.kind',
      'payments.created_at',
      'payments.room_no',
      'payments.room_guest',
      'payments.amount_paise',
      'payments.room_posted_at',
      'payments.room_rejected_at',
      'payments.room_reject_reason',
      'bills.invoice_no',
      'tables.label as table_label',
      'cashier.name as cashier_name',
      'poster.name as poster_name',
    ])
    .where('payments.outlet_id', '=', r.outletId)
    .where('payments.method', '=', 'room')
    .where('payments.bill_id', 'is not', null)
    .where(day, '>=', r.from)
    .where(day, '<=', r.to);
  if (opts.unpostedOnly) q = q.where('payments.room_posted_at', 'is', null);
  const rows = await q.orderBy('payments.room_no').orderBy('payments.created_at').execute();

  const out: RoomChargeRow[] = rows.map((p) => ({
    payment_id: p.id,
    bill_id: p.bill_id!,
    kind: p.kind as RoomChargeRow['kind'],
    at: p.created_at.toISOString(),
    room_no: p.room_no!,
    room_guest: p.room_guest,
    invoice_no: p.invoice_no,
    table_label: p.table_label,
    amount_paise: p.kind === 'refund' ? -p.amount_paise : p.amount_paise,
    confirmed_by_name: p.cashier_name,
    posted_at: p.room_posted_at?.toISOString() ?? null,
    posted_by_name: p.poster_name,
    status: p.room_posted_at ? 'posted' : p.room_rejected_at ? 'rejected' : 'pending',
    rejected_at: p.room_rejected_at?.toISOString() ?? null,
    reject_reason: p.room_reject_reason,
  }));
  const sum = (xs: RoomChargeRow[]) => xs.reduce((a, x) => a + x.amount_paise, 0);
  const unposted = out.filter((x) => !x.posted_at);
  const rejected = out.filter((x) => x.status === 'rejected');
  const byRoom = new Map<string, number>();
  for (const x of unposted.filter((u) => u.status === 'pending')) byRoom.set(x.room_no, (byRoom.get(x.room_no) ?? 0) + x.amount_paise);
  return {
    from: r.from,
    to: r.to,
    totals: { charges: out.length, amount_paise: sum(out), unposted: unposted.length, unposted_paise: sum(unposted), rejected: rejected.length, rejected_paise: sum(rejected) },
    /** What to post per room, from lines still waiting (refunds already netted); rejected ones are listed apart. */
    by_room: [...byRoom.entries()].map(([room_no, amount_paise]) => ({ room_no, amount_paise })).sort((a, b) => a.room_no.localeCompare(b.room_no, 'en', { numeric: true })),
    rows: out,
  };
}
