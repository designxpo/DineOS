export { formatPaise, formatPrice, formatRate } from '@mezmitra/shared/money';

const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

export const time = (iso: string | Date) => timeFmt.format(new Date(iso));
export const date = (iso: string | Date) => dateFmt.format(new Date(iso));
export const dateTime = (iso: string | Date) => dateTimeFmt.format(new Date(iso));

export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

/** A span of minutes as people say it: "45 min", "2 h 5 min", and whole hours past ten. */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h >= 10 || m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

export function ago(iso: string, now = Date.now()): string {
  const m = minutesSince(iso, now);
  return m < 1 ? 'just now' : duration(m);
}

/** Today's date in India as YYYY-MM-DD. */
export function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export function rupeesInput(paise: number): string {
  return (paise / 100).toFixed(2).replace(/\.00$/, '');
}
