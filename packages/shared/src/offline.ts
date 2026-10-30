// Exactly what keeps working when an outlet's internet drops, published in the app and on the
// website so owners know before it happens. Keep this in step with the outbox (apps/web/lib/
// outbox.ts callers) and the outlet hub's routes (apps/print-agent/src/hub/server.ts).

export interface OfflineText {
  en: string;
  hi: string;
}

export interface OfflineLevel {
  id: 'device' | 'hub';
  title: OfflineText;
  summary: OfflineText;
  works: OfflineText[];
  waits: OfflineText[];
}

export const OFFLINE_LEVELS: readonly OfflineLevel[] = [
  {
    id: 'device',
    title: { en: 'A short drop, on each device', hi: 'थोड़ी देर का कटाव, हर डिवाइस पर' },
    summary: {
      en: 'Nothing to set up. Changes are kept on the phone or tablet that made them and sent, in order and only once, when the connection returns.',
      hi: 'कुछ सेट नहीं करना। बदलाव उसी फ़ोन या टैबलेट पर रहते हैं और कनेक्शन लौटने पर क्रम से, सिर्फ़ एक बार भेजे जाते हैं।',
    },
    works: [
      { en: 'New orders from the POS: counter, takeaway and dine-in', hi: 'POS से नए ऑर्डर: काउंटर, टेकअवे और डाइन-इन' },
      { en: 'Accepting, starting, readying and serving orders', hi: 'ऑर्डर स्वीकार करना, शुरू करना, तैयार और सर्व करना' },
      { en: 'Marking dishes ready on the kitchen screen', hi: 'किचन स्क्रीन पर व्यंजन तैयार बताना' },
      { en: 'Recording payments on an open bill: cash, UPI, card', hi: 'खुले बिल पर भुगतान दर्ज करना: नकद, UPI, कार्ड' },
    ],
    waits: [
      { en: 'Kitchen tickets and bills print once the line is back', hi: 'किचन टिकट और बिल लाइन लौटने पर प्रिंट होते हैं' },
      { en: 'Making and finalising bills, discounts, free dishes, refunds and anything needing a manager’s PIN', hi: 'बिल बनाना और फ़ाइनल करना, छूट, मुफ़्त व्यंजन, रिफ़ंड और मैनेजर PIN वाले काम' },
      { en: 'Once every staff screen is cut off, QR ordering pauses and guests are asked to order with a waiter', hi: 'जब हर स्टाफ़ स्क्रीन कट जाए, QR ऑर्डर रुक जाते हैं और मेहमानों से वेटर को ऑर्डर देने को कहा जाता है' },
      { en: 'Reports, the UPI check, loyalty and wallet, menu and settings changes', hi: 'रिपोर्ट, UPI जाँच, लॉयल्टी और वॉलेट, मेन्यू और सेटिंग्स बदलाव' },
    ],
  },
  {
    id: 'hub',
    title: { en: 'A longer outage, with the outlet hub', hi: 'लंबा कटाव, आउटलेट हब के साथ' },
    summary: {
      en: 'The Continuity add-on: a PC at the outlet keeps service running over your Wi-Fi and sends everything to Mezvaan when the line returns. Staff switch to it from the banner.',
      hi: 'Continuity ऐड-ऑन: आउटलेट का एक PC आपके Wi-Fi पर सर्विस चालू रखता है और लाइन लौटने पर सब Mezvaan को भेजता है। स्टाफ़ बैनर से उस पर जाते हैं।',
    },
    works: [
      { en: 'Signing in on devices that were used online before', hi: 'उन डिवाइस पर साइन-इन जो पहले ऑनलाइन इस्तेमाल हुए' },
      { en: 'The menu, tables (seat, clean, free up) and the kitchen screen', hi: 'मेन्यू, टेबल (बैठाना, साफ़, खाली करना) और किचन स्क्रीन' },
      { en: 'New POS and waiter orders, order and dish status, reprinting tickets', hi: 'नए POS और वेटर ऑर्डर, ऑर्डर और व्यंजन की स्थिति, टिकट दोबारा प्रिंट' },
      { en: 'Kitchen tickets and bills print on your printers', hi: 'किचन टिकट और बिल आपके प्रिंटर पर प्रिंट होते हैं' },
      { en: 'Bills: make, finalise (offline series, e.g. AGCH/2627/00001), print, and take cash, UPI, card or room payments', hi: 'बिल: बनाना, फ़ाइनल करना (ऑफ़लाइन सीरीज़, जैसे AGCH/2627/00001), प्रिंट करना, और नकद, UPI, कार्ड या कमरे का भुगतान लेना' },
    ],
    waits: [
      { en: 'New delivery-app orders: enter them once the line is back', hi: 'नए डिलीवरी-ऐप ऑर्डर: लाइन लौटने पर दर्ज करें' },
      { en: 'QR ordering (paused; guests order with a waiter)', hi: 'QR ऑर्डर (रुके रहते हैं; मेहमान वेटर को ऑर्डर देते हैं)' },
      { en: 'Bill discounts, free dishes, refunds, loyalty points and wallet payments', hi: 'बिल पर छूट, मुफ़्त व्यंजन, रिफ़ंड, लॉयल्टी पॉइंट और वॉलेट भुगतान' },
      { en: 'Reports, the UPI check and settings', hi: 'रिपोर्ट, UPI जाँच और सेटिंग्स' },
    ],
  },
];

/** What to do when the internet drops, in order. */
export const OFFLINE_CHECKLIST: readonly OfflineText[] = [
  { en: 'Check the router: open any website on the device. If only Mezvaan is stuck, ask for help from the lifebuoy.', hi: 'राउटर जाँचें: डिवाइस पर कोई भी वेबसाइट खोलें। अगर सिर्फ़ Mezvaan अटका है, तो लाइफ़बॉय से मदद माँगें।' },
  { en: 'Keep going: orders, kitchen updates and payments are kept on the device. Tap the connection dot at the top of the screen to see how many are waiting.', hi: 'काम जारी रखें: ऑर्डर, किचन अपडेट और भुगतान डिवाइस पर रहते हैं। कितने बाकी हैं, यह देखने के लिए स्क्रीन के ऊपर कनेक्शन वाला बिंदु दबाएँ।' },
  { en: 'Down for more than a few minutes and the outlet hub is set up? Switch to it from the banner.', hi: 'कुछ मिनट से ज़्यादा बंद है और आउटलेट हब लगा है? बैनर से उस पर जाएँ।' },
  { en: 'When it is back, press Send now on every device and check Waiting reaches 0 on each.', hi: 'लौटने पर हर डिवाइस पर "अभी भेजें" दबाएँ और देखें कि हर एक पर "बाकी" 0 हो जाए।' },
  { en: 'Anything refused: read why and redo it by hand if it is still needed. A change is never sent twice.', hi: 'जो अस्वीकार हुआ: कारण पढ़ें और ज़रूरत हो तो हाथ से दोबारा करें। कोई बदलाव दो बार नहीं भेजा जाता।' },
];
