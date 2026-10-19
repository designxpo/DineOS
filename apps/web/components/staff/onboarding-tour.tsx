'use client';

import { driver, type DriveStep } from 'driver.js';
import { Compass } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useI18n } from '@/lib/i18n';
import { useStaff } from '@/lib/staff';
import { cn } from '@/components/ui/cn';

/** Only target visible controls: desktop navigation and phone tabs coexist in the DOM. */
function visibleTarget(selector: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
    (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
  );
}

export function OnboardingTour({ dark = false }: { dark?: boolean }) {
  const { me, outlet, outletId } = useStaff();
  const { lang } = useI18n();
  const pathname = usePathname();
  const start = useRef<() => void>(() => {});
  const ready = !!outlet;
  const storageKey = `mezmitra.onboarding.v1:${me.tenant.id}:${me.user.id}`;
  const supportSession = !!me.impersonated_by;

  useEffect(() => {
    if (!ready) return;
    const hi = lang === 'hi';
    const copy = (en: string, hindi: string) => hi ? hindi : en;
    const tour = driver({
      animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      showProgress: true,
      progressText: hi ? '{{current}} / {{total}}' : '{{current}} of {{total}}',
      showButtons: ['previous', 'next', 'close'],
      nextBtnText: copy('Next', 'आगे'),
      prevBtnText: copy('Previous', 'पीछे'),
      doneBtnText: copy('Done', 'पूरा हुआ'),
      allowClose: true,
      disableActiveInteraction: true,
      popoverClass: 'mezmitra-tour',
      onPopoverRender: (popover) => {
        popover.closeButton.setAttribute('aria-label', copy('Close tour', 'परिचय बंद करें'));
      },
    });

    const launch = () => {
      if (tour.isActive()) return;
      const steps: DriveStep[] = [];
      const add = (selector: string, title: string, description: string) => {
        const element = visibleTarget(selector);
        if (element) steps.push({ element, popover: { title, description, side: 'bottom', align: 'center' } });
      };
      add('[data-tour="navigation"]', copy('Your workspace', 'आपका कार्यक्षेत्र'), copy(
        'Move between the screens available to your role. On a phone, use More to find the rest of your screens.',
        'अपनी भूमिका के अनुसार उपलब्ध स्क्रीन खोलें। फ़ोन पर बाकी स्क्रीन के लिए अधिक चुनें।',
      ));
      add('[data-tour-link="/app/inbox"]', copy('Incoming orders', 'नए ऑर्डर'), copy(
        'Review guest orders and follow their progress from the Orders screen.',
        'ऑर्डर स्क्रीन पर मेहमानों के ऑर्डर देखें और उनकी स्थिति जानें।',
      ));
      add('[data-tour-link="/app/floor"]', copy('Your restaurant floor', 'रेस्तराँ की टेबल'), copy(
        'See table availability, seat guests and keep track of service.',
        'खाली टेबल देखें, मेहमानों को बैठाएँ और सर्विस पर नज़र रखें।',
      ));
      add('[data-tour-link="/app/pos"]', copy('Take an order', 'ऑर्डर लें'), copy(
        'Open the POS to add dishes and create an order for your guests.',
        'व्यंजन जोड़ने और मेहमानों का ऑर्डर बनाने के लिए POS खोलें।',
      ));
      add('[data-tour-link="/app/menu"]', copy('Your menu', 'आपका मेन्यू'), copy(
        'Find dishes and manage availability from the Menu screen.',
        'मेन्यू स्क्रीन पर व्यंजन खोजें और उपलब्धता बदलें।',
      ));
      add('[data-tour="stations"]', copy('Your kitchen station', 'आपका किचन स्टेशन'), copy(
        'Choose a station to focus on its tickets, or view all stations together.',
        'किसी स्टेशन के टिकट देखने के लिए उसे चुनें या सभी स्टेशन एक साथ देखें।',
      ));
      add('[data-tour="sound"]', copy('Hear new activity', 'नई गतिविधि की सूचना'), copy(
        'After the tour, open this control to enable sound and choose your alerts.',
        'परिचय के बाद यहाँ से आवाज़ चालू करें और अपनी सूचनाएँ चुनें।',
      ));
      add('[data-tour="language"]', copy('Choose your language', 'अपनी भाषा चुनें'), copy(
        'Switch between English and Hindi whenever you need.',
        'जब चाहें अंग्रेज़ी और हिंदी के बीच बदलें।',
      ));
      add('[data-tour="help"]', copy('Help is close by', 'मदद यहीं है'), copy(
        'Ask support a question or check replies without leaving your work.',
        'अपना काम छोड़े बिना सहायता माँगें या जवाब देखें।',
      ));
      add('[data-tour="replay"]', copy('You are ready', 'आप तैयार हैं'), copy(
        'Use the Take a tour button at the top to restart this walkthrough anytime. Hover over controls for four seconds to see help while you work.',
        'ऊपर परिचय देखें बटन से परिचय दोबारा शुरू करें। काम करते समय मदद के लिए किसी नियंत्रण पर चार सेकंड रुकें।',
      ));
      if (!steps.length) return;
      tour.setSteps(steps);
      tour.drive();
      // Dismissal counts as seen too. Support staff must not consume a user's first visit.
      if (tour.isActive() && !supportSession) {
        try { localStorage.setItem(storageKey, 'shown'); } catch { /* Manual replay still works. */ }
      }
    };
    start.current = launch;
    // Defer until layout settles; cancelling also avoids consuming the flag during Strict Mode cleanup.
    const frame = requestAnimationFrame(() => {
      if (supportSession) return;
      try {
        if (localStorage.getItem(storageKey) === 'shown') return;
        // Verify persistence before automatically showing a once-only tour.
        const probe = `${storageKey}:probe`;
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);
      } catch { return; }
      launch();
    });
    const close = () => tour.destroy();
    // Reflow can hide desktop/mobile targets. Replay will rebuild the correct steps.
    window.addEventListener('resize', close);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', close);
      start.current = () => {};
      tour.destroy();
    };
  }, [ready, storageKey, supportSession, lang, pathname, outletId]);

  const label = lang === 'hi' ? 'परिचय देखें' : 'Take a tour';
  return (
    <button type="button" data-tour="replay" disabled={!ready} onClick={() => start.current()}
      aria-label={label} title={label}
      className={cn('flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-current/20 px-2 text-xs font-semibold disabled:opacity-50 sm:px-3 sm:text-sm', dark ? 'text-stone-300 hover:bg-stone-800' : 'text-ink-soft hover:bg-stone-100')}>
      <Compass className="hidden size-4 sm:block" aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{lang === 'hi' ? 'परिचय' : 'Tour'}</span>
    </button>
  );
}
