# Architecture

## Pieces

```
Guest phone (PWA) ─┐
Waiter tablet ─────┤                     ┌── PostgreSQL 16 (row-level security, event outbox, print jobs)
Kitchen display ───┼── Caddy ── web (Next.js 16) 
Cashier POS ───────┤        └── api (Fastify 5) ──┼── Redis (Socket.IO fan-out between API servers)
Owner / admin ─────┘              │               └── object storage (menu photos: local disk or S3/MinIO)
                                  └── Socket.IO /staff, /guest, /device
Print agent (outlet PC) ── outbound socket + REST ── ESC/POS printers (network :9100, USB via the OS spooler, /dev/usb/lp*)
   └─ outlet hub mode: LAN copy of the outlet on :4100 for internet outages (staff app proxied beside it)
Camera box (Python) ── RTSP from IP cameras ── HTTPS table states only ── api /v1/vision/*
```

| Package | Contents |
| --- | --- |
| `packages/shared` | Rules both sides must agree on: order state machine, GST bill arithmetic (integer paise), invoice numbering and Indian financial year, menu schedules and modifier rules, table state derivation, role permissions, API DTO types, event names |
| `apps/api` | Fastify modules under `src/modules/*`, each exposing `routes(ctx)`; SQL migrations in `migrations/`; tests in `test/` against a real database |
| `apps/web` | Next.js app: `app/t/[token]` guest, `app/app/*` staff portal, `app/admin` platform admin, `app/print/*` 80 mm browser print views |
| `apps/print-agent` | Node agent with a small ESC/POS encoder and KOT/invoice layouts; `src/hub/*` is the outlet hub (engine, LAN server, JSON store, cloud link) |
| `edge/vision-worker` | Python camera worker: zones, tracking, hold-before-send, YOLOX on ONNX Runtime, cloud client |

## Tenancy

- Every business table has `tenant_id`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and a policy `tenant_id = app_tenant_id()`, which reads the per-transaction setting `app.tenant_id`.
- The API connects as `dineos_app`, which cannot bypass RLS. Every query runs through `ctx.tx(tenantId, fn)`, which opens a transaction and sets `app.tenant_id` first. Without it a query sees nothing and cannot write.
- Platform admin routes and background jobs use `ctx.adminDb` (role `dineos_admin`, `BYPASSRLS`). Nothing else does.
- The few lookups that happen before the tenant is known (login by restaurant code, session token, device token) are narrow `SECURITY DEFINER` SQL functions.
- Foreign keys between tenant tables are paired with composite `(column, tenant_id)` keys, because foreign-key checks ignore RLS.
- Guests have no login: the printed QR is an HMAC-signed `{tenant, outlet, table, version}`. Joining returns a signed guest token bound to the table's current session. Bumping a table's `qr_token_version` kills every printed copy.

`test/rls.test.ts` checks every table at the database; `test/cross-tenant.test.ts` probes every registered route with another tenant's ids and compares a snapshot of the victim tenant before and after.

## Requests, events and realtime

```ts
return ctx.tx(auth.tenantId, async (tx) => {
  // queries on tx.db are tenant-scoped
  await tx.emit({ outletId, type: 'order.placed', channels: ['outlet'], payload: { order } });
});
```

