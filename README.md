# Mezmitra

Multi-tenant restaurant and cafe platform for India: guests order from a table QR code on their own phone, orders reach the kitchen display and the manager's inbox in well under two seconds, and cashiers settle GST invoices with cash, the outlet's own UPI QR, card slips or split payments. Built to the *Restaurant & Cafe SaaS dev spec*: all of Phase 1, Phase 2 (operations and the offline tier), Phase 3 (camera table vision) and Phase 4 without a payment gateway (UPI checked against the bank statement).

| Surface | Path | Who uses it |
| --- | --- | --- |
| Guest QR menu (PWA, no app, no login, English/Hindi) | `/t/{table token}` | Guests |
| Staff and owner portal: orders inbox, kitchen display, floor map, POS, bills, menu, tables and QR, reports, staff, settings | `/app` | Owners, managers, cashiers, waiters, kitchen |
| Platform admin: restaurants, plans, subscription invoices, usage, support access | `/admin` | You |
| Print agent for ESC/POS kitchen and bill printers; with `MEZMITRA_HUB=1` also the **outlet hub** that keeps the outlet trading through internet outages | `apps/print-agent` | Runs on one PC per outlet |
| Camera table vision worker (optional) | `edge/vision-worker` (Python) | Runs on a small box next to the outlet's IP cameras |

## Run it locally

Needs Node 22+ and PostgreSQL 16.

```bash
npm install
cp .env.example .env                      # then set TOKEN_SECRET to 32+ random characters
npm run db:setup && npm run db:migrate    # creates roles and the mezmitra_dev database
npm run db:seed                           # a hotel restaurant: menu, 22 tables, staff, two weeks of trade,
                                          # stock and recipes, loyalty customers, tonight's bookings
npm run dev                               # API on :4000, web on :3000
```

Open <http://localhost:3000/login> and sign in with restaurant code `aurum-courtyard`:

| Role | Login | Password |
| --- | --- | --- |
| Owner | owner@courtyard.demo | demo1234 |
| Manager (approval PIN 1234) | arjun@courtyard.demo | demo1234 |
| Cashier | priya@courtyard.demo | demo1234 |
| Waiter | ravi@courtyard.demo | demo1234 |
| Kitchen | imran@courtyard.demo | demo1234 |
| Platform admin, at `/admin/login` | admin@mezmitra.local | admin-demo-1234 |

To act as a guest, open **Floor**, tap a table and choose **Guest menu**, or print the QR sheet from **Tables & QR**. Phones on your network can scan it if you set `GUEST_URL_TEMPLATE` and `NEXT_PUBLIC_API_URL` to your machine's LAN address.

## Recording a product video

Run `npm run demo:video` to create a separate `aurum-video` recording restaurant with staged kitchen orders and realistic trade. See [the recording playbook](docs/product-video.md) for login details, repeat-take instructions and a timed shot list.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | All tests: shared billing/state rules, the API against a real Postgres (including the cross-tenant suite and an end-to-end internet outage through the outlet hub), print agent layouts, the web offline queue |
| `cd edge/vision-worker && python3 -m unittest discover -s tests` | Camera worker tests (standard library; the detector test also runs with numpy) |
| `npm run lint` / `npm run typecheck` | ESLint and TypeScript across the monorepo |
| `npm run db:migrate` then `npm run db:codegen -w @mezmitra/api` | Apply a new migration and regenerate the typed schema |
| `node infra/load/load-test.mjs` | Load test at the spec's scale target (see docs/operations.md) |
| `infra/backup/backup.sh`, `infra/backup/restore-drill.sh` | Encrypted backup; restore the newest backup into a scratch database and verify it |
| `MEZMITRA_DRY_RUN=1 MEZMITRA_DEVICE_TOKEN=dv_... npm start -w @mezmitra/print-agent` | Run the print agent without a printer and see the tickets as text |
| `MEZMITRA_HUB=1 MEZMITRA_DRY_RUN=1 MEZMITRA_DEVICE_TOKEN=dv_... npm start -w @mezmitra/print-agent` | Run the outlet hub locally on :4100 (see docs/operations.md) |

## What is built

### Phase 1: order-to-bill core

All nine Phase 1 epics: foundations (auth, tenants, outlets, roles, row-level security, audit log), menu management with spreadsheet import, tables and signed QR codes with a printable PDF sheet, guest ordering with a shared live cart, order inbox and kitchen display, POS and GST billing with splits and a gap-free invoice series, floor operations, platform admin with manual subscription invoices, and hardening.

