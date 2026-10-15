# Architecture

## Pieces

```
Guest phone (PWA) ─┐
Waiter tablet ─────┤                     ┌── PostgreSQL 16 (row-level security, event outbox, print jobs)
Kitchen display ───┼── Caddy ── web (Next.js 16) 
Cashier POS ───────┤        └── api (Fastify 5) ──┼── Redis (Socket.IO fan-out between API servers)
Owner / admin ─────┘              │               └── object storage (menu photos: local disk or S3/MinIO)
                                  └── Socket.IO /staff, /guest, /device
Print agent (outlet PC) ── outbound socket + REST ── ESC/POS printers on port 9100
```

| Package | Contents |
| --- | --- |
| `packages/shared` | Rules both sides must agree on: order state machine, GST bill arithmetic (integer paise), invoice numbering and Indian financial year, menu schedules and modifier rules, table state derivation, role permissions, API DTO types, event names |
| `apps/api` | Fastify modules under `src/modules/*`, each exposing `routes(ctx)`; SQL migrations in `migrations/`; tests in `test/` against a real database |
| `apps/web` | Next.js app: `app/t/[token]` guest, `app/app/*` staff portal, `app/admin` platform admin, `app/print/*` 80 mm browser print views |
| `apps/print-agent` | Node agent with a small ESC/POS encoder and KOT/invoice layouts |

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
- Guest orders wait in the inbox unless the outlet auto-accepts. The first order from each new phone is flagged, and can still require approval with auto-accept on. Staff orders go straight to the kitchen.
- Accepting an order creates one kitchen ticket (KOT) per station and, if a print agent is registered, a print job.
- Table state (vacant, occupied, ordered, served, bill requested, needs cleaning) is derived from session, orders and bill requests and stored with a history in `table_state_events`. Camera input (Phase 3) will write to the same table with `source = 'camera'`.

## Billing

- A draft bill is recomputed from the session's accepted, uncancelled, not-yet-billed items whenever it is read or changed. Discounts, the service-charge choice and splits are the only stored inputs.
- Splitting by item or seat creates separate bills, each with its own invoice. Splitting by amount keeps one invoice and shows equal or custom shares to pay separately.
- Finalising takes the next number from a per-outlet, per-financial-year counter row (`PREFIX/2627/000123`, at most 16 characters). The row lock serialises concurrent cashiers and a rollback returns the number, so the series has no gaps or duplicates. Voided invoices keep their number.
- Voids, refunds, cancelling food the kitchen has, and discounts above 10% need a manager. If the cashier lacks the permission, a manager enters their login and PIN on the same screen; that issues a single-use, two-minute approval token, and everything is written to `audit_log`.
- Payments go through `PaymentAdapter`. In Phase 1 it is manual: staff confirm cash, a UPI credit to the outlet's own VPA, or a card slip. A gateway can implement the interface later.

## Offline behaviour

- Staff screens: a service worker caches the app shell; the POS keeps the menu in IndexedDB. Order creation, status changes, KDS taps and payments are queued in IndexedDB with their idempotency keys when the network is down, and replayed on reconnect.
- Guests: the menu is served from a versioned, cacheable URL. The cart lives on the server so phones at one table stay in sync.
- Full offline operation (the hybrid tier) is out of scope for Phase 1.

## Adding a feature

1. Schema change: add `apps/api/migrations/NNNN_name.sql`, run `npm run db:migrate`, then `npm run db:codegen -w @dineos/api`. New tenant tables need `tenant_id`, RLS, a grant to `dineos_app`, and composite foreign keys; copy the patterns in `0001_init.sql` and `0006_tenant_scoped_foreign_keys.sql`.
2. Endpoint: in the module's `routes.ts`, parse input with zod (`parse`), check permission with `requireAction` / `assertCan` (actions live in `packages/shared/src/permissions.ts`), and do the work inside `ctx.tx`. Throw `AppError` helpers for expected failures.
3. jsonb values must go through `json()`; arrays would otherwise be sent as Postgres arrays.
4. Emit events late in the transaction: `emit` locks the outlet row until commit.
5. Put response types in `packages/shared/src/dto.ts` so the web app uses the same shape.
6. Test against the real database with the helpers in `apps/api/test/helpers.ts`. New routes are automatically included in the cross-tenant suite.
