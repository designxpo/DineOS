# Restaurant & Cafe SaaS: Development Spec

Developer companion to the PRD "In-House Cafe & Restaurant Platform". Cloud-first, multi-tenant SaaS with a Petpooja-style POS, a Zomato-style QR menu, an owner and manager portal, and an optional camera table-vision add-on.

Tags: **[Certain]** = requirement from the PRD. **[Likely]** = default choice, challenge it if you have a better one. **[Guessing]** = estimate to validate.

---

## 1. Hard constraints

- [Certain] No third-party APIs or SaaS in the product path. Hosting on rented servers (India region) is allowed.
- [Certain] Guest ordering works in a phone browser with no app install and no login.
- [Certain] A new order reaches the manager portal and kitchen screen in under 2 seconds.
- [Certain] Multi-tenant from day one. One tenant must never read another tenant's data.
- [Certain] Table state comes from order and bill events first. The camera only fills gaps.
- [Certain] Subscription and guest payments: no gateway in v1. UPI is paid to the outlet's own QR and confirmed manually by staff.
- Out of scope for v1: delivery-app integrations (Zomato, Swiggy), automatic card or UPI settlement, WhatsApp or SMS alerts, face recognition.

---

## 2. Architecture

```
Guest phone (PWA) ─┐
Waiter tablet ─────┤
Kitchen screen ────┼──> API gateway ──> Backend service ──> PostgreSQL (row-level security)
Cashier POS ───────┤         │                 │
Owner portal ──────┘         │                 ├──> Redis (pub/sub, queues, cache)
                             │                 └──> Object storage (menu photos, exports)
                             └──> WebSocket / SSE hub (live events)

Camera add-on (on site): IP cameras (RTSP) ──> Vision worker (edge box) ──> HTTPS: table-state events to cloud
Print agent (on site, small): receives print jobs over WebSocket ──> ESC/POS network printers
```

### Suggested stack [Likely]

| Layer | Default | Why |
| --- | --- | --- |
| Web apps (guest, staff, owner, admin) | TypeScript + React (Next.js), PWA | One codebase, installable, works offline-ish |
| Backend | Node.js + TypeScript (NestJS or Fastify) | Fast to build, strong typing, good WebSocket support |
| Database | PostgreSQL with row-level security | Tenant isolation enforced in the database |
| Realtime | WebSocket (Socket.IO) with Redis adapter | Order inbox, KDS, table map |
| Queue and cache | Redis (BullMQ) | Print jobs, reports, sync |
| Object storage | S3-compatible, self-hosted (MinIO) | Menu photos, exports |
| Vision worker | Python (FastAPI), OpenCV, ONNX runtime | Runs detector on edge box |
| Detector model | Apache-licensed model (RT-DETR or YOLOX) | Avoid AGPL surprises. Verify the licence before choosing |
| Deploy | Docker, docker compose to start, Kubernetes later | Keep early ops simple |
| CI | Lint, type-check, unit tests, migration check on every pull request | |

### Printing note [Likely]

A browser cannot print raw ESC/POS to a LAN printer. Ship a small **print agent** (installed once per outlet) that connects out to the cloud over WebSocket and prints kitchen tickets and bills. Browser print dialog is the fallback.

### Offline behaviour [Likely]

POS and KDS cache the menu and open orders in IndexedDB, queue new actions during a short internet drop, and replay them with idempotency keys on reconnect. Full offline operation is the hybrid tier, which is out of scope for v1.

---

## 3. Multi-tenancy

- Hierarchy: `tenant` (restaurant business) > `outlet` > `table`.
- Every business table has `tenant_id`. Most also have `outlet_id`.
- Enable PostgreSQL row-level security. The backend sets `app.tenant_id` per request from the authenticated token. No query runs without it.
- Test: an automated suite tries cross-tenant reads and writes on every table and must fail every attempt.
- Guest requests have no login: the signed table QR token resolves to tenant, outlet and table.

---

## 4. Data model (core tables)

All tables have `id` (uuid), `tenant_id`, `created_at`, `updated_at`. Money is stored as integer paise.