The acceptance criteria in spec §14 are automated:

| Criterion | Verified by |
| --- | --- |
| QR order with a modifier shows in the owner portal and KDS in under 2 s | `apps/api/test/guest.test.ts` (real sockets); load test p99 26 ms at 60 tables / 300 phones on one machine |
| Out of stock reaches every open guest menu in under 2 s | `guest.test.ts` |
| Rejecting an order notifies the guest with the reason | `guest.test.ts` |
| A closed table's old QR session cannot place an order | `guest.test.ts` |
| Tenant A cannot read any row of tenant B through any endpoint | `cross-tenant.test.ts` probes every route and snapshots tenant B; `rls.test.ts` checks every table at the database |
| Split three ways, mixed cash and UPI, GST invoice with a gap-free number | `billing.test.ts`, including concurrent finalising and rollback |
| Restoring last night's backup into a clean environment succeeds | `infra/backup/restore-drill.sh` |

### Phase 2: operations

| Feature | What it does | Tests |
| --- | --- | --- |
| Customer book and loyalty | Customers saved only with recorded consent; points earned on paid bills, spent at finalisation, returned on void; guests can join from the table, proving the number with a code by SMS when MSG91 is set up (otherwise they see only its last four digits); erasure and export | `customers.test.ts`, `otp.test.ts` |
| Reservations and waitlist | Bookings with clash checks and free-table suggestions, seating that opens the table, no-shows after a grace period; walk-in waitlist; next booking shown on the floor map | `reservations.test.ts` |
| Inventory and recipes | Ingredients, recipes for dishes and add-ons, purchases at a moving-average cost, wastage, counts; accepted orders use stock, cancelled ones give it back; low-stock alerts, optional automatic sold-out, food-cost report | `inventory.test.ts` |
| Richer reports | Comparison with the previous period, sales by category, weekday-by-hour heatmap, team, discounts by reason, table turns and dwell, customers, pilot health (QR share, rejections, time to accept) | `reports.test.ts` |
| Short-offline hardening | Changes queued on the device replay as the person who made them; refused replays stay visible until dismissed; signing out with unsent changes asks first | `apps/web/lib/outbox.test.ts` |
| Hybrid offline tier | The outlet hub serves the staff app on the LAN when the internet is down: orders, kitchen display, live updates, bills with their own GST invoice series, payments, local printing; everything syncs back exactly once | `hub.test.ts` (real API, real hub, network cut and restored) |
| Charge to room | Hotel outlets can put a bill (or part of it) on a guest's room; the front desk sees what to post per room in Reports, exports it as CSV, and managers mark charges posted to the folio. Works offline on the hub | `room-charges.test.ts`, `hub.test.ts` |
| Close the day | One list of everything still open at close (unpaid and draft bills, food never billed, UPI the bank never received, free dishes, large discounts, voids, refunds, stock differences), each with a link to act on it; the owner or a manager signs the day off with the cash counted, and closing with money unsettled needs a written reason | `dayclose.test.ts` |
| Room charges the hotel rejects | A room charge the front desk cannot post (wrong room, guest gone) is marked rejected with the reason, stays on the exception list and in the totals until it is posted or taken back | `room-charges.test.ts` |
| What became of a cancelled dish | A dish cancelled after it was made is thrown away, remade or a staff meal; each is logged against the order item and the inventory report splits waste by cause | `inventory.test.ts` |
| The pass | Dishes turn ready with a clock; a waiter takes one ("I've got it") or takes it over, handovers are audited, and food that waits too long, held or not, turns red and is flagged to managers; serving ends it | `pass.test.ts` |
| Delivery payouts | The Zomato or Swiggy payout statement (gross, each deduction, net) set beside what the outlet billed, the commission expected and the bank credit, with a dispute that stays open until the shortfall is credited back | `payouts.test.ts` |
| Menu import from other systems | An export from another billing system uploads as it is: column names are recognised, veg and availability wording is read, unknown stations and missing taxes are defaulted, and the preview lists what was understood and what was fixed | `menu.test.ts` |

Staff screens (floor, POS, bills, kitchen, reservations, stock entry, offline banners) are in English and Hindi. Owner setup and reporting pages are English only.

### Phase 3: camera table vision

An edge worker turns camera frames into a table state (vacant, occupied, needs cleaning) and a confidence; nothing else leaves the outlet. The cloud applies a reading only when the table has no open visit, shows guests who sat down unattended, and scores the camera against the till (target 95%). Managers draw table zones on a blurred still that is deleted after a day. Tests: `vision.test.ts`, `packages/shared/src/table-state.test.ts`, and the worker's own suite. **The detector is the pretrained YOLOX-s; tuning it needs footage from real outlets** (see `edge/vision-worker/README.md`).

