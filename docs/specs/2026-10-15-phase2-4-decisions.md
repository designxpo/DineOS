# Phases 2 to 4: decisions (15 Oct 2026)

What was built after Phase 1, the choices made where the spec is silent, and what is still open. Phase 1 decisions are in [2026-10-15-phase1-decisions.md](2026-10-15-phase1-decisions.md).

## Phase 2: operations

| Topic | Decision | Why |
| --- | --- | --- |
| Customer records | Created only with recorded consent (who gave it, when, staff or guest); phone numbers normalised to +91; erasure blanks the person and keeps anonymous totals | Spec §12: phone numbers only with consent; the DPDP Act |
| Loyalty earning | Points on the bill total when it is fully paid; default 5% back, 1 point = ₹1, redeem from 100 points (per outlet) | Paid money is the only safe basis; refunds and voids stay simple |
| Loyalty spending | Chosen on a draft bill, capped at what is left after discounts, deducted at finalisation, returned on void | The invoice must show the discount it was printed with |
| Guest loyalty join | Guests see only the last four digits of the number they typed, never a name or balance, and cannot change an existing record | There is no OTP without an SMS provider, which would be a third-party service; staff check identity before points are spent |
| Reservation phone numbers | Stored only when staff tick that the guest agreed | Same consent rule |
| No-shows | Bookings still unseated 30 minutes after their slot become no-shows (hourly job) | Frees the table on the floor map |
| Stock use | An item uses its recipe when the kitchen accepts it; cancelling it later gives the stock back | Matches when food is actually made; dishes cooked and then cancelled should be logged as wastage |
| Cost of stock | Moving-average cost per unit, updated on each purchase | Simple, and what small kitchens can maintain |
| Insights | Pilot health shows QR share, QR rejections and time to accept | The Phase 1 exit gate (60% of orders from phones, fewer errors) needs these numbers |
| Offline queue | Replays as the person who queued the change; refused replays stay visible; sign-out with unsent changes asks first | A shared tablet must not credit one waiter's orders to the next |

### Hybrid offline tier (outlet hub)

| Topic | Decision | Why |
| --- | --- | --- |
| Where it runs | The print agent with `MEZMITRA_HUB=1`, one per outlet, with the staff web app beside it | Outlets already run the agent; no second install |
| How devices switch | A banner after 30 s offline; the session travels in the URL fragment to `http://<hub>/offline` | A secure page cannot call a plain-HTTP LAN address, and certificates for LAN addresses would need an outside service |
| Staff sign-in offline | Hub recognises existing sessions by token hash; no passwords or PINs on the hub | A stolen hub file must not give away credentials |
| Invoice numbers offline | Separate gap-free series `PREFIXH/FY/NNNNN` (16 characters at most) | The hub cannot take numbers from the cloud's counter while cut off; GST allows several series |
| What works offline | Orders, kitchen, tables, bills, payments, printing | What keeps service going |
| What waits | Discounts, voids, refunds, splits, loyalty, menu edits | They need a manager PIN check or cloud data |
| Cancelling food the kitchen has | Only a signed-in manager, while offline | PINs cannot be checked on the hub |
| Working in two places | The hub refuses changes once the cloud is back and its changes have synced | Avoids conflicting edits |
| Sync | Upsert by id, one transaction per table visit; refused items are reported, not dropped | Retries are harmless; one bad bill does not block the rest |
| Bills from the hub | Accepted only if every line matches its order item and the totals agree with the shared bill maths | A faulty or tampered hub cannot invent sales |
| Guest QR during an outage | Paused only when neither the hub nor any staff screen is reachable | Guests on mobile data would otherwise order into a kitchen that cannot see them |

## Phase 3: camera table vision

| Topic | Decision | Why |
| --- | --- | --- |
| Detector | YOLOX-s (Apache-2.0) on ONNX Runtime, CPU | Runs at 2 fps on a mini PC; licence allows commercial use |
| Fusion | Camera readings count only when the table has no open visit, cannot clear a staff or billing cleaning flag, and lapse after 15 minutes | Spec §5: orders and bills first, the camera fills gaps |
| Holding | 25 s at 80% agreement before sending; resend every 5 minutes | Spec §11 step 5; brief occlusions never reach the cloud |
| Privacy | Only states and confidences leave the outlet; stills only on request, people blurred on the box, private, deleted after a day; stream passwords stay on the box | Spec §11 privacy |
| Unattended guests | Shown on the floor map when the camera sees people at a table nobody has opened | The main value of cameras for a restaurant floor |
| Validation | Reports > Camera scores readings against open visits with a 95% target | Spec §11 validation, using the till as ground truth |
| Fine-tuning | Opt-in local frame collection and documented steps; **not done** | Needs 1,500 to 3,000 labelled frames from real outlets (spec §13: Phase 3 starts after live outlets produce frames) |

## Phase 4 without a gateway

| Topic | Decision | Why |
| --- | --- | --- |
| Payment gateway | Not built | It needs your decision to accept one external dependency (spec §15) |
| Instead | UPI check: import the bank statement, match credits by UTR and by amount and date, list what does not match on either side | Catches confirmed payments that never arrived and sales that were never billed, with no outside service |
| Statement formats | CSV and Excel; HDFC, ICICI, SBI, Axis and Kotak layouts tested; others with a date column and a credit or amount column also work | Statements come from net banking downloads |

## Charge to room (hotel pilot)

| Topic | Decision | Why |
| --- | --- | --- |
| Model | A payment method `room` with a room number and optional guest name, off unless the outlet turns it on | The bill is settled as far as the restaurant is concerned; the hotel collects at checkout |
| Posting | Front desk posts by hand from Reports → Room charges or its CSV; managers mark charges posted (audited) | No StayOS API yet; the list of unposted charges is what stops a guest leaving without paying |
| Refunds | A refund of a room charge stays on the same room, as a negative line | The folio total stays right |
| Offline | The hub accepts room charges and syncs them like any payment | Hotel restaurants keep billing to rooms through an outage |

## Still open

- **Payment gateway or bank integration** (Phase 4): accept one external dependency or not. The `PaymentAdapter` interface is where it would plug in.
- **Camera pilots**: which outlets, and consent and signage there, so frames can be collected to fine-tune the detector.
- **StayOS link**: posting room charges straight to folios needs StayOS's API and credentials.
- **Hub hardware**: whether outlets provide a PC or you supply a standard mini PC with the hub and web app preinstalled.
