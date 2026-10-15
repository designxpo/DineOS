import type { AvailabilitySchedule } from './dto';
import { DEFAULT_TIMEZONE } from './dates';

/** Day of week (0 = Sunday) and minutes since midnight at `now` in `timeZone`. */
export function localClock(now: Date, timeZone = DEFAULT_TIMEZONE): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Whether a category's schedule is open now. No schedule means always open. A window whose end
 * is before its start runs past midnight (e.g. 22:00 to 02:00).
 */
export function isScheduleOpen(
  schedule: AvailabilitySchedule | null | undefined,
  now: Date,
  timeZone = DEFAULT_TIMEZONE,
): boolean {
  if (!schedule) return true;
  const { day, minutes } = localClock(now, timeZone);
  if (schedule.days?.length && !schedule.days.includes(day)) return false;
  if (!schedule.from || !schedule.to) return true;
  const from = toMinutes(schedule.from);
  const to = toMinutes(schedule.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export interface ModifierGroupRule {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  modifiers: { id: string; in_stock: boolean }[];
}

export type ModifierCheck =
  | { ok: true }
  | { ok: false; code: 'unknown_modifier' | 'modifier_out_of_stock' | 'too_few' | 'too_many'; group_id?: string; message: string };

/** Validates a guest's modifier picks against the item's groups. Same rules on phone and server. */
export function checkModifierSelection(groups: readonly ModifierGroupRule[], selected: readonly string[]): ModifierCheck {
  const owner = new Map<string, { group: ModifierGroupRule; inStock: boolean }>();
  for (const g of groups) for (const m of g.modifiers) owner.set(m.id, { group: g, inStock: m.in_stock });
  if (new Set(selected).size !== selected.length) {
    return { ok: false, code: 'too_many', message: 'The same option was picked twice' };
  }
  for (const id of selected) {
    const hit = owner.get(id);
    if (!hit) return { ok: false, code: 'unknown_modifier', message: 'That option is not available for this item' };
    if (!hit.inStock) {
      return { ok: false, code: 'modifier_out_of_stock', group_id: hit.group.id, message: 'An option you picked just ran out' };
    }
  }
  for (const g of groups) {
    const count = selected.filter((id) => owner.get(id)?.group.id === g.id).length;
    if (count < g.min_select) {
      return { ok: false, code: 'too_few', group_id: g.id, message: `Choose at least ${g.min_select} in ${g.name}` };
    }
    if (count > g.max_select) {
      return { ok: false, code: 'too_many', group_id: g.id, message: `Choose at most ${g.max_select} in ${g.name}` };
    }
  }
  return { ok: true };
}
