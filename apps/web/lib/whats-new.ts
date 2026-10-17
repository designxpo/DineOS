// What changed in each release, in plain words, so staff are never surprised by an update. Newest
// first. "moved" lists anything that is now somewhere else, so nobody has to hunt for it.

export interface WhatsNewEntry {
  id: string;
  date: string;
  items: { en: string; hi: string }[];
  moved: { en: string; hi: string }[];
}

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: '2026-10-17',
    date: '17 Oct 2026',
    items: [
      {
        en: 'Find dishes faster: type the first letters ("pt" for Paneer Tikka) or a short code, then press Enter to add it. Best sellers come first, and there is a Popular tab on the POS.',
        hi: 'व्यंजन जल्दी खोजें: शुरुआती अक्षर ("pt" यानी पनीर टिक्का) या छोटा कोड लिखें, फिर Enter दबाकर जोड़ें। सबसे ज़्यादा बिकने वाले पहले दिखते हैं, और POS पर "लोकप्रिय" टैब है।',
      },
      {
        en: 'Each screen has its own sounds: tap the bell to set the volume and choose which alerts make a sound. A ticket that did not print always sounds.',
        hi: 'हर स्क्रीन की अपनी आवाज़ें: घंटी दबाकर आवाज़ का स्तर और कौन से अलर्ट बजें, चुनें। जो टिकट प्रिंट नहीं हुआ, उसकी आवाज़ हमेशा आती है।',
      },
      {
        en: 'Loyalty: stamp cards, points, levels, birthday treats, paid memberships and a prepaid wallet. Use a guest\'s reward from their bill in one tap.',
        hi: 'लॉयल्टी: स्टैम्प कार्ड, पॉइंट, लेवल, जन्मदिन ट्रीट, पेड मेंबरशिप और प्रीपेड वॉलेट। मेहमान का इनाम बिल से एक टैप में इस्तेमाल करें।',
      },
      {
        en: 'Owners can see which screens and print computers have the latest menu and settings (Settings → Screens), name each screen, and reload one that is behind.',
        hi: 'मालिक देख सकते हैं कि किन स्क्रीन और प्रिंट कंप्यूटर पर नया मेन्यू और सेटिंग है (सेटिंग्स → स्क्रीन), हर स्क्रीन का नाम रख सकते हैं, और पीछे रह गई स्क्रीन रीलोड कर सकते हैं।',
      },
      {
        en: 'Get help from any screen: tap the lifebuoy at the top, say how bad it is, and follow the case under Help. You see who from DineOS support is on it, and you close it only when it works.',
        hi: 'किसी भी स्क्रीन से मदद लें: ऊपर लाइफ़बॉय दबाएँ, बताएँ दिक्कत कितनी बड़ी है, और "मदद" में केस देखें। DineOS सपोर्ट से कौन देख रहा है, यह दिखता है, और केस तभी बंद होता है जब सब ठीक चले।',
      },
      {
        en: 'Reports explain themselves: tap the (i) by any figure to see what it counts. Owners can download a month-end pack for the accountant (Reports → Month-end pack) and save the reports they open often.',
        hi: 'रिपोर्ट खुद समझाती हैं: किसी भी आंकड़े के पास (i) दबाकर देखें कि उसमें क्या गिना गया। मालिक अकाउंटेंट के लिए महीने के अंत का पैक डाउनलोड कर सकते हैं (रिपोर्ट → Month-end pack) और बार-बार खुलने वाली रिपोर्ट सेव कर सकते हैं।',
      },
    ],
    moved: [
      {
        en: 'Loyalty settings moved from Settings to their own Loyalty page.',
        hi: 'लॉयल्टी सेटिंग अब सेटिंग्स में नहीं, अपने लॉयल्टी पेज पर हैं।',
      },
      {
        en: 'The kitchen screen\'s bell now opens sound settings; it still turns sound on.',
        hi: 'किचन स्क्रीन की घंटी अब आवाज़ की सेटिंग खोलती है; आवाज़ चालू भी करती है।',
      },
    ],
  },
];

const KEY = 'dineos.whatsnew.seen';

export function whatsNewUnseen(): boolean {
  try {
    return localStorage.getItem(KEY) !== WHATS_NEW[0]?.id;
  } catch {
    return false;
  }
}

export function markWhatsNewSeen(): void {
  try {
    localStorage.setItem(KEY, WHATS_NEW[0]?.id ?? '');
  } catch {
    // Private mode: it shows again next time.
  }
}