### Phase 4, without a gateway: UPI check

Staff confirm UPI by eye, so owners import the bank statement (CSV or Excel from any major Indian bank) and see the UPI payments the bank never received, UPI money with no bill, and other money in. Matching is by UTR, then by amount and date. The dashboard reminds owners of the past week's UPI payments not yet checked against a statement and lists any the bank never received. Tests: `reconciliation.test.ts` and the statement parser tests. A payment gateway still needs your decision on one external dependency; the `PaymentAdapter` seam is ready for it.

### Money check, for restaurants still on other billing software

Many restaurants have paid a year ahead for other billing software. An outlet can name that system: Mezmitra then takes no orders or bills there (nothing is billed twice), the QR menu is for reading and calling a waiter, and the outlet uploads that system's sales export beside its bank statement to see every UPI payment the bills claim that never arrived. Billing moves to Mezmitra when the year ends. Demo requests record what a restaurant bills on and the month it renews; admins see who to call under Leads → Renewing soon. Tests: `money-check.test.ts`, the sales export parser tests, `leads.test.ts`.

### Go-live rehearsal and acceptance sheet

Before full payment, the owner and cashier run nine scenarios on their own devices in Settings → Go-live. For each, Mezmitra shows what it saw since the rehearsal began (the mixed bar and kitchen order, the split, the free dish, the cooked cancellation, a ticket that failed and printed, orders through the outlet hub, the month-end pack download). Failing or leaving a scenario out needs a note; only the owner signs, and only when nothing is failed or unmarked. The signed sheet is frozen with the devices used and prints on A4, saying plainly which passes Mezmitra did not see. Tests: `golive.test.ts`.

### When the internet drops

Tapping the connection dot opens Connection and sync: whether the device is online, on the outlet hub, or connected with changes still stuck; how many changes are waiting, were sent in the last day, and were refused (with the reason); the recovery steps; and exactly what works offline, with and without the hub. The same list is published at `/offline-guide` and linked from the website's FAQ. Drilled on two devices with the internet off: each change reached the server once across repeated reconnects, and a stale one was listed as refused. Tests: `apps/web/lib/outbox.test.ts`.

### Since the pilot review: safety, money and less manual work

