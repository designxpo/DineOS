import type { Metadata } from 'next';
import {
  ArrowRight,
  BellRing,
  BookOpenCheck,
  CalendarCheck,
  ChefHat,
  ClipboardCheck,
  Gift,
  Languages,
  LifeBuoy,
  Palette,
  Printer,
  QrCode,
  ReceiptIndianRupee,
  ShieldCheck,
  Smartphone,
  Users,
  WifiOff,
} from 'lucide-react';
import { DemoForm } from '@/components/landing/demo-form';
import { LeakCalculator } from '@/components/landing/leak-calculator';
import { Pricing } from '@/components/landing/pricing';
import { DayEnd, FreeItem, HelpCase, Outage, ServiceAlerts, UpiMissing } from '@/components/landing/vignettes';

export const metadata: Metadata = {
  title: { absolute: 'Mezmitra · Every order reaches the kitchen. Every rupee is accounted for.' },
  description:
    'Service control for Indian restaurants and cafés: QR and waiter ordering, kitchen screens, GST billing, UPI checks and a day end that explains every rupee, on the phones and printers you already have.',
};

const NIGHT = [
  { time: '8:05 pm', what: 'Table 6 sat down nine minutes ago. Nobody has come.', cost: 'Guests who wait to order, order less, and remember it.' },
  { time: '8:20 pm', what: 'Two cold coffees are ready at the bar. Their waiter is out on the terrace.', cost: 'They melt, get remade, or reach the table late.' },
  { time: '8:40 pm', what: 'A handwritten ticket says “PBM”. The kitchen cooks the wrong dish.', cost: 'You pay for the food twice and say sorry once.' },
  { time: '9:15 pm', what: '“Payment done, sir.” The UPI screenshot looks real. The money never arrives.', cost: 'You find out days later, if at all.' },
  { time: '9:30 pm', what: 'A regular gets a free dessert. Nobody notes who gave it, or why.', cost: 'Generosity you cannot see becomes leakage you cannot stop.' },
  { time: '10:10 pm', what: 'The internet drops. Billing stops. A queue forms at the counter.', cost: 'Guests wait to pay. Some stop waiting.' },
  { time: '11:45 pm', what: 'Cash, card and UPI do not match the bills. Nobody knows why.', cost: 'You close late, still guessing.' },
  { time: '1st of the month', what: 'Your CA asks for sales, GST by rate, voids and discounts. Again.', cost: 'An evening of exports and spreadsheets.' },
];

const PROMISES = [
  {
    id: 'service',
    kicker: 'During service',
    title: 'Nothing slips through the rush.',
    pain: 'Orders, drinks and bill requests get lost between the table, the kitchen, the bar and the counter.',
    points: [
      'Guests order from their table on their own phone: a menu with photos, in English or Hindi. Prefer a waiter? They take it on their phone.',
      'Each station gets only its dishes, on screen and on paper: kitchen, tandoor, bar.',
      'The right waiter hears it: drinks ready at the bar, guests waiting with nobody seating them, a table asking for the bill.',
      'A ticket that did not print shows on every screen until someone reprints it.',
    ],
    measure: 'Time from ready to served, and tables waiting at the rush.',
    visual: <ServiceAlerts />,
  },
  {
    id: 'money',
    kicker: 'At close',
    title: 'Every rupee explained.',
    pain: 'Missing UPI, unrecorded free food and unbilled tables only show up as a number that does not add up.',
    points: [
      'Import your bank statement: Mezmitra shows the UPI payments that never arrived.',
      'Every free dish, discount and void carries a reason, who gave it, and the manager who approved it with a PIN.',
      'Tables served but not billed are flagged before the guests leave.',
      'Day end tells you the cash that should be in the drawer. Each figure says how it is worked out.',
    ],
    measure: 'Minutes to close, and differences you cannot explain.',
    visual: (
      <div className="space-y-3">
        <DayEnd />
        <div className="grid gap-3 sm:grid-cols-2">
          <UpiMissing />
          <FreeItem />
        </div>
      </div>
    ),
  },
  {
    id: 'offline',
    kicker: 'When the internet drops',
    title: 'Keep taking orders and printing bills.',
    pain: 'When billing lives only in the cloud, a router hiccup stops the counter on a full night.',
    points: [
      'A short drop: every tap is kept on the phone and sent when it reconnects.',
      'A long outage: the outlet hub on your counter PC keeps orders, kitchen tickets, bills and printing going, then sends everything when the internet is back (Continuity add-on).',
      'Before you go live, we pull the plug with your team and practise.',
    ],
    measure: 'Outage drills passed, and orders lost or doubled (the aim is none).',
    visual: <Outage />,
  },
  {
    id: 'help',
    kicker: 'From day one',
    title: 'Live in a day. Helped until it is fixed.',
    pain: 'Setups that drag on for weeks, and support that disappears when you need it most: on a Saturday night.',
    points: [
      'Send your menu as a spreadsheet; we import it with photos. Printers are found on your network.',
      'We rehearse your busiest order on your own devices. You sign it off before paying in full.',
      'Ask for help from any screen. Every case shows who owns it and where it stands, and it closes only when you say it works.',
      'Support is staffed every day, 11 am to 11 pm.',
    ],
    measure: 'Hours from setup to first full service, and time to get running again.',
    visual: <HelpCase />,
  },
];

