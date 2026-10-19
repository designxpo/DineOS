const NAV_HELP: Record<string, [string, string]> = {
  '/app': ['See today’s sales, orders and table activity. Use the cards to review how service is going.', 'आज की बिक्री, ऑर्डर और टेबल की स्थिति देखें।'],
  '/app/inbox': ['Review incoming orders, check their details and follow their progress through service.', 'नए ऑर्डर की जानकारी और सर्विस की प्रगति देखें।'],
  '/app/kds': ['View kitchen tickets. Choose your station and update tickets as food is prepared.', 'किचन टिकट देखें। अपना स्टेशन चुनें और खाना तैयार होने पर स्थिति बदलें।'],
  '/app/floor': ['See table status, seat guests and open a table to manage its service.', 'टेबल की स्थिति देखें, मेहमान बैठाएँ और सर्विस के लिए टेबल खोलें।'],
  '/app/pos': ['Create an order by selecting dishes and quantities, then review it before sending.', 'व्यंजन और मात्रा चुनकर ऑर्डर बनाएँ। भेजने से पहले उसे जाँचें।'],
  '/app/bills': ['Find a bill, review its items and manage payment using the actions available to your role.', 'बिल खोजें, व्यंजन जाँचें और अपनी भूमिका के अनुसार भुगतान संभालें।'],
  '/app/reservations': ['Review bookings and record reservations for arriving guests.', 'बुकिंग देखें और आने वाले मेहमानों का आरक्षण दर्ज करें।'],
  '/app/customers': ['Find guest records and review their details.', 'मेहमानों के रिकॉर्ड खोजें और उनकी जानकारी देखें।'],
  '/app/loyalty': ['Manage your restaurant’s loyalty programme and rewards.', 'रेस्तराँ का लॉयल्टी कार्यक्रम और पुरस्कार संभालें।'],
  '/app/menu': ['Find dishes and manage availability. Editing options depend on your role.', 'व्यंजन खोजें और उपलब्धता बदलें। संपादन विकल्प आपकी भूमिका पर निर्भर हैं।'],
  '/app/inventory': ['Review stock and record inventory activity to keep quantities up to date.', 'स्टॉक देखें और मात्रा सही रखने के लिए इन्वेंटरी गतिविधि दर्ज करें।'],
  '/app/tables': ['Manage restaurant tables and their guest ordering QR codes.', 'रेस्तराँ की टेबल और मेहमानों के ऑर्डर के QR कोड संभालें।'],
  '/app/reports': ['Choose a report and date range to review sales and restaurant performance.', 'बिक्री और रेस्तराँ का प्रदर्शन देखने के लिए रिपोर्ट और तारीखें चुनें।'],
  '/app/close': ['Review the day’s totals and complete your closing checks.', 'दिन के कुल आँकड़े देखें और दिन बंद करने की जाँच पूरी करें।'],
  '/app/reconcile': ['Import a bank statement and compare receipts with recorded payments. Review differences before confirming matches.', 'बैंक स्टेटमेंट आयात करके दर्ज भुगतान से मिलाएँ। पुष्टि से पहले अंतर जाँचें।'],
  '/app/staff': ['Manage staff accounts, outlet access and roles.', 'कर्मचारियों के खाते, आउटलेट की पहुँच और भूमिकाएँ संभालें।'],
  '/app/settings': ['Review and update this outlet’s settings. Check your changes before saving.', 'आउटलेट की सेटिंग देखें और बदलें। सहेजने से पहले बदलाव जाँचें।'],
  '/app/account': ['Review your own account and available security settings.', 'अपना खाता और उपलब्ध सुरक्षा सेटिंग देखें।'],
};

const CONTROL_HELP: Record<string, [string, string]> = {
  replay: ['Restart the guided walkthrough. You can close it at any time and continue working.', 'परिचय दोबारा शुरू करें। इसे कभी भी बंद करके काम जारी रख सकते हैं।'],
  sound: ['Open sound settings to enable alerts and choose which activity you hear.', 'सूचनाओं की आवाज़ चालू करने और गतिविधि चुनने के लिए ध्वनि सेटिंग खोलें।'],
  language: ['Switch the staff portal between English and Hindi.', 'स्टाफ पोर्टल को अंग्रेज़ी और हिंदी के बीच बदलें।'],
  help: ['Ask support a question, report a problem or check replies to your requests.', 'सहायता माँगें, समस्या बताएँ या अपने अनुरोधों के जवाब देखें।'],
  stations: ['Choose a station to see its kitchen tickets, or select all stations.', 'किचन टिकट देखने के लिए स्टेशन चुनें या सभी स्टेशन चुनें।'],
};

const TARGETS = '[data-help], [data-tour-link], [data-tour]:not([data-tour="navigation"]), button, a[href], input:not([type="hidden"]), select, textarea, [role="tab"], [role="button"]';

