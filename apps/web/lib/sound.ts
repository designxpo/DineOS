// New-order chime generated with Web Audio: no audio files, works offline. Browsers only allow
// sound after a user gesture, so screens call unlockSound() from a button press.

let ctx: AudioContext | null = null;

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

function tone(freq: number, start: number, duration: number, gain = 0.18) {
  if (!ctx) return;
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

/** Two rising notes for a new order; three for a waiter call; a double ding for food at the pass. */
export function chime(kind: 'order' | 'call' | 'ready' = 'order'): void {
  if (!soundReady()) return;
  if (kind === 'ready') {
    tone(1568, 0, 0.3);
    tone(1568, 0.2, 0.45);
    return;
  }
  tone(880, 0, 0.35);
  tone(1320, 0.18, 0.5);
  if (kind === 'call') tone(1760, 0.36, 0.45, 0.14);
}
