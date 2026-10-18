// The go-live rehearsal. Each scenario is marked by people, but Mezmitra also shows what it saw
// since the rehearsal began (the mixed order, the split, the ticket that failed and printed), so
// the signed sheet rests on evidence and not only on ticks.

import { sql } from 'kysely';
import { formatPaise } from '@mezmitra/shared/money';
import { GOLIVE_SCENARIOS, type GoliveResult, type GoliveScenario } from '@mezmitra/shared/golive';
import type { GoliveCheckDTO, GoliveDeviceDTO, GoliveEvidenceDTO, GoliveRehearsalDTO } from '@mezmitra/shared/dto';
import type { Tx } from '../../context';
import { deviceName } from '../../lib/device-name';
import { notFound } from '../../lib/errors';
import { printTargets } from '../print/jobs';

const METHOD: Record<string, string> = { cash: 'cash', upi: 'UPI', card_slip: 'card', other: 'other', room: 'room', platform: 'delivery app', wallet: 'wallet' };
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

type Evidence = Record<GoliveScenario, GoliveEvidenceDTO>;

/** What happened at the outlet since `since` that bears on each scenario. */
export async function evidence(tx: Tx, outletId: string, since: Date, timezone: string): Promise<Evidence> {
  const time = (d: Date) => new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone: timezone }).format(d);
  const out = {} as Evidence;

  const menu = await tx.db
    .selectFrom('menu_items')
    .select((eb) => [
      eb.fn.countAll<number>().as('items'),
      eb.fn.count<number>('category_id').distinct().as('categories'),
      eb.fn.count<number>(sql`case when tax_rate_bp = 0 then 1 end`).as('zero_tax'),
      eb.fn.count<number>(sql`case when photo_url is null then 1 end`).as('no_photo'),
      sql<string[]>`array_agg(distinct station)`.as('stations'),
    ])
    .where('outlet_id', '=', outletId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  const items = Number(menu.items);
  out.menu = {
    seen: items > 0,
    lines: items
      ? [
          `${items} dish${items === 1 ? '' : 'es'} in ${Number(menu.categories)} categor${Number(menu.categories) === 1 ? 'y' : 'ies'}, sent to ${list((menu.stations ?? []).filter(Boolean).sort())}.`,
          ...(Number(menu.zero_tax) ? [`${Number(menu.zero_tax)} at 0% GST: check these are right.`] : []),
          ...(Number(menu.no_photo) ? [`${Number(menu.no_photo)} without a photo.`] : []),
        ]
      : ['The menu is empty.'],
  };

  // Printers: every station with a printer, and the bill printer, printed something since the start.
  const outlet = await tx.db.selectFrom('outlets').select('kitchen_stations').where('id', '=', outletId).executeTakeFirstOrThrow();
  const targets = await printTargets(tx, outletId);
  const jobs = await tx.db
    .selectFrom('print_jobs')
    .select(['id', 'target', 'ref_id', 'status', 'attempts', 'last_error', 'created_at', 'printed_at'])
    .where('outlet_id', '=', outletId)
    .where('created_at', '>=', since)
    .where(sql<string>`doc->>'kind'`, '<>', 'drawer')
    .orderBy('created_at')
    .execute();
  if (!targets) {
    out.printers = { seen: false, lines: ['No print computer is connected to this outlet yet.'] };
  } else {
    const expected = [...outlet.kitchen_stations, 'bill'].filter((t) => targets.has(t));
    const printed = new Set(jobs.filter((j) => j.status === 'printed').map((j) => j.target));
    const done = expected.filter((t) => printed.has(t));
    const missing = expected.filter((t) => !printed.has(t));
    out.printers = {
      seen: expected.length > 0 && missing.length === 0,
      lines: [
        ...(done.length ? [`Printed at ${list(done.map((t) => (t === 'bill' ? 'the bill printer' : t)))}.`] : []),
        ...(missing.length ? [`Not yet: ${list(missing.map((t) => (t === 'bill' ? 'the bill printer' : t)))}.`] : []),
        ...(expected.length ? [] : ['No printer is set up for a station or bills.']),
      ],
    };
  }

  const mixed = await tx.db
    .selectFrom('orders')
    .innerJoin('kots', 'kots.order_id', 'orders.id')
    .select(['orders.order_no', sql<string[]>`array_agg(distinct kots.station order by kots.station)`.as('stations')])
    .where('orders.outlet_id', '=', outletId)
    .where('orders.created_at', '>=', since)
    .where('kots.is_reprint', '=', false)
    .groupBy(['orders.id', 'orders.order_no', 'orders.created_at'])
    .having(sql`count(distinct kots.station)`, '>=', 2)
    .orderBy('orders.created_at', 'desc')
    .limit(3)
    .execute();
  out.mixed_order = {
    seen: mixed.length > 0,
    lines: mixed.map((o) => `Order #${o.order_no} went to ${list(o.stations)}, each with only its dishes.`),
  };

  const splits = await tx.db
    .selectFrom('bills')
    .innerJoin('payments', 'payments.bill_id', 'bills.id')
    .select(['bills.invoice_no', sql<{ method: string; amount_paise: number }[]>`json_agg(json_build_object('method', payments.method, 'amount_paise', payments.amount_paise) order by payments.created_at)`.as('parts')])
    .where('bills.outlet_id', '=', outletId)
    .where('bills.created_at', '>=', since)
    .where('payments.kind', '=', 'payment')
    .groupBy(['bills.id', 'bills.invoice_no', 'bills.created_at'])
    .having(sql`count(payments.id)`, '>=', 2)
    .orderBy('bills.created_at', 'desc')
    .limit(3)
    .execute();
  out.split_bill = {
    seen: splits.length > 0,
    lines: splits.map((b) => `Bill ${b.invoice_no ?? '(draft)'} paid ${list(b.parts.map((p) => `${METHOD[p.method] ?? p.method} ${formatPaise(p.amount_paise)}`))}.`),
  };

  const comps = await tx.db
    .selectFrom('comps')
    .innerJoin('order_items', 'order_items.id', 'comps.order_item_id')
    .leftJoin('users', 'users.id', 'comps.approved_by')
    .select(['order_items.name_snapshot', 'comps.reason', 'comps.whole_bill', 'users.name as approver'])
    .where('comps.outlet_id', '=', outletId)
    .where('comps.created_at', '>=', since)
    .where('comps.removed_at', 'is', null)
    .orderBy('comps.created_at', 'desc')
    .limit(3)
    .execute();
  out.free_dish = {
    seen: comps.length > 0,
    lines: comps.map((c) => `${c.whole_bill ? 'A whole bill' : c.name_snapshot} on the house (${c.reason.replaceAll('_', ' ')})${c.approver ? `, approved by ${c.approver}` : ''}.`),
  };

  const cancelled = await tx.db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .select(['order_items.name_snapshot', 'orders.order_no'])
    .where('orders.outlet_id', '=', outletId)
    .where('order_items.status', '=', 'cancelled')
    .where('order_items.cancelled_made', '=', true)
    .where('order_items.updated_at', '>=', since)
    .orderBy('order_items.updated_at', 'desc')
    .limit(3)
    .execute();
  out.cooked_cancel = {
    seen: cancelled.length > 0,
    lines: cancelled.map((c) => `${c.name_snapshot} on order #${c.order_no} cancelled after it was made: counted as waste.`),
  };

  // A ticket that failed, then printed: a retry that went through, or a reprint of the same ticket.
  const failed = jobs.filter((j) => j.status === 'failed' || (j.status === 'printed' && j.attempts > 1));
  const recovered = failed.filter(
    (j) => j.status === 'printed' || jobs.some((k) => k.status === 'printed' && k.target === j.target && k.ref_id === j.ref_id && k.created_at > j.created_at),
  );
  const stuck = failed.filter((j) => j.status === 'failed' && !recovered.includes(j) && j.last_error !== 'superseded by retry');
  const where = (t: string) => (t === 'bill' ? 'a bill' : `a ${t} ticket`);
  out.printer_out = {
    seen: recovered.length > 0,
    lines: [
      ...recovered.slice(0, 2).map((j) => `${where(j.target)[0]!.toUpperCase()}${where(j.target).slice(1)} did not print at ${time(j.created_at)}, then printed once fixed.`),
      ...stuck.slice(0, 2).map((j) => `${where(j.target)[0]!.toUpperCase()}${where(j.target).slice(1)} did not print${j.last_error ? ` (${j.last_error})` : ''} and has not printed since.`),
    ],
  };

  const offline = await tx.db
    .selectFrom('orders')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('outlet_id', '=', outletId)
    .where('created_at', '>=', since)
    .where('offline_ref', 'is not', null)
    .executeTakeFirstOrThrow();
  out.internet_off = Number(offline.n)
    ? { seen: true, lines: [`${Number(offline.n)} order${Number(offline.n) === 1 ? '' : 's'} came in through the outlet hub while the internet was off.`] }
    : { seen: false, lines: ['A short drop is kept on each phone and sent on reconnect, which Mezmitra cannot see from here: count the orders and bills on each device before and after.'] };

  const packs = await tx.db
    .selectFrom('audit_log')
    .leftJoin('users', 'users.id', 'audit_log.actor_user_id')
    .select(['audit_log.created_at', 'users.name'])
    .where('audit_log.outlet_id', '=', outletId)
    .where('audit_log.action', '=', 'report.month_pack')
    .where('audit_log.created_at', '>=', since)
    .orderBy('audit_log.created_at', 'desc')
    .limit(1)
    .execute();
  out.day_end = {
    seen: packs.length > 0,
    lines: packs.map((p) => `Month-end pack downloaded at ${time(p.created_at)}${p.name ? ` by ${p.name}` : ''}.`),
  };
  return out;
}

