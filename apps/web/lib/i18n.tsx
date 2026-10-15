'use client';

// English and Hindi (spec §12). Guest screens and the floor/kitchen screens are fully bilingual;
// owner and admin screens are English for now.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Translations } from '@dineos/shared/dto';
import { readLocal, writeLocal } from './storage';

export type Lang = 'en' | 'hi';

const en = {
  'guest.table': 'Table {label}',
  'guest.search': 'Search dishes',
  'guest.veg_only': 'Veg only',
  'guest.add': 'Add',
  'guest.added': 'Added to cart',
  'guest.sold_out': 'Sold out',
  'guest.not_now': 'Not available now',
  'guest.customisable': 'Customisable',
  'guest.required': 'Required',
  'guest.optional': 'Optional',
  'guest.choose_n': 'Choose {n}',
  'guest.choose_up_to': 'Choose up to {n}',
  'guest.note_placeholder': 'Any instructions? (less spicy, no onion...)',
  'guest.add_item': 'Add item',
  'guest.view_cart': 'View cart',
  'guest.items_n': '{n} items',
  'guest.item_1': '1 item',
  'guest.cart': 'Your table’s cart',
  'guest.cart_shared': 'Everyone at this table shares this cart',
  'guest.cart_empty': 'Your cart is empty',
  'guest.cart_empty_hint': 'Add dishes from the menu to get started.',
  'guest.order_note': 'Note for the kitchen',
  'guest.subtotal': 'Subtotal',
  'guest.taxes': 'GST',
  'guest.service_charge': 'Service charge',
  'guest.estimated_total': 'Estimated total',
  'guest.order_now': 'Order now',
  'guest.placing': 'Placing order…',
  'guest.your_orders': 'Your orders',
  'guest.order_n': 'Order #{n}',
  'guest.add_more': 'Add more items',
  'guest.call_waiter': 'Call waiter',
  'guest.waiter_coming': 'A waiter is on the way',
  'guest.request_bill': 'Request bill',
  'guest.bill_requested': 'Bill requested',
  'guest.pay_upi': 'Pay with UPI',
  'guest.pay_upi_hint': 'Pay to the restaurant’s UPI ID, then show the payment screen to staff.',
  'guest.bill_total': 'Bill total',
  'guest.paid': 'Paid',
  'guest.balance': 'Balance',
  'guest.session_ended': 'This visit has ended',
  'guest.session_ended_hint': 'Thanks for dining with us! Scan the table QR code again to start a new order.',
  'guest.scan_again': 'Start a new order',
  'guest.invalid_qr': 'This QR code isn’t working',
  'guest.invalid_qr_hint': 'Please ask a staff member for help.',
  'guest.offline': 'You’re offline. We’ll reconnect automatically.',
  'guest.menu': 'Menu',
  'guest.status': 'Order status',
  'guest.prices_note': 'Prices exclude GST unless stated.',
  'status.placed': 'Waiting for confirmation',
  'status.accepted': 'Confirmed',
  'status.preparing': 'Being prepared',
  'status.ready': 'Ready',
  'status.served': 'Served',
  'status.billed': 'Billed',
  'status.rejected': 'Not accepted',
  'status.cancelled': 'Cancelled',
  'item.placed': 'Waiting',
  'item.accepted': 'Confirmed',
  'item.preparing': 'Cooking',
  'item.ready': 'Ready',
  'item.served': 'Served',
  'item.cancelled': 'Cancelled',
  'table.vacant': 'Vacant',
  'table.occupied': 'Occupied',
  'table.ordered': 'Ordered',
  'table.served': 'Served',
  'table.bill_requested': 'Bill requested',
  'table.needs_cleaning': 'Needs cleaning',
  'kds.start': 'Start',
  'kds.ready': 'Ready',
  'kds.all_ready': 'All ready',
  'kds.empty': 'No orders in the kitchen',
  'kds.empty_hint': 'New orders appear here the moment they are accepted.',
  'kds.all_stations': 'All stations',
  'common.language': 'हिंदी',
};

type Key = keyof typeof en;