**Platform**
- `tenants`: name, slug, plan, status, branding (logo, colours)
- `plans`: code, features (json)
- `subscriptions`: tenant_id, plan, period_start, period_end, status
- `platform_invoices`: tenant_id, amount, status (unpaid, paid), paid_reference
- `users`: tenant_id, name, phone, email, password_hash, status
- `roles` and `user_outlet_roles`: role in (owner, manager, cashier, waiter, kitchen)
- `audit_log`: actor, action, entity, before, after (voids, discounts, refunds, plan changes)

**Restaurant setup**
- `outlets`: tenant_id, name, address, gstin, fssai_no, tax_config, invoice_prefix
- `tables`: outlet_id, label, seats, zone, qr_token_version, camera_zone_polygon (nullable)
- `menu_categories`: outlet_id, name, sort, available_schedule
- `menu_items`: category_id, name, description, photo_url, price, is_veg, hsn_sac, tax_rate, tags, in_stock, station
- `modifier_groups` and `modifiers`: min and max select, price delta
- `item_modifier_groups`: link table

**Orders**
- `table_sessions`: table_id, opened_at, closed_at, status (open, closed), guest_count
- `orders`: outlet_id, table_session_id (nullable for takeaway and counter), type (dine_in, takeaway, counter), status, source (guest_qr, waiter, pos), note, placed_at
- `order_items`: order_id, item_id, name_snapshot, price_snapshot, qty, modifiers_snapshot, note, status, station
- `kots`: order_id, station, printed_at (kitchen order tickets)

**Billing**
- `bills`: table_session_id or order_id, subtotal, discount, service_charge, tax_total, total, status, invoice_no, invoice_date
- `bill_lines`: bill_id, order_item_id, amount, tax_rate, tax_amount
- `payments`: bill_id, method (cash, upi, card_slip, other), amount, reference, confirmed_by

**Inventory**
- `ingredients`: unit, reorder_level
- `recipes`: item_id, ingredient_id, qty
- `stock_movements`: ingredient_id, type (purchase, sale, wastage, adjust), qty, ref

**Customers and reservations**
- `customers`: phone, name, consent_at, visits, points
- `reservations`: outlet_id, table_id, customer_id, slot_start, slot_end, status

**Table vision (Phase 3)**
- `cameras`: outlet_id, name, rtsp_secret_ref, status, last_seen
- `table_state_events`: table_id, source (order, camera, staff), state, confidence, at

### Rules

- Snapshot item name, price and modifiers onto `order_items` so later menu edits never change old bills.
- Invoice numbers: gap-free sequence per outlet per financial year, assigned in a transaction when a bill is finalised.
- Soft-delete menu items. Never hard-delete anything referenced by an order.

---

## 5. Core state machines

### Order status
`placed` > `accepted` > `preparing` > `ready` > `served` > (`billed` on bill finalisation)
Side exits: `rejected` (reason required, from `placed`), `cancelled` (manager only after `accepted`).
Item-level status mirrors the order and may differ per item (for example one item ready earlier).

### Table state (derived)
| State | Trigger |
| --- | --- |
| vacant | No open session |
| occupied | Session opened (QR scan with first add-to-cart does not count; first order placed or waiter seats guests does) |
| ordered | Open order not yet fully served |
| served | All items served, no bill requested |
| bill_requested | Guest or waiter requests bill |
| needs_cleaning | Bill paid and session closed |

Camera events (Phase 3) can move a table `vacant` <> `occupied` or flag `needs_cleaning` only when no open session or order exists.

### Table session
- Opened by the first confirmed order from the table QR, or by a waiter.
- Closed when the bill is fully paid. After closing, the old guest cart and QR session token stop working and a new scan opens a fresh session.

---

## 6. Guest QR menu

**URL shape:** `https://{tenant-slug}.{domain}/t/{signed_table_token}`

**Token** [Certain]: signed (HMAC or JWT) with tenant, outlet, table and a version number. Rotating the table's `qr_token_version` invalidates every printed code for that table.

