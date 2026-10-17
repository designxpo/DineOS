// New-order chime generated with Web Audio: no audio files, works offline. Browsers only allow
// sound after a user gesture, so screens call unlockSound() from a button press. Each screen
// keeps its own volume and choice of alerts; urgent ones always sound, at least quietly.

let ctx: AudioContext | null = null;

export type ChimeKind = 'order' | 'call' | 'ready' | 'alert';
/** Something is wrong (a kitchen ticket did not print): never silenced on any screen. */
export const URGENT_KINDS: readonly ChimeKind[] = ['alert'];
const URGENT_MIN_VOLUME = 0.35;

export interface SoundSettings {
  /** 0 to 1. */
  volume: number;
  /** Alerts this screen keeps quiet. */
  off: ChimeKind[];
}

const KEY = 'dineos.sound';
const DEFAULTS: SoundSettings = { volume: 0.8, off: [] };

export function soundSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Partial<SoundSettings>) : {};
    return { volume: typeof s.volume === 'number' ? Math.min(1, Math.max(0, s.volume)) : DEFAULTS.volume, off: Array.isArray(s.off) ? s.off : [] };
  } catch {
    return DEFAULTS;
  }
}

export function saveSoundSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode: the settings last until the page closes.
  }
}

export function unlockSound(): boolean {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

export function soundReady(): boolean {
  return !!ctx && ctx.state === 'running';
}

function tone(freq: number, start: number, duration: number, gain = 0.22) {
  if (!ctx || gain <= 0) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + duration + 0.05);
}

/**
 * Two rising notes for a new order; three for a waiter call; a double ding for food at the pass;
 * three quick falling notes when something is wrong. Played at this screen's volume, unless this
 * screen turned that alert off (urgent ones cannot be).
 */
export function chime(kind: ChimeKind = 'order', settings: SoundSettings = soundSettings()): void {
  if (!soundReady()) return;
  const urgent = URGENT_KINDS.includes(kind);
  if (!urgent && settings.off.includes(kind)) return;
  const v = urgent ? Math.max(settings.volume, URGENT_MIN_VOLUME) : settings.volume;
  const g = 0.22 * v;
  if (kind === 'ready') {
    tone(1568, 0, 0.3, g);
    tone(1568, 0.2, 0.45, g);
    return;
  }
  if (kind === 'alert') {
    tone(1175, 0, 0.18, g);
    tone(988, 0.16, 0.18, g);
    tone(784, 0.32, 0.4, g);
    return;
  }
  tone(880, 0, 0.35, g);
  tone(1320, 0.18, 0.5, g);
  if (kind === 'call') tone(1760, 0.36, 0.45, g * 0.8);
}