/** The screens and print computers that were on during the rehearsal. */
async function devicesUsed(tx: Tx, outletId: string, since: Date): Promise<GoliveDeviceDTO[]> {
  const screens = await tx.db
    .selectFrom('screens')
    .leftJoin('users', 'users.id', 'screens.user_id')
    .select(['screens.label', 'screens.kind', 'screens.user_agent', 'users.name as user_name'])
    .where('screens.outlet_id', '=', outletId)
    .where('screens.last_seen_at', '>=', since)
    .orderBy('screens.kind')
    .execute();
  const agents = await tx.db
    .selectFrom('devices')
    .select(['name'])
    .where('outlet_id', '=', outletId)
    .where('kind', '=', 'print_agent')
    .where('last_seen_at', '>=', since)
    .orderBy('name')
    .execute();
  return [
    ...screens.map((s) => ({
      kind: 'screen' as const,
      name: s.label || `${s.kind[0]!.toUpperCase()}${s.kind.slice(1)} screen`,
      detail: [deviceName(s.user_agent), s.user_name && `signed in as ${s.user_name}`].filter(Boolean).join(', ') || null,
    })),
    ...agents.map((a) => ({ kind: 'print_computer' as const, name: a.name, detail: null })),
  ];
}

interface SheetSnapshot {
  checks: GoliveCheckDTO[];
  devices: GoliveDeviceDTO[];
}

