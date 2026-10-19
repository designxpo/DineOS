'use client';

import { Bell, BellOff, Volume1, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { chime, saveSoundSettings, soundReady, soundSettings, unlockSound, type ChimeKind, type SoundSettings } from '@/lib/sound';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Switch } from '@/components/ui/primitives';

const KINDS: { kind: Exclude<ChimeKind, 'alert'>; label: I18nKey }[] = [
  { kind: 'order', label: 'sound.order' },
  { kind: 'call', label: 'sound.call' },
  { kind: 'ready', label: 'sound.ready' },
];

/** This screen's alert sounds: volume, which alerts make a sound, and a test for each. */
export function SoundSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [s, setS] = useState<SoundSettings>(() => soundSettings());
  const save = (next: SoundSettings) => {
    setS(next);
    saveSoundSettings(next);
  };
  const test = (kind: ChimeKind) => {
    unlockSound();
    // The context may need a moment to start after the first tap.
    setTimeout(() => chime(kind, s), 60);
  };
  return (
    <Sheet open={open} onClose={onClose} title={t('sound.title')}>
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('sound.volume')}</p>
          <div className="flex items-center gap-3">
            <Volume1 className="size-5 shrink-0 text-ink-faint" />
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(s.volume * 100)}
              onChange={(e) => save({ ...s, volume: Number(e.target.value) / 100 })}
              onPointerUp={() => test('order')}
              aria-label={t('sound.volume')}
              className="h-11 flex-1 cursor-pointer accent-[var(--brand)]"
            />
            <Volume2 className="size-5 shrink-0 text-ink-faint" />
            <span className="w-10 text-right text-sm tabular">{Math.round(s.volume * 100)}%</span>
          </div>
        </div>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {KINDS.map(({ kind, label }) => (
            <li key={kind} className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex-1 text-sm">{t(label)}</span>
              <Button size="sm" variant="ghost" onClick={() => test(kind)}>
                {t('sound.test')}
              </Button>
              <Switch label={t(label)} checked={!s.off.includes(kind)} onChange={(on) => save({ ...s, off: on ? s.off.filter((k) => k !== kind) : [...s.off, kind] })} />
            </li>
          ))}
          <li className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex-1 text-sm">
              {t('sound.alert')}
              <span className="block text-xs text-ink-faint">{t('sound.alert_note')}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => test('alert')}>
              {t('sound.test')}
            </Button>
          </li>
        </ul>
        <p className="text-xs text-ink-faint">{t('sound.device_note')}</p>
      </div>
    </Sheet>
  );
}

/** A bell that turns sound on (browsers need a tap first) and opens this screen's sound settings. */
export function SoundButton({ dark }: { dark?: boolean }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(() => (typeof window === 'undefined' ? false : soundReady()));
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-tour="sound"
        onClick={() => {
          setReady(unlockSound());
          setOpen(true);
        }}
        aria-label={ready ? t('sound.title') : t('sound.turn_on')}
        title={ready ? t('sound.title') : t('sound.turn_on')}
        className={cn('grid size-10 cursor-pointer place-items-center rounded-xl', dark ? 'text-stone-300 hover:bg-stone-800' : 'text-ink-soft hover:bg-stone-100')}
      >
        {ready ? <Bell className="size-5" /> : <BellOff className={cn('size-5', dark ? 'text-rose-400' : 'text-rose-600')} />}
      </button>
      <SoundSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