| Feature | What it does | Tests |
| --- | --- | --- |
| Guests who left | A phone that ordered in an earlier, paid visit at a table (within 12 hours) always waits for staff, whatever the auto-accept settings, and the inbox says so. Reopening the menu after the visit ended asks before starting a new one | `orders-core.test.ts` |
| One check per table | Auto-accept is on for new outlets. The first QR order at a table is checked once; after staff accept an order there, or a waiter seats it, the other phones go straight to the kitchen | `orders-core.test.ts` |
| Big parties | A visit may send 8 orders in ten minutes, or two per guest for bigger parties (guest count, or the seats of joined tables) | `guest.test.ts` |
| Walkout watch | The floor map flags a table served 30+ minutes ago with no bill, or with a bill asked for or printed 20+ minutes ago and unpaid. Day end lists every order that never reached a bill, and whether its table was cleared | `billing.test.ts`, `table-state.test.ts` |
| Delivery orders | Zomato, Swiggy or own riders, entered at the POS with the platform's order number. Zomato and Swiggy pay the GST on their orders (CGST Act s. 9(5)), so those bills carry none, say so on the invoice, are settled by a "platform" payment and are listed apart in the GST report. Reports → Delivery shows commission and the payout to expect | `delivery.test.ts`, `render.test.ts` |
| Phone alerts | Web Push to staff who turn it on: new orders to accept, waiter calls, bill requests, at their outlet only | `push.test.ts` |
| Printers and cash drawer | One-line install on the billing PC (Windows, Mac, Linux, Raspberry Pi). USB and network ESC/POS printers are found automatically and picked in Settings; KOTs per station, bills at the desk, the drawer opens on cash. A red bar on every screen, including the kitchen's, names any ticket that did not print | `printer-setup.test.ts`, `print.test.ts`, `transports.test.ts` |
| Phones | Bottom tab bar with the screens each role uses (Orders shows how many wait), every other screen under More; tabs that do not fit scroll with a fade; the kitchen screen fits a phone | |
| Free food and drinks | Give a dish, part of a line or a whole bill free with a reason (mishap, special or owner's guest, celebration, staff meal, marketing), a note and the guest. Owners, managers and cashiers give it; waiters need a manager's PIN. Bills charge nothing for it and show it apart from discounts; Reports → Free items has value, ingredient cost, reasons, staff, approvers and guests; large ones alert the owner | `comps.test.ts` |
| Tables without cameras | A guest's QR scan marks the table taken and starts a "guests waiting" alert; two taps seat walk-ins; tables turn free by themselves after the clearing time; bottled water is counted before a table's bill prints and billed only if opened | `tables-without-cameras.test.ts` |
| Counter-service cafés | Order numbers on the bill with a QR guests use to follow the order on their phone, and a pickup screen for a TV by the counter | `tables-without-cameras.test.ts` |
| Bar and kitchen | One menu, one bill; each station gets its own ticket and screen. When the bar's drinks are ready before the food, waiters hear it (screen and phone), serve the drinks with one tap, and the floor shows what is waiting at the pass. The table's assigned waiter is the one alerted. Works on the outlet hub offline too | `ready.test.ts`, `hub.test.ts` |
| Limits across servers | With Redis set, sign-in, PIN and order limits are counted in Redis, so they hold when Vercel runs several API copies; if Redis is down, requests still go through | `rate-limit.test.ts` |

## Decisions that differ from the spec

- **Web Push, by your decision.** Phone alerts go through the browser makers' push services (Google, Apple, Mozilla), an exception to the no-third-party rule. Nothing but the alert text leaves Mezmitra, and they are off until VAPID keys are set.
- **SMS codes through MSG91, by your decision.** Mezmitra makes and checks the codes; MSG91 only delivers them. Without its keys, loyalty works as before.
- **Delivery apps entered by hand for now.** Zomato and Swiggy only open their order APIs to approved partners; delivery orders are typed in at the POS until an aggregator (such as UrbanPiper) is connected.
- **Service charge** is off by default and staff can remove it from any bill, because Indian consumer guidelines bar charging it automatically.
- **GST rate** is set per dish with an outlet default; the seed uses 5%. For a hotel restaurant the right rate can depend on room tariffs, so confirm with your accountant before the pilot.
- **No BullMQ.** Live events and print jobs live in Postgres (a transactional outbox with a per-outlet sequence), so nothing is lost if a process dies; Redis is only used to fan sockets out across API servers.
- **Staff sessions are database tokens**, not JWTs, so disabling someone signs them out at once.
- **Charge to room without a hotel-system link.** Room charges are a payment method; the front desk posts them to folios by hand from Reports → Room charges (or its CSV) and marks them posted. A direct StayOS integration is deferred.
- **Every foreign key between tenant tables also matches `tenant_id`.** Postgres checks foreign keys without row-level security, so this stops one tenant's rows from pointing at another's.
- **Offline bills use their own invoice series** (`PREFIXH/2627/00001`), so the hub never needs the cloud's counter; GST reports list both series.
- **Guests joining loyalty without a code see only the last four digits** of the number they typed, never a name or balance; with SMS codes on, a proved number shows its name and points.

Phases 2 to 4 decisions are recorded in [docs/specs/2026-10-15-phase2-4-decisions.md](docs/specs/2026-10-15-phase2-4-decisions.md).

## Before the pilot

- Confirm GST rates, the invoice format and HSN/SAC codes with an accountant.
- Test the print agent with the outlet's actual printers (layouts, network printing and the installer on macOS are tested; USB printing through the Windows spooler and the Windows installer have not been run on real hardware yet).
- Build the Docker images: CI does this on every push. They could not be built on the development machine because Docker was not running.
- Point a domain at the server. Tenant subdomains (`slug.yourdomain`) are optional and need a wildcard certificate.
- Configure a second backup location; `backup.sh` warns while there is none.
- Offline mode: give the hub PC a fixed LAN address, run the hub with the staff app beside it, and rehearse an outage (unplug the router) before relying on it.
- Cameras: run the two-week camera audit at an outlet before trusting camera states there.

## Docs

- [docs/architecture.md](docs/architecture.md): how the system fits together, tenancy, realtime, billing, and conventions for adding features
- [docs/operations.md](docs/operations.md): deploying, onboarding a restaurant, the print agent and outlet hub, cameras, the UPI check, backups, scaling and security
- [edge/vision-worker/README.md](edge/vision-worker/README.md): installing the camera box, exporting the model, fine-tuning
- Spec and decisions: [docs/specs/](docs/specs/)