export function helpFor(element: HTMLElement, hindi: boolean): { title: string; description: string } | null {
  const copy = (en: string, hi: string) => hindi ? hi : en;
  const labels = (element as HTMLInputElement).labels;
  const title = (element.dataset.helpTitle || element.getAttribute('aria-label') || element.getAttribute('title') ||
    labels?.[0]?.textContent || (element.matches('input, select, textarea') ? element.getAttribute('placeholder') : element.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (!title) return null;
  let description = (hindi && element.dataset.helpHi) || element.dataset.help;
  const known = CONTROL_HELP[element.dataset.tour ?? ''] || NAV_HELP[element.dataset.tourLink ?? element.getAttribute('href') ?? ''];
  description ||= known?.[hindi ? 1 : 0];
  if (!description) {
    if (element.matches(':disabled, [aria-disabled="true"]')) description = copy('This control is currently unavailable. Complete the required fields or steps on this screen first.', 'यह नियंत्रण अभी उपलब्ध नहीं है। पहले स्क्रीन पर आवश्यक जानकारी या चरण पूरे करें।');
    else if (element.matches('input[type="checkbox"], input[type="radio"]')) description = copy('Select this option to change your selection. Review the form before saving.', 'अपना चयन बदलने के लिए यह विकल्प चुनें। सहेजने से पहले फ़ॉर्म जाँचें।');
    else if (element.matches('select')) description = copy('Open the list and choose an option.', 'सूची खोलें और एक विकल्प चुनें।');
    else if (element.matches('input, textarea')) description = copy('Enter or edit this field. Follow any format or validation message shown beside it.', 'इस फ़ील्ड में जानकारी भरें या बदलें। पास में दिए प्रारूप और निर्देशों का पालन करें।');
    else if (element.matches('a')) description = copy('Open this link to view the named page or resource.', 'दिए पेज या जानकारी को देखने के लिए यह लिंक खोलें।');
    else description = copy('Activate this control to perform the named action. Review any options or confirmation shown before continuing.', 'दिया काम करने के लिए यह नियंत्रण चुनें। आगे बढ़ने से पहले विकल्प या पुष्टि जाँचें।');
  }
  return { title, description };
}

/** Delegated listeners cover controls added by queries, sheets and route updates. */
export function installHoverHelp(hindi: boolean): () => void {
  let target: HTMLElement | null = null;
  let bubble: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let previousDescription: string | null = null;
  const id = 'mezmitra-context-help';

  const hide = () => {
    clearTimeout(timer);
    clearTimeout(leaveTimer);
    if (target && bubble) {
      if (previousDescription === null) target.removeAttribute('aria-describedby');
      else target.setAttribute('aria-describedby', previousDescription);
    }
    bubble?.remove();
    bubble = null;
    target = null;
  };
  const show = () => {
    if (!target?.isConnected || document.body.classList.contains('driver-active') || document.hidden) return;
    const help = helpFor(target, hindi);
    if (!help || !target.getClientRects().length) return;
    bubble = document.createElement('div');
    bubble.id = id;
    bubble.className = 'mezmitra-hover-help';
    bubble.setAttribute('role', 'tooltip');
    const heading = document.createElement('strong');
    const text = document.createElement('p');
    // Never interpolate labels or user-provided values into HTML.
    heading.textContent = help.title;
    text.textContent = help.description;
    bubble.append(heading, text);
    document.body.append(bubble);
    const rect = target.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    bubble.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - box.width - 12))}px`;
    const top = rect.bottom + 8 + box.height < window.innerHeight ? rect.bottom + 8 : rect.top - box.height - 8;
    bubble.style.top = `${Math.max(12, Math.min(top, window.innerHeight - box.height - 12))}px`;
    previousDescription = target.getAttribute('aria-describedby');
    target.setAttribute('aria-describedby', [previousDescription, id].filter(Boolean).join(' '));
  };
  const enter = (event: Event) => {
    if (event instanceof PointerEvent && event.pointerType === 'touch') return;
    const node = event.target instanceof Element ? event.target : null;
    if (node?.closest('.mezmitra-hover-help')) { clearTimeout(leaveTimer); return; }
    if (document.body.classList.contains('driver-active') || node?.closest('.driver-popover')) return;
    const next = node?.closest<HTMLElement>(TARGETS) ?? null;
    if (next === target) { clearTimeout(leaveTimer); return; }
    hide();
    if (!next || !helpFor(next, hindi)) return;
    target = next;
    timer = setTimeout(show, 4000);
  };
  const leave = (event: Event) => {
    const related = (event as PointerEvent | FocusEvent).relatedTarget;
    if (related instanceof Node && (target?.contains(related) || bubble?.contains(related))) return;
    clearTimeout(timer);
    clearTimeout(leaveTimer);
    // Allow moving from a target across the small gap onto its tooltip.
    if (bubble) leaveTimer = setTimeout(hide, 150);
    else hide();
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
  const observer = new MutationObserver(() => {
    if (document.body.classList.contains('driver-active')) hide();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('pointerover', enter);
  document.addEventListener('pointerout', leave);
  document.addEventListener('focusin', enter);
  document.addEventListener('focusout', leave);
  document.addEventListener('keydown', keydown);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('input', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('visibilitychange', hide);
  window.addEventListener('resize', hide);
  return () => {
    hide();
    observer.disconnect();
    document.removeEventListener('pointerover', enter);
    document.removeEventListener('pointerout', leave);
    document.removeEventListener('focusin', enter);
    document.removeEventListener('focusout', leave);
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('pointerdown', hide, true);
    document.removeEventListener('input', hide, true);
    document.removeEventListener('scroll', hide, true);
    document.removeEventListener('visibilitychange', hide);
    window.removeEventListener('resize', hide);
  };
}
