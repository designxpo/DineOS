// Camera audit (spec §11 validation): how often the camera agrees with the ground truth the
// till already has, i.e. whether a table visit was open at that moment. Target: 95% for
// occupied vs vacant. Also what only a camera can tell: guests sitting without an order, and
// how long they waited before someone opened their table.

import { sql } from 'kysely';
import type { Tx } from '../../context';
import type { Range } from '../reports/service';

const TARGET_PCT = 95;

interface Interval {
  table_id: string;
  start: number;
  end: number;
}

export async function visionAudit(tx: Tx, r: Range) {
  const local = sql<string>`(table_state_events.at at time zone ${r.timezone})::date`;
  const readings = await tx.db
    .selectFrom('table_state_events')
    .innerJoin('tables', 'tables.id', 'table_state_events.table_id')
    .select(['table_state_events.table_id', 'tables.label', 'table_state_events.state', 'table_state_events.confidence', 'table_state_events.at'])
    .where('table_state_events.outlet_id', '=', r.outletId)
    .where('table_state_events.source', '=', 'camera')
    .where(local, '>=', r.from)
    .where(local, '<=', r.to)
    .orderBy('table_state_events.table_id')
    .orderBy('table_state_events.at')
    .execute();

  const tableIds = [...new Set(readings.map((x) => x.table_id))];
  const sessions = tableIds.length
    ? await tx.db
        .selectFrom('table_sessions')
        .select(['table_id', 'opened_at', 'closed_at'])
        .where('table_id', 'in', tableIds)
        .where('opened_at', 'is not', null)
        .execute()
    : [];
  const openAt = (tableId: string, at: number) =>
    sessions.some((s) => s.table_id === tableId && s.opened_at!.getTime() <= at && (!s.closed_at || s.closed_at.getTime() > at));

  const byTable = new Map<string, { table_id: string; label: string; readings: number; agree: number; false_alarms: number; misses: number }>();
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const x of readings) {
    const truth = openAt(x.table_id, x.at.getTime());
    const seen = x.state === 'occupied';
    const row = byTable.get(x.table_id) ?? { table_id: x.table_id, label: x.label, readings: 0, agree: 0, false_alarms: 0, misses: 0 };
    row.readings++;
    if (seen && truth) tp++;
    else if (seen && !truth) {
      fp++;
      row.false_alarms++;
    } else if (!seen && truth) {
      fn++;
      row.misses++;
    } else tn++;
    if (seen === truth) row.agree++;
    byTable.set(x.table_id, row);
  }
  const total = readings.length;

  // Occupied stretches as the camera saw them.
  const intervals: Interval[] = [];
  for (const id of tableIds) {
    const list = readings.filter((x) => x.table_id === id);
    let start: number | null = null;
    for (const x of list) {
      const t = x.at.getTime();
      if (x.state === 'occupied' && start === null) start = t;
      else if (x.state !== 'occupied' && start !== null) {
        intervals.push({ table_id: id, start, end: t });
        start = null;
      }
    }
  }
  const overlapsVisit = (i: Interval) =>
    sessions.some((s) => s.table_id === i.table_id && s.opened_at!.getTime() < i.end && (!s.closed_at || s.closed_at.getTime() > i.start));
  const withoutOrder = intervals.filter((i) => !overlapsVisit(i));
  // Guests seen before anyone opened their table: the wait until a waiter (or their first order) did.
  const waits = intervals
    .map((i) => {
      if (openAt(i.table_id, i.start)) return null;
      const first = sessions
        .filter((s) => s.table_id === i.table_id && s.opened_at!.getTime() > i.start && s.opened_at!.getTime() < i.end)
        .sort((a, b) => a.opened_at!.getTime() - b.opened_at!.getTime())[0];
      return first ? (first.opened_at!.getTime() - i.start) / 1000 : null;
    })
    .filter((w): w is number => w !== null);
  const minutes = (ms: number) => Math.round(ms / 60_000);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    from: r.from,
    to: r.to,
    target_pct: TARGET_PCT,
    readings: total,
    agreement_pct: total ? Math.round(((tp + tn) / total) * 1000) / 10 : null,
    confusion: { occupied_and_open: tp, occupied_no_visit: fp, missed_open_visit: fn, vacant_and_closed: tn },
    tables: [...byTable.values()]
      .map((t) => ({ ...t, agreement_pct: Math.round((t.agree / t.readings) * 1000) / 10 }))
      .sort((a, b) => a.agreement_pct - b.agreement_pct),
    dwell: {
      visits_seen: intervals.length,
      avg_minutes: intervals.length ? minutes(avg(intervals.map((i) => i.end - i.start))!) : null,
      without_order: withoutOrder.length,
      without_order_minutes: minutes(withoutOrder.reduce((a, i) => a + i.end - i.start, 0)),
      avg_wait_to_attend_seconds: waits.length ? Math.round(avg(waits)!) : null,
    },
  };
}