- `tx.emit` writes to `outlet_events` with the next per-outlet sequence number in the same transaction, and the event is pushed to sockets only after commit. A rolled-back request never announces anything.
- Channels: `outlet` (staff screens), `menu` (every open guest menu of the outlet), `session:{id}` (the guests of one table visit), `print` (the outlet's print agents). Guests are addressed per session, not per table, so the next party never sees the previous party's cart.
- Clients track the last sequence they saw. On a gap or a reconnect they call `GET /v1/events?since=` and replay; if they are too far behind they refetch their screens.
- All changes go through REST (idempotent and testable); sockets only push. Mutations accept an `Idempotency-Key` header, which the POS offline queue uses to replay safely.

## Ordering

- Table session: `pending` (guests have a shared cart, the table still shows vacant), then `open` (first order or a waiter seats them), then `closed` (bill fully paid, or released). Closing kills the guests' tokens and cart.
- Order: `placed → accepted → preparing → ready → served → billed`, plus `rejected` (from placed, reason required) and `cancelled` (manager approval after acceptance). Items move independently on the KDS, and the order follows its least-advanced item.
- Guest orders wait in the inbox unless the outlet auto-accepts (on by default for new outlets). The first guest order of a visit is flagged and, with `approve_flagged_orders`, waits for staff; once an order in the visit is accepted, or a waiter seated it, other phones there go straight through. A phone that ordered in an earlier, closed visit at the same table within 12 hours (`returning_device`) always waits. Staff orders go straight to the kitchen.
- Guest order limits: 3 a minute per phone; per visit, 8 in ten minutes or two per guest for bigger parties (guest count, or the seats of every table pointing at the visit).
- Delivery orders (`type = 'delivery'`) carry a `channel` (zomato, swiggy, own) and the platform's `channel_ref`. They have no table session and are billed by order.
- Accepting an order creates one kitchen ticket (KOT) per station and, if a print agent is registered, a print job.
- Table state (vacant, occupied, ordered, served, bill requested, needs cleaning) is derived from session, orders and bill requests (`deriveTableState` in shared) and stored with a history in `table_state_events`. Camera readings are logged there with `source = 'camera'` and feed the same function (see Camera table vision).
- Accepted orders use stock: `syncStock` consumes each accepted item's recipe once and gives it back if the item is cancelled later (`order_items.stock_applied` makes it idempotent). It runs after every order change and after hub sync.

## Billing

- A draft bill is recomputed from the session's accepted, uncancelled, not-yet-billed items whenever it is read or changed. Discounts, the service-charge choice and splits are the only stored inputs.
- Splitting by item or seat creates separate bills, each with its own invoice. Splitting by amount keeps one invoice and shows equal or custom shares to pay separately.
- Finalising takes the next number from a per-outlet, per-financial-year counter row (`PREFIX/2627/000123`, at most 16 characters). The row lock serialises concurrent cashiers and a rollback returns the number, so the series has no gaps or duplicates. Voided invoices keep their number.
- Voids, refunds, cancelling food the kitchen has, and discounts above 10% need a manager. If the cashier lacks the permission, a manager enters their login and PIN on the same screen; that issues a single-use, two-minute approval token, and everything is written to `audit_log`.
- Payments go through `PaymentAdapter`. It is manual: staff confirm cash, a UPI credit to the outlet's own VPA, or a card slip. A gateway can implement the interface later. Until then, owners check UPI against the bank statement (UPI check).
- Loyalty: a customer on a draft bill can redeem points (capped at what is left after discounts); points leave the balance at finalisation, come back on void, and are earned when the bill is fully paid. Every change is in `loyalty_ledger`.
- Bills printed by the outlet hub carry `invoice_series = 'hub'` and their own gap-free numbers per financial year.
- Zomato and Swiggy orders: the bill gets `tax_by_operator = true` at creation; its lines are computed at 0% and it has no service charge, because the platform pays the GST (s. 9(5)). Only a `platform` payment settles it, and only such bills take one. GST reports keep these bills out of the rate, HSN and B2B tables and list them under `operator_supplies`.
- Walkout watch: the floor list carries `last_served_at` (served, not yet billed) and `unpaid_bill_since` (finalised, unpaid); `paymentAlert` in shared decides when a table is flagged. Day end lists `unbilled_orders`.

## Alerts and messages

- Phone alerts: `registerPushAlerts` subscribes to the event bus. `pushFor` maps a committed event to an alert and the permission needed to receive it (guest `order.placed` → `order.accept`; `waiter.called`, `bill.requested` → `service_request.handle`), and it goes to `push_subscriptions` at that outlet whose user holds the permission there. A 404 or 410 from the push service deletes the device.
- Loyalty codes: `otp_codes` holds an HMAC of each code (keyed with `TOKEN_SECRET`), its expiry and attempts. A wrong guess is returned, not thrown, so the attempt count commits. `table_sessions.customer_verified_at` marks a visit whose number was proved; only then does the guest session include the name and points.

## Offline behaviour

- Staff screens: a service worker caches the app shell; the POS keeps the menu in IndexedDB. Order creation, status changes, KDS taps and payments are queued in IndexedDB with their idempotency keys when the network is down, and replayed on reconnect with the session that made them. A change the server refuses on replay is kept and shown (the header badge) until someone dismisses it.
- Guests: the menu is served from a versioned, cacheable URL. The cart lives on the server so phones at one table stay in sync.

### The outlet hub (hybrid tier)

```
online:   cloud ──snapshot every minute──> hub (menu, tables, open visits with orders and unpaid
                                            bills, staff session token hashes; no passwords)
outage:   staff app ──"Switch to outlet hub"──> http://<hub>/offline#token=...  (fragment only)
          hub serves the same staff app on the LAN and answers the /v1 subset the POS, KDS,
          floor and bill screens use, with the same shared rules and DTOs; prints locally
back:     hub ──POST /v1/device/hub/sync──> cloud upserts by id, one transaction per table visit
```

- One print-agent device per outlet is the hub (`outlets.hub_device_id`); only it gets the snapshot.
- The hub refuses changes while the cloud is reachable and nothing is waiting to sync, so nobody works in two places. It accepts them while offline and until its changes have synced.
- State lives in one JSON file, written atomically (temp file, fsync, rename) before every response, so a printed invoice number survives a crash. Each write runs against a copy and rolls back on error; `Idempotency-Key` replays get the first answer.
- Offline: orders, item and order status, seat, clean, release, bills, service-charge removal, finalising (hub series), payments, reprints. Not offline: discounts, voids, refunds, splits, loyalty, menu edits. Cancelling what the kitchen has needs a manager signed in (PINs are not checked offline).
- Sync rules (`modules/hub/ingest.ts`): sessions, orders, items, bills and payments are inserted with the hub's ids or updated forward only; synced orders get a regular order number and keep the hub's (`offline_ref`); bills must match their orders line by line and add up with the shared bill maths, or they are refused and reported; a table the cloud used meanwhile is folded into the hub's visit; closed visits are applied before open ones.
- QR ordering pauses (503 `outlet_offline`) only when the outlet has a hub that has not checked in for three minutes and no staff screen is connected, i.e. the outlet is really cut off.

## Camera table vision

- The edge worker reads RTSP frames (2 per second), detects people and table items with YOLOX-s, tracks them, classifies each table zone, and sends a state only after it has held for 25 seconds with 80% agreement; it resends every 5 minutes.
- `POST /v1/vision/table-state` logs every reading in `table_state_events`; late or out-of-order readings are not applied. `tables.camera_state/at` hold the latest.
- Fusion (spec §5) is in `deriveTableState`: with no open visit, a fresh camera reading (under 15 minutes) may make a table occupied or needs-cleaning; an open session always wins; the camera cannot clear a cleaning flag set by staff or billing. Staff "clean" clears a camera mess flag. A camera-only state lapses to vacant when the camera goes quiet.
- `camera_occupied_since` marks guests seated at a table nobody opened; the floor shows "Guests waiting N min". Seating the table clears it.
- `GET /v1/reports/vision` scores readings against open visits (target 95%), and derives dwell time, tables used without an order and time to attend.
- Stills for drawing zones are uploaded only on request, blurred on the box, stored in the database (not public storage), served to managers only, excluded from exports and deleted after a day.

## UPI check

`modules/reconciliation`: a statement (CSV or .xlsx) is parsed (`statement.ts`, layout-tolerant), its credits stored once each by fingerprint, and matched over the statement's dates: by UTR (or its last digits typed by the cashier, with the same amount), then UPI credits by amount on the same or previous day. The statement view lists UPI payments with no credit (payments on the last day may still post), UPI credits with no payment, and other credits. Manual matches and set-asides are audited.

## Adding a feature

1. Schema change: add `apps/api/migrations/NNNN_name.sql`, run `npm run db:migrate`, then `npm run db:codegen -w @dineos/api`. New tenant tables need `tenant_id`, RLS, a grant to `dineos_app`, and composite foreign keys; copy the patterns in `0001_init.sql` and `0006_tenant_scoped_foreign_keys.sql`.
2. Endpoint: in the module's `routes.ts`, parse input with zod (`parse`), check permission with `requireAction` / `assertCan` (actions live in `packages/shared/src/permissions.ts`), and do the work inside `ctx.tx`. Throw `AppError` helpers for expected failures.
3. jsonb values must go through `json()`; arrays would otherwise be sent as Postgres arrays.
4. Emit events late in the transaction: `emit` locks the outlet row until commit.
5. Put response types in `packages/shared/src/dto.ts` so the web app uses the same shape.
6. Test against the real database with the helpers in `apps/api/test/helpers.ts`. New routes are automatically included in the cross-tenant suite.