const hi: Record<Key, string> = {
  'guest.table': 'टेबल {label}',
  'guest.search': 'व्यंजन खोजें',
  'guest.veg_only': 'केवल शाकाहारी',
  'guest.add': 'जोड़ें',
  'guest.added': 'कार्ट में जोड़ा गया',
  'guest.sold_out': 'ख़त्म हो गया',
  'guest.not_now': 'अभी उपलब्ध नहीं',
  'guest.customisable': 'अपने हिसाब से',
  'guest.required': 'ज़रूरी',
  'guest.optional': 'वैकल्पिक',
  'guest.choose_n': '{n} चुनें',
  'guest.choose_up_to': 'अधिकतम {n} चुनें',
  'guest.note_placeholder': 'कोई निर्देश? (कम तीखा, बिना प्याज़...)',
  'guest.add_item': 'आइटम जोड़ें',
  'guest.view_cart': 'कार्ट देखें',
  'guest.items_n': '{n} आइटम',
  'guest.item_1': '1 आइटम',
  'guest.cart': 'आपकी टेबल का कार्ट',
  'guest.cart_shared': 'इस टेबल पर सभी एक ही कार्ट इस्तेमाल करते हैं',
  'guest.cart_empty': 'आपका कार्ट ख़ाली है',
  'guest.cart_empty_hint': 'शुरू करने के लिए मेन्यू से व्यंजन जोड़ें।',
  'guest.order_note': 'रसोई के लिए नोट',
  'guest.subtotal': 'उप-योग',
  'guest.taxes': 'जीएसटी',
  'guest.service_charge': 'सर्विस चार्ज',
  'guest.estimated_total': 'अनुमानित कुल',
  'guest.order_now': 'ऑर्डर करें',
  'guest.placing': 'ऑर्डर भेजा जा रहा है…',
  'guest.your_orders': 'आपके ऑर्डर',
  'guest.order_n': 'ऑर्डर #{n}',
  'guest.add_more': 'और आइटम जोड़ें',
  'guest.call_waiter': 'वेटर को बुलाएँ',
  'guest.waiter_coming': 'वेटर आ रहे हैं',
  'guest.request_bill': 'बिल मँगाएँ',
  'guest.bill_requested': 'बिल मँगाया गया',
  'guest.pay_upi': 'UPI से भुगतान करें',
  'guest.pay_upi_hint': 'रेस्टोरेंट की UPI ID पर भुगतान करें, फिर स्टाफ़ को भुगतान स्क्रीन दिखाएँ।',
  'guest.bill_total': 'बिल राशि',
  'guest.paid': 'भुगतान हुआ',
  'guest.balance': 'बाक़ी',
  'guest.session_ended': 'यह विज़िट समाप्त हो गई',
  'guest.session_ended_hint': 'हमारे साथ भोजन करने के लिए धन्यवाद! नया ऑर्डर शुरू करने के लिए QR कोड फिर से स्कैन करें।',
  'guest.scan_again': 'नया ऑर्डर शुरू करें',
  'guest.invalid_qr': 'यह QR कोड काम नहीं कर रहा',
  'guest.invalid_qr_hint': 'कृपया स्टाफ़ से मदद लें।',
  'guest.offline': 'आप ऑफ़लाइन हैं। हम अपने आप दोबारा जुड़ जाएँगे।',
  'guest.menu': 'मेन्यू',
  'guest.status': 'ऑर्डर की स्थिति',
  'guest.prices_note': 'कीमतों में जीएसटी शामिल नहीं है, जब तक लिखा न हो।',
  'status.placed': 'पुष्टि का इंतज़ार',
  'status.accepted': 'पुष्टि हो गई',
  'status.preparing': 'बन रहा है',
  'status.ready': 'तैयार',
  'status.served': 'परोसा गया',
  'status.billed': 'बिल बना',
  'status.rejected': 'स्वीकार नहीं हुआ',
  'status.cancelled': 'रद्द',
  'item.placed': 'इंतज़ार',
  'item.accepted': 'पुष्टि',
  'item.preparing': 'बन रहा है',
  'item.ready': 'तैयार',
  'item.served': 'परोसा',
  'item.cancelled': 'रद्द',
  'table.vacant': 'ख़ाली',
  'table.occupied': 'भरी हुई',
  'table.ordered': 'ऑर्डर हुआ',
  'table.served': 'परोसा गया',
  'table.bill_requested': 'बिल माँगा',
  'table.needs_cleaning': 'सफ़ाई बाक़ी',
  'kds.start': 'शुरू करें',
  'kds.ready': 'तैयार',
  'kds.all_ready': 'सब तैयार',
  'kds.empty': 'रसोई में कोई ऑर्डर नहीं',
  'kds.empty_hint': 'ऑर्डर स्वीकार होते ही यहाँ दिखेंगे।',
  'kds.all_stations': 'सभी स्टेशन',
  'common.language': 'English',
};

const dictionaries: Record<Lang, Record<Key, string>> = { en, hi };

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  /** Picks the Hindi name of a menu entry when Hindi is on and one exists. */
  name: (entry: { name: string; translations?: Translations }) => string;
  description: (entry: { description?: string | null; translations?: Translations }) => string | null;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children, storageKey = 'dineos.lang' }: { children: React.ReactNode; storageKey?: string }) {
  const [lang, setLangState] = useState<Lang>('en');
  useEffect(() => {
    const saved = readLocal<Lang | null>(storageKey, null);
    if (saved) setLangState(saved);
    else if (navigator.language.startsWith('hi')) setLangState('hi');
  }, [storageKey]);
  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l);
      writeLocal(storageKey, l);
      document.documentElement.lang = l;
    },
    [storageKey],
  );
  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, vars) => {
        let s = dictionaries[lang][key] ?? en[key] ?? key;
        if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
        return s;
      },
      name: (e) => (lang === 'hi' && e.translations?.hi?.name) || e.name,
      description: (e) => (lang === 'hi' && e.translations?.hi?.description) || e.description || null,
    }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export type { Key as I18nKey };