**Screens**
1. Menu: outlet header, table number, search, veg-only toggle, sticky category tabs, item cards (photo, name, price, veg mark, tags, add button with stepper).
2. Item sheet: required and optional modifiers, notes, quantity.
3. Cart: items, notes, tax preview, total, "Order now".
4. Status: live order progress, add more items, call waiter, request bill.

**Behaviour**
- Cart lives in local storage plus the server-side table session so two guests at one table see the same cart. [Likely]
- Rate limit orders per table token. Flag a first order from a new device when "manager approval" mode is on.
- Out-of-stock items disable the add button within 2 seconds of the manager toggling stock.
- Menu payload is cached and served from CDN or edge cache; target menu page load under 2 seconds on 4G.

---

## 7. Owner and manager portal

**Order inbox**
- New order: sound, badge, and a card with table, items, notes and time.
- Actions: accept, reject with reason, mark preparing, ready, served, edit or cancel items, reprint kitchen ticket, send to kitchen screen.
- Auto-accept setting per outlet. Manager approval option for flagged orders.

**Dashboards**
- Live floor map with table states.
- Today's sales, open bills, top items, average order time.

**Notifications** [Likely]: in-portal sound and browser push (PWA). No WhatsApp or SMS in v1.

---

## 8. POS and billing

- Order types: dine-in, takeaway, counter.
- Bill: subtotal, per-item discount, bill discount, service charge, taxes, round-off, total.
- Split bill by item, seat or amount. Merge and transfer tables.
- GST: tax rate per item, configurable per outlet. Invoice shows GSTIN, FSSAI number, invoice number, HSN or SAC, tax split. [Certain] Confirm rules with an accountant before launch.
- Payments: cash, UPI (outlet's own QR, staff confirms), card slip (manual entry), split payments.
- Day-end report: sales by payment method, tax summary, voids, discounts.
- Void and refund: manager approval, written to `audit_log`.

---

## 9. Realtime events

Channel naming: `tenant:{id}:outlet:{id}` plus `...:station:{name}` and `...:table:{id}`.

| Event | Payload | Consumers |
| --- | --- | --- |
| `order.placed` | order summary | Owner portal, KDS, waiter |
| `order.status_changed` | order id, status | Guest status page, portal, KDS |
| `item.stock_changed` | item id, in_stock | Guest menu, POS |
| `table.state_changed` | table id, state, source | Floor map, waiter |
| `waiter.called` | table id | Assigned waiter |
| `bill.requested` | table id | Cashier, waiter |
| `print.job` | job id, type, payload | Print agent |

Delivery rules: events carry a monotonically increasing sequence per outlet; clients that reconnect fetch missed events since their last sequence. Mutating API calls accept an `Idempotency-Key` header.

---

## 10. API outline (REST, JSON, `/v1`)

**Guest (token-auth, no login)**
- `GET /guest/menu`
- `POST /guest/orders`
- `GET /guest/session` (cart, orders, status)
- `POST /guest/call-waiter`
- `POST /guest/request-bill`

**Staff and owner (login required, role-checked)**
- `GET /orders?status=...`, `PATCH /orders/{id}/status`, `PATCH /orders/{id}/items`
- `GET /tables`, `POST /tables/{id}/transfer`, `POST /tables/merge`, `POST /tables/{id}/seat`
- `POST /bills`, `PATCH /bills/{id}`, `POST /bills/{id}/payments`, `POST /bills/{id}/finalise`
- `GET/POST/PATCH /menu/items`, `PATCH /menu/items/{id}/stock`
- `GET /reports/sales`, `GET /reports/gst`, `GET /reports/items`
- `GET/POST /reservations`
- Inventory: `GET/POST /ingredients`, `POST /stock-movements`

**Platform admin**
- `POST /admin/tenants`, `PATCH /admin/tenants/{id}` (plan, suspend), `GET /admin/usage`
- Support access with a time-limited impersonation token and a mandatory audit entry.

**Camera ingest (device-token auth)**
- `POST /vision/table-state` (table id, state, confidence, timestamp)
- `POST /vision/heartbeat`

---

## 11. Camera vision service (Phase 3)

1. Admin screen: draw each table as a polygon on a camera snapshot.
2. Worker pulls RTSP frames at 2 to 5 per second per camera. [Likely]
3. Detector finds person, chair, plate, cup, bottle. Tracker smooths across frames.
4. Per zone: people present = occupied. No people plus items on table = needs cleaning. No people and clear = vacant.
5. A state must hold 20 to 30 seconds before it is sent. [Likely]
6. Send only table state and confidence to the cloud. Store no raw video by default.
7. Fusion rule in the backend: an open order or session always wins over the camera.

Validation: label 1,500 to 3,000 frames from real outlets, fine-tune, and run a 2-week audit against staff ground truth. Target 95% match for occupied vs vacant. [Guessing]

Privacy: signage at the outlet, no cameras in washrooms or staff rooms, no identification of people.

---

## 12. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Availability | 99.5% or higher for the cloud platform. [Guessing] |
| Latency | Order to kitchen screen under 2 s. Menu load under 2 s on 4G |
| Scale target per outlet | 60 tables, 300 concurrent guest sessions, 10 staff devices |
| Security | Signed table tokens, role-based access, tenant isolation tests, rate limits, encrypted backups, audit log |
| Backups | Nightly encrypted backup to a second location you own, with restore tested monthly |
| Data rights | Tenant export and delete. Phone numbers collected only with consent |
| Languages | English and Hindi at launch |

---

## 13. Build plan

### Phase 1: order-to-bill core and SaaS foundations
Epics in suggested order:

1. **Foundations:** repo, CI, environments, auth, tenants, outlets, roles, row-level security, audit log.
2. **Menu management:** categories, items, modifiers, photos, stock toggle, spreadsheet import.
3. **Tables and QR:** table setup, signed QR tokens, printable QR sheet (PDF).
4. **Guest ordering:** menu, cart, order placement, live status.
5. **Order inbox and KDS:** realtime events, accept and reject, status flow, sound alerts.
6. **POS and billing:** bills, taxes, discounts, split, payments, GST invoice, day-end report, print agent.
7. **Table operations:** live floor map, merge, transfer, waiter assignment, call waiter, request bill.
8. **Platform admin:** tenant create, plans, suspend, usage, manual subscription invoices.
9. **Hardening:** load test, cross-tenant security test, backup and restore drill.

Exit gate: pilot outlet live; 60% of orders from guest phones and order errors down 50%. [Certain: from PRD success metrics]

### Phase 2: operations
Inventory and recipes, reservations and waitlist, customer book and loyalty, richer reports, short-offline cache hardening, hybrid offline tier.

### Phase 3: camera table vision
Edge worker, zone drawing, detector fine-tuning, fusion rules, dwell-time analytics. Starts only after live outlets have produced frames to label.

### Phase 4 (optional): extended payments
Payment adapter interface (already stubbed in Phase 1), gateway or bank integration, automatic subscription charging. Requires you to accept one external dependency.

---

## 14. Acceptance criteria (Phase 1 samples)

- A guest scans a table QR, adds 3 items with a modifier, taps Order now, and the order shows in the owner portal and KDS in under 2 seconds.
- Marking an item out of stock disables it on every open guest menu in under 2 seconds.
- Rejecting an order notifies the guest with the reason.
- A closed table's old QR session cannot place an order.
- A user from tenant A cannot read any row of tenant B through any endpoint (automated test).
- A bill can be split three ways, paid with mixed cash and UPI, and produces a GST invoice with a gap-free number.
- Restoring last night's backup into a clean environment succeeds.

---

## 15. Open questions for the product owner

- Which Petpooja features must match at launch, and which can wait?
- Will guests at one table share a single cart?
- Auto-accept by default, or manager approval by default?
- First pilot customer: cafe, full restaurant, or a hotel restaurant connected to StayOS?
- Do you accept one external dependency for payment confirmation in Phase 4?
- Who builds it: your team or hired developers?