/** The rehearsal as the screen and the sheet show it: live while open, frozen once signed. */
export async function rehearsalView(tx: Tx, id: string): Promise<GoliveRehearsalDTO> {
  const r = await tx.db
    .selectFrom('golive_rehearsals')
    .innerJoin('outlets', 'outlets.id', 'golive_rehearsals.outlet_id')
    .innerJoin('tenants', 'tenants.id', 'golive_rehearsals.tenant_id')
    .leftJoin('users', 'users.id', 'golive_rehearsals.started_by')
    .select([
      'golive_rehearsals.id',
      'golive_rehearsals.outlet_id',
      'golive_rehearsals.started_at',
      'golive_rehearsals.signed_at',
      'golive_rehearsals.signer_name',
      'golive_rehearsals.sheet',
      'outlets.name as outlet_name',
      'outlets.created_at as outlet_created_at',
      'outlets.timezone',
      'tenants.name as tenant_name',
      'users.name as started_by_name',
    ])
    .where('golive_rehearsals.id', '=', id)
    .executeTakeFirst();
  if (!r) throw notFound('Rehearsal');
  let checks: GoliveCheckDTO[];
  let devices: GoliveDeviceDTO[];
  if (r.sheet) {
    ({ checks, devices } = r.sheet as unknown as SheetSnapshot);
  } else {
    const marks = await tx.db
      .selectFrom('golive_checks')
      .leftJoin('users', 'users.id', 'golive_checks.checked_by')
      .select(['golive_checks.scenario', 'golive_checks.result', 'golive_checks.note', 'golive_checks.failures', 'golive_checks.checked_at', 'users.name as checked_by_name'])
      .where('golive_checks.rehearsal_id', '=', id)
      .execute();
    const seen = await evidence(tx, r.outlet_id, r.started_at, r.timezone);
    checks = GOLIVE_SCENARIOS.map((scenario) => {
      const m = marks.find((x) => x.scenario === scenario);
      return {
        scenario,
        result: (m?.result as GoliveResult | undefined) ?? null,
        note: m?.note ?? null,
        failures: m?.failures ?? 0,
        checked_by_name: m?.checked_by_name ?? null,
        checked_at: m?.checked_at.toISOString() ?? null,
        evidence: seen[scenario],
      };
    });
    devices = await devicesUsed(tx, r.outlet_id, r.started_at);
  }
  return {
    id: r.id,
    outlet_id: r.outlet_id,
    outlet_name: r.outlet_name,
    tenant_name: r.tenant_name,
    outlet_created_at: r.outlet_created_at.toISOString(),
    started_at: r.started_at.toISOString(),
    started_by_name: r.started_by_name,
    signed_at: r.signed_at?.toISOString() ?? null,
    signer_name: r.signer_name,
    checks,
    devices,
    ready: checks.every((c) => c.result === 'passed' || c.result === 'out_of_scope'),
  };
}