const INCLUDED = [
  { icon: QrCode, title: 'Guests', items: ['QR menu with photos, in English and Hindi', 'Call the waiter, ask for the bill', 'Follow a takeaway order on their phone'] },
  { icon: Users, title: 'Floor', items: ['Live table map: seated, ordered, served, bill asked', 'Alerts to the right waiter', 'Reservations and the waiting list'] },
  { icon: ChefHat, title: 'Kitchen and bar', items: ['Kitchen screens by station', 'Printed tickets on your thermal printers', 'Sounds each screen sets for itself'] },
  { icon: ReceiptIndianRupee, title: 'Counter', items: ['Find any dish by its first letters', 'Split bills, UPI, card, cash, room charges', 'GST invoices without gaps'] },
  { icon: ShieldCheck, title: 'Owner', items: ['Live sales from your phone', 'UPI check against your bank', 'Free food, discounts and voids with names'] },
  { icon: Gift, title: 'Regulars', items: ['Stamp cards, points and levels', 'Birthday treats and paid memberships', 'A prepaid wallet'] },
  { icon: BookOpenCheck, title: 'Your CA', items: ['GST by rate, HSN and B2B', 'Delivery-app sales under section 9(5)', 'One Excel month-end pack'] },
  { icon: Palette, title: 'Your brand', items: ['Your logo and colours on the QR menu', 'And on every staff screen', 'A cover photo of your food'] },
];

const STEPS = [
  { icon: CalendarCheck, title: 'A 20-minute demo', body: 'On your phone, with your kind of menu. We show the four moments above, not a feature list.' },
  { icon: ClipboardCheck, title: 'Set up in a day', body: 'Your menu imported with photos, printers connected, QR cards for every table, staff added with their roles.' },
  { icon: Printer, title: 'A rehearsal you sign off', body: 'Your busiest order, a split bill, a free dish, a printer out of action, the internet off. On your own devices.' },
  { icon: BellRing, title: 'Your first full service', body: 'We are there for it. Then help is one tap away on every screen.' },
];

const FAQ = [
  {
    q: 'Do I need to buy new hardware?',
    a: 'Usually not. Mezmitra runs in the browser on Android phones, iPhones, tablets and PCs. Your thermal printers connect through a small free app on a Windows or Mac computer or a Raspberry Pi, by USB or over your network.',
  },
  {
    q: 'What happens when the internet goes down?',
    a: 'For a short drop, every tap is kept on the phone and sent when it reconnects. For longer outages, the Continuity add-on runs an outlet hub on your counter PC that keeps orders, kitchen tickets, bills and printing going, then syncs.',
  },
  {
    q: 'Will my staff manage it?',
    a: 'Waiters see only what a waiter needs, cooks see only their station, and dishes are found by their first letters. Every screen works in English and Hindi, and we train your team at go-live.',
  },
  {
    q: 'Is it ready for GST?',
    a: 'Invoices are numbered without gaps and a voided bill keeps its number. The month-end pack gives your CA GST by rate, the HSN summary, B2B invoices and delivery-app sales under section 9(5), with every figure defined. Your CA still files; they just get clean numbers.',
  },
  {
    q: 'Does it work with Zomato and Swiggy?',
    a: 'You record delivery orders on the POS, so the kitchen, stock and GST all see them, and Mezmitra works out the app commission. Orders do not flow in from the apps automatically yet.',
  },
  {
    q: 'Can the menu and screens carry our own logo?',
    a: 'Yes. On every plan your logo, colours and a cover photo appear on the QR menu, order tracking, the pickup screen and every staff screen.',
  },
  {
    q: 'We are a hotel restaurant. Can guests charge to their room?',
    a: 'Yes, bills can go to a room, and the front desk gets a list of charges to post. Posting into your hotel system is done by hand for now.',
  },
  {
    q: 'Who owns our data?',
    a: 'You do. Download all of it from Settings at any time. Each restaurant’s data is kept apart inside the database itself, not just by the app.',
  },
];

