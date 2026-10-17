'use client';

import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { markWhatsNewSeen, whatsNewUnseen, WHATS_NEW } from '@/lib/whats-new';
import { Sheet } from '@/components/ui/overlay';

export function WhatsNewSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, lang } = useI18n();
  useEffect(() => {
    if (open) markWhatsNewSeen();
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={t('whatsnew.title')}>
      <div className="space-y-6">
        {WHATS_NEW.map((e) => (
          <section key={e.id} className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{e.date}</p>
            <ul className="space-y-2 text-sm">
              {e.items.map((i) => (
                <li key={i.en} className="flex gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--brand)]" />
                  {lang === 'hi' ? i.hi : i.en}
                </li>
              ))}
            </ul>
            {e.moved.length > 0 && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p className="font-medium">{t('whatsnew.moved')}</p>
                <ul className="mt-1 space-y-1">
                  {e.moved.map((m) => (
                    <li key={m.en}>{lang === 'hi' ? m.hi : m.en}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))}
      </div>
    </Sheet>
  );
}

/** A small "New" pill in the header until this person has read the latest notes. */
export function WhatsNewPill() {
  const { t } = useI18n();
  const [unseen, setUnseen] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => setUnseen(whatsNewUnseen()), []);
  if (!unseen && !open) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setUnseen(false);
        }}
        className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-brand-50 px-3 text-xs font-semibold text-brand-700"
      >
        <Sparkles className="size-3.5" /> {t('whatsnew.pill')}
      </button>
      <WhatsNewSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