function Section({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={`scroll-mt-20 px-4 py-20 sm:px-6 sm:py-28 ${className ?? ''}`}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

function Kicker({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return <p className={`text-sm font-semibold tracking-wide uppercase ${dark ? 'text-accent' : 'text-[var(--brand)]'}`}>{children}</p>;
}

export default function Landing() {
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="sticky top-0 z-40 border-b border-line/70 bg-paper/85 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6" aria-label="Main">
          <a href="#top" className="flex shrink-0 items-center" aria-label="Mezmitra, home">
            <img src="/brand/wordmark.svg" alt="Mezmitra" className="h-9 w-auto" width={166} height={44} />
          </a>
          <div className="hidden items-center gap-6 text-sm font-medium text-ink-soft md:flex">
            <a href="#night" className="hover:text-ink">
              The problem
            </a>
            <a href="#how" className="hover:text-ink">
              How it works
            </a>
            <a href="#pricing" className="hover:text-ink">
              Pricing
            </a>
            <a href="#faq" className="hover:text-ink">
              Questions
            </a>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <a href="/login" className="hidden h-10 items-center rounded-xl px-3 text-sm font-medium text-ink-soft hover:text-ink sm:inline-flex">
              Sign in
            </a>
            <a href="#demo" className="inline-flex h-10 items-center rounded-xl bg-[var(--brand)] px-4 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98]">
              Book a demo
            </a>
          </div>
        </nav>
      </header>

      <main id="top">
        {/* ------------------------------------------------------------ hero */}
        <section className="relative overflow-hidden px-4 pt-14 pb-20 sm:px-6 sm:pt-20 lg:pb-28">
          <div className="pointer-events-none absolute -top-40 -right-40 size-[36rem] rounded-full bg-brand-100/70 blur-3xl" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm text-ink-soft">
                <span className="size-2 rounded-full bg-emerald-500" /> For restaurants and cafés with 10 to 40 tables
              </p>
              <h1 className="mt-6 font-display text-[2.6rem] leading-[1.05] font-semibold tracking-tight sm:text-6xl">
                Every order reaches the kitchen. <span className="text-[var(--brand)]">Every rupee is accounted for.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
                Mezmitra connects your guests’ QR orders, your waiters, kitchen, bar and billing counter on the phones and printers you already have. At close, it shows you exactly where every rupee went.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href="#demo" className="inline-flex h-12 items-center gap-2 rounded-xl bg-[var(--brand)] px-6 text-base font-semibold text-white shadow-[0_12px_30px_-12px_rgb(168_68_26/0.8)] transition hover:brightness-110 active:scale-[0.98]">
                  Book a 20-minute demo <ArrowRight className="size-4" />
                </a>
                <a href="#night" className="inline-flex h-12 items-center rounded-xl border border-line bg-surface px-6 text-base font-semibold transition hover:bg-stone-50">
                  See what slips through
                </a>
              </div>
              <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-soft">
                <li className="flex items-center gap-2">
                  <Smartphone className="size-4 text-ink-faint" /> Phones, tablets and PCs you own
                </li>
                <li className="flex items-center gap-2">
                  <Languages className="size-4 text-ink-faint" /> English and हिंदी
                </li>
                <li className="flex items-center gap-2">
                  <ReceiptIndianRupee className="size-4 text-ink-faint" /> GST invoices without gaps
                </li>
              </ul>
            </div>

            <div className="relative mx-auto w-full max-w-md">
              <div className="mx-auto w-[17rem] overflow-hidden rounded-[2.6rem] border-[10px] border-ink bg-surface shadow-[0_40px_80px_-30px_rgb(28_25_23/0.6)] sm:w-[19rem]">
                <img src="/landing/qr-menu.webp" alt="The QR menu a guest sees: dishes with photos, prices and an add button" className="block w-full" width={585} height={1266} />
              </div>
              <div className="absolute top-16 -left-2 w-60 sm:-left-10">
                <div className="flex gap-2.5 rounded-xl border border-line bg-surface p-3 shadow-[0_18px_40px_-18px_rgb(28_25_23/0.45)]">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-100 text-emerald-800">
                    <BellRing className="size-4" />
                  </span>
                  <p className="text-xs">
                    <span className="block font-semibold">Bar · Table C4</span>2 Cold Coffee ready · Ravi alerted
                  </p>
                </div>
              </div>
              <div className="absolute -right-2 bottom-20 w-60 sm:-right-8">
                <div className="flex gap-2.5 rounded-xl border border-rose-200 bg-surface p-3 shadow-[0_18px_40px_-18px_rgb(28_25_23/0.45)]">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-rose-100 text-rose-800">
                    <ReceiptIndianRupee className="size-4" />
                  </span>
                  <p className="text-xs">
                    <span className="block font-semibold">UPI ₹1,240 · Table 7</span>Not in your bank statement
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ the night */}
        <section id="night" className="scroll-mt-16 bg-ink px-4 py-20 text-white sm:px-6 sm:py-28">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-3xl">
              <Kicker dark>The real picture</Kicker>
              <h2 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">Saturday, 8 pm. Every table is full.</h2>
              <p className="mt-5 text-lg text-white/70">
                You rarely lose money in one big mistake. You lose it in small moments nobody sees, and they all happen on your busiest night.
              </p>
            </div>
            <ol className="mt-14 grid gap-px overflow-hidden rounded-3xl bg-white/10 sm:grid-cols-2">
              {NIGHT.map((n) => (
                <li key={n.time} className="bg-ink p-6 sm:p-7">
                  <p className="font-mono text-sm font-semibold text-accent">{n.time}</p>
                  <p className="mt-2 text-lg leading-snug font-medium">{n.what}</p>
                  <p className="mt-2 text-sm text-white/55">{n.cost}</p>
                </li>
              ))}
            </ol>
            <p className="mt-12 max-w-3xl font-display text-2xl leading-snug text-white/90 sm:text-3xl">
              Most restaurant software sells you more screens. The trouble lives between them: between the table and the kitchen, the counter and the bank, your software vendor and your Saturday night.
            </p>
          </div>
        </section>

        {/* ------------------------------------------------------------ the cost */}
        <Section id="cost">
          <div className="max-w-3xl">
            <Kicker>Count it</Kicker>
            <h2 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">What slips through your month?</h2>
            <p className="mt-5 text-lg text-ink-soft">Put in your own numbers. Most owners have never added these up: they rarely show up in any report.</p>
          </div>
          <div className="mt-10">
            <LeakCalculator />
          </div>
        </Section>

        {/* ------------------------------------------------------------ the promises */}
        <Section id="how" className="bg-surface">
          <div className="max-w-3xl">
            <Kicker>How Mezmitra fixes it</Kicker>
            <h2 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">Four promises, each one you can test.</h2>
            <p className="mt-5 text-lg text-ink-soft">Not a list of features: the moments from Saturday night, handled. In your demo and your rehearsal, you watch each one happen on your own phone.</p>
          </div>
          <div className="mt-16 space-y-24">
            {PROMISES.map((p, i) => (
              <article key={p.id} className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                <div className={i % 2 ? 'lg:order-2' : ''}>
                  <Kicker>{p.kicker}</Kicker>
                  <h3 className="mt-2 font-display text-3xl leading-tight font-semibold sm:text-4xl">{p.title}</h3>
                  <p className="mt-4 border-l-2 border-rose-300 pl-4 text-ink-soft">
                    <span className="font-semibold text-ink">Today: </span>
                    {p.pain}
                  </p>
                  <ul className="mt-6 space-y-3.5">
                    {p.points.map((pt) => (
                      <li key={pt} className="flex gap-3">
                        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--brand)]" />
                        <span className="text-[15px] leading-relaxed">{pt}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-6 rounded-xl bg-stone-100 px-4 py-3 text-sm text-ink-soft">
                    <span className="font-semibold text-ink">What you will measure: </span>
                    {p.measure}
                  </p>
                </div>
                <div className={i % 2 ? 'lg:order-1' : ''}>{p.visual}</div>
              </article>
            ))}
          </div>
        </Section>

        {/* ------------------------------------------------------------ included */}
        <Section id="included">
          <div className="max-w-3xl">
            <Kicker>One system, every role</Kicker>
            <h2 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">Every role, one system. No extra apps to stitch together.</h2>
            <p className="mt-5 text-lg text-ink-soft">With Table service, QR and waiter ordering, kitchen screens, loyalty, stock and every report are included, not sold as extras. Each person sees only what their job needs.</p>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {INCLUDED.map((c) => (
              <div key={c.title} className="rounded-2xl border border-line bg-surface p-5">
                <c.icon className="size-6 text-[var(--brand)]" />
                <h3 className="mt-3 font-semibold">{c.title}</h3>
                <ul className="mt-2 space-y-1.5 text-sm text-ink-soft">
                  {c.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>

        {/* ------------------------------------------------------------ go live */}
        <Section id="golive" className="bg-surface">
          <div className="max-w-3xl">
            <Kicker>Going live</Kicker>
            <h2 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">You pay in full only after it works in your restaurant.</h2>
          </div>
          <ol className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-2xl border border-line bg-paper p-5">
                <span className="font-mono text-sm font-semibold text-[var(--brand)]">0{i + 1}</span>
                <s.icon className="mt-3 size-6 text-ink-soft" />
                <h3 className="mt-3 font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm text-ink-soft">{s.body}</p>
              </li>
            ))}
          </ol>
        </Section>

        {/* ------------------------------------------------------------ pricing */}
        <Section id="pricing">
          <div className="mx-auto max-w-3xl text-center">
            <Kicker>Pricing</Kicker>
            <h2 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">About ₹50 a day for the whole restaurant.</h2>
            <p className="mt-5 text-lg text-ink-soft">Simple plans per outlet, with no charge per user. Annual plans cost ten months and include go-live.</p>
          </div>
          <div className="mt-12">
            <Pricing />
          </div>
        </Section>

        {/* ------------------------------------------------------------ faq */}
        <Section id="faq" className="bg-surface">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <Kicker>Questions owners ask</Kicker>
              <h2 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight">Straight answers.</h2>
              <p className="mt-4 text-ink-soft">Including what Mezmitra does not do yet. If something matters to you, ask us in the demo.</p>
              <p className="mt-6 flex items-center gap-2 text-sm text-ink-soft">
                <LifeBuoy className="size-4 text-ink-faint" /> Support every day, 11 am to 11 pm
              </p>
              <p className="mt-2 flex items-center gap-2 text-sm text-ink-soft">
                <WifiOff className="size-4 text-ink-faint" /> Outlet hub for internet outages
              </p>
            </div>
            <div className="divide-y divide-line rounded-2xl border border-line">
              {FAQ.map((f) => (
                <details key={f.q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                    {f.q}
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-stone-100 text-ink-soft transition group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 leading-relaxed text-ink-soft">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </Section>

        {/* ------------------------------------------------------------ demo */}
        <section id="demo" className="scroll-mt-16 bg-ink px-4 py-20 text-white sm:px-6 sm:py-28">
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div>
              <Kicker dark>See it on your own menu</Kicker>
              <h2 className="mt-3 font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">Twenty minutes. Your dishes. Your Saturday night.</h2>
              <p className="mt-5 text-lg text-white/70">Tell us about your restaurant. We will call or WhatsApp you and show you the four moments on your own phone: a missed drink, a missing UPI payment, the internet going down, and a day end that adds up.</p>
              <ul className="mt-8 space-y-3 text-white/80">
                {['No hardware to buy to try it', 'Pay in full only after your rehearsal passes', 'English or Hindi, your choice'].map((x) => (
                  <li key={x} className="flex items-center gap-3">
                    <span className="grid size-6 place-items-center rounded-full bg-emerald-500/20 text-emerald-300">✓</span>
                    {x}
                  </li>
                ))}
              </ul>
            </div>
            <DemoForm />
          </div>
        </section>
      </main>

      <footer className="border-t border-line px-4 py-10 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 text-sm text-ink-faint">
          <img src="/brand/logo.svg" alt="Mezmitra: restaurant operations, together." className="h-12 w-auto" width={170} height={46} />
          <span>Made for Indian restaurants, cafés and hotel dining.</span>
          <a href="/login" className="ml-auto font-medium text-ink-soft hover:text-ink">
            Staff sign-in
          </a>
        </div>
      </footer>
    </div>
  );
}
