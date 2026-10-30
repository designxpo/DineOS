# Mezvaan × Talko AI link: plan

Status: phases 1–4 built on 2026-10-29 (branches `feat/talko-link` here, `feat/mezmitra-link` in Talko), not merged. The wire contract is [docs/integrations/talko-mezmitra-v1.md](../integrations/talko-mezmitra-v1.md); where it and this plan differ, the contract wins. Differences from this plan:

- Chat bookings are confirmed at once, within the owner's limits (hours, largest party, lead time, days ahead). No "requested" state.
- Bookings made on Instagram, Messenger or web chat never trigger WhatsApp messages: the number was typed, not verified.
- Talko rules are not created automatically (each needs an approved template); Talko's Mezvaan card lists the events and their fields and links to API rules.
- Outlet choice: one default outlet plus matching the name the guest says, instead of a per-channel map.
- No `order_status` AI tool yet (the API exists); guests already get the tracking link.
- Booking and cancelling run only in live auto-replies, never in drafts, tests or public comment replies.
- Phase 5 (ordering in chat) is not built.

## What this is

A restaurant that buys both products connects them once, by pasting one key. After that:

- Guests book tables, ask about the menu and check their order on WhatsApp, Instagram, Messenger or the website chat (Talko). The answers come live from Mezvaan.
- Mezvaan tells Talko when something happens (bill paid, booking made, order ready). Talko sends the right WhatsApp message.
- Each system keeps doing its own job. Neither one writes into the other's database.

## What already exists (checked in the code, 2026-10-29)

Everything in this plan builds on these. Paths are relative to each repo.

| Fact | Where |
| --- | --- |
| **Mezvaan** is Fastify + Kysely + Postgres with row-level security per tenant; every query runs inside `ctx.tx(tenantId, …)` | `apps/api/src/context.ts` |
| Mezvaan auth knows four callers: `staff`, `guest`, `device`, `admin`. There is no API key for outside systems | `apps/api/src/lib/auth.ts` |
| Mezvaan writes events to an `outlet_events` outbox in the same transaction, then pushes them to sockets. It has no outbound webhooks | `apps/api/src/context.ts`, `packages/shared/src/events.ts` |
| Bills become `paid` in one place | `apps/api/src/modules/billing/service.ts:830` |
| Reservations: create with clash check, free-table availability, `source` is `phone \| walk_in \| online \| other` | `apps/api/src/modules/reservations/routes.ts` |
| Outlets have **no opening hours** field and no Google review link | `apps/api/src/db/schema.ts` (`Outlets`) |
| Public guest menu and per-order tracking link already exist | `/public/menu/:tenantId/:outletId`, `/public/track/:code` |
| Customers are saved only with consent (`consent_source`: `staff \| guest`) and have `marketing_opt_in` | `apps/api/src/modules/customers/service.ts` |
| Order sources are `guest_qr \| waiter \| pos` | `packages/shared/src/enums.ts` |
| Idempotency keys for mutating requests already exist | `apps/api/src/lib/idempotency.ts` |
| A background maintenance job runs with an advisory lock | `apps/api/src/lib/maintenance.ts` |
| Mezvaan can hash secrets but **cannot encrypt and decrypt** them (no reversible encryption yet) | `apps/api/src/lib/crypto.ts` |
| Phones are stored as `+91XXXXXXXXXX` | `packages/shared/src/phone.ts` |
| **Talko** is Next.js + Supabase, multi-tenant (`tenants` table, `current_tenant_id()` RLS) | `supabase/migrations/0019_tenancy.sql` |
| Talko has an integrations registry (`wa_integrations`, encrypted secrets, `verify()` / `deliver()` per kind). Kinds today: webhook, slack, teams, hubspot, pipedrive, leadsquared, razorpay, stripe, shopify, woocommerce, calcom | `src/lib/integrations.ts` |
| Talko signs outbound webhooks (`X-Alabs-Signature: sha256=…`, `X-Alabs-Delivery`) and retries failed deliveries with backoff | `src/lib/integrations.ts:175`, `:926` |
| Per-tenant API keys (hash stored), mintable from code with `createApiKey()` | `src/lib/apikeys.ts` |
| `POST /api/events` takes `{event, phone, name, data}` and runs **API rules**: conditions, variable mapping, delay, send window, frequency cap, opt-out suppression. **It has no idempotency key**, so a retried call sends twice | `src/app/api/events/route.ts`, `src/lib/apirules.ts` |
| A flow node `book` books Cal.com meetings (slots list → pick → book). It is meeting-shaped: email, no party size | `src/lib/flowengine.ts:773` |
| The AI has tool calling. Built-in commerce tools exist, and their results are passed to the grounding firewall as trusted facts (`toolFacts`) | `src/lib/llm.ts:336`, `:676` |
| GroundingFirewall strips or defers any price, date, time, phone or link the AI states that does not trace back to trusted context | `src/lib/guard/grounding.ts` |
| Talko has its own product catalog and orders (`wa_products`, `wa_orders`) and a Google reviews reply module | `0022_automation_commerce_growth.sql`, `src/lib/reviews.ts` |
| Contacts have proof of opt-in (`opted_in`, `opt_in_source`); phones stored as digits `91XXXXXXXXXX` | `0043_contact_opt_in.sql`, `src/lib/phone.ts` |

## Rule 1: one owner for every piece of data

This rule is what prevents overlap. Every fact has one home. The other system asks for it live or receives an event; it never keeps an editable copy.

| Data | Owner | The other system… |
| --- | --- | --- |
| Menu, prices, stock, modifiers | Mezvaan | Talko reads it live through the API. It is not copied into Talko's catalog or knowledge base |
| Tables, availability, reservations, waitlist | Mezvaan | Talko asks for availability and creates or cancels bookings through the API |
| Orders, bills, GST invoices, payments | Mezvaan | Talko only reads order status by tracking code |
| Loyalty points, visits, spend | Mezvaan | Sent to Talko in event data, read-only |
| WhatsApp/IG/Messenger numbers, tokens, templates | Talko | Mezvaan never sees them |
| Conversations, AI replies, flows, broadcasts | Talko | Mezvaan never sees them |
| Messaging opt-in and opt-out | Talko | Mezvaan is told about opt-outs and turns off `marketing_opt_in` |
| Google review replies | Talko (existing module) | — |
| The customer's identity across both | Phone number in E.164 (`+91…`) | Each side converts at the edge (Mezvaan `+91…`, Talko `91…`) |

Two consequences:

1. For a linked tenant, Talko's own catalog/cart AI tools are switched off, so there are never two menus with two prices. Ordering on chat comes later (Phase 3) and creates the order **in Mezvaan**.
2. Talko's knowledge base keeps only things that rarely change: address, parking, policies. Hours, menu, prices and table availability always come from live API calls.

## Rule 2: the AI can't invent facts

- Anything about availability, prices, menu items, booking status or order status comes from a tool call to Mezvaan. The system prompt says so, and the existing GroundingFirewall enforces it: a time or price that did not come from a tool result or the knowledge base is stripped or deferred.
- Tool results go into `toolFacts`, the mechanism Talko's commerce tools already use, so correct figures pass the firewall.
- A booking is "confirmed" only when Mezvaan answered `201` with a booking reference. Any other result (timeout, clash, outlet closed) is a tool error. The AI says it could not confirm and hands the chat to staff. It never says "booked" on its own.
- If the link is broken, the tools are simply not offered, and the AI falls back to "our team will confirm", which the prompt already does for missing information.

## How the two connect

```
 Restaurant owner                       one-time setup
 ─────────────────────────────────────────────────────────────────────────
 Mezvaan Settings → Integrations → "Connect Talko AI"
     └─ shows a link key  mzk_live_… (shown once)
 Talko Settings → Integrations → "Mezvaan"  → paste key → Connect
     └─ Talko checks the key  (GET  /integrations/v1/whoami)
     └─ Talko mints its own API key + webhook secret and hands them over
        (POST /integrations/v1/link)       → both sides now show "Connected"

 Every day
 ─────────────────────────────────────────────────────────────────────────
 Talko ──(Bearer mzk_…)──────────────▶ Mezvaan  /integrations/v1/*
        menu, availability, book, cancel, order status          (live reads/writes)

 Mezvaan ──(Bearer Talko API key, Idempotency-Key)──▶ Talko  POST /api/events
        bill.paid, reservation.*, order.ready                   (outbox + retries)

 Talko ──(X-Alabs-Signature)─────────▶ Mezvaan  /integrations/v1/webhooks/talko
        contact.optout                                          (existing signed webhooks)
```

One link joins one Mezvaan tenant to one Talko tenant. Outlets map to Talko channels (`outletMap: { channelId → outletId }`) with a default outlet; when a tenant has several outlets and the channel is not mapped, the AI asks which outlet.

## What guests and owners get

| # | Journey | Built from |
| --- | --- | --- |
| 1 | Guest messages "table for 4 tomorrow 8 pm" on any channel. The AI checks live availability, offers times, books it, and replies with the booking reference | New AI tools + new `booktable` flow node → Mezvaan reservations |
| 2 | Booking confirmation and a reminder before the slot on WhatsApp; guest can cancel by replying | Mezvaan `reservation.*` events → Talko API rules → approved templates |
| 3 | After the bill is paid: thank-you, then (after a delay) the Google review request, at most once per 90 days per guest | `bill.paid` event → Talko API rule with delay + frequency cap |
| 4 | Takeaway/counter order is ready: WhatsApp with the tracking link | `order.ready` event, existing `/public/track/:code` |
| 5 | "Is the paneer tikka available?" / "What's veg under ₹300?" answered from the live menu | `get_menu` tool |
| 6 | Guest replies STOP: Mezvaan marks them not opted in for marketing | Talko `contact.optout` → Mezvaan webhook |
| 7 (Phase 3) | Order takeaway on WhatsApp; goes to the manager-approval inbox like a QR order | New Mezvaan order source `whatsapp` |

Each message type needs a WhatsApp template approved by Meta in the tenant's Talko account. Review requests will most likely be classed as **marketing** templates, so they go only to guests who opted in, and they cost more per message than utility templates. Check Meta's current categories and prices before launch.

---

## Changes in Mezvaan (`restaurant Saas`)

### Database: new migration `0041_integrations.sql`

| Change | Why |
| --- | --- |
| Table `integration_links`: `id, tenant_id, provider ('talko'), status, key_prefix, key_hash, scopes text[], peer_base_url, peer_api_key_enc, peer_webhook_secret_enc, outlet_map jsonb, created_by, created_at, revoked_at, last_ok_at, last_error` | One row per connection. Our key is stored hashed; Talko's key and webhook secret are stored encrypted |
| Table `integration_outbox`: `id, tenant_id, link_id, outlet_id, event, payload jsonb, status (pending/sent/failed/dead/skipped), attempts, next_attempt_at, last_error, created_at, sent_at` | Events written **in the same transaction** as the bill/reservation change, so none are lost, and billing never waits on Talko |
| `outlets`: `opening_hours jsonb`, `online_booking_enabled bool default false`, `online_booking_max_party int`, `online_booking_lead_minutes int`, `google_review_url text` | Opening hours don't exist today; without them the AI could offer a 3 am table. Online booking stays off until the owner turns it on |
| `reservations`: `external_ref text`, `reminder_sent_at timestamptz` | Talko conversation id for traceability; a reminder is sent once |
| `reservations.source`: allow `whatsapp, instagram, messenger, webchat` (zod + `ReservationDTO` + labels) | Floor screen shows where a booking came from |
| `customers.consent_source`: allow `talko` | A guest who booked by chat gave their number for that booking |
| RLS policies on both new tables | Same tenant isolation as every other table |

### Code

| Area | Change |
| --- | --- |
| `lib/crypto.ts` | Add `encryptSecret` / `decryptSecret` (AES-256-GCM, new env `INTEGRATION_ENC_KEY`). Today there is only hashing |
| `lib/auth.ts` | New caller kind `integration` (Bearer `mzk_live_…`, looked up by hash, carries `tenantId`, `linkId`, `scopes`). `requireIntegration(req, scope)` |
| New `modules/integrations/` | **Owner routes** (staff, owner role): create link key, show status, set outlet map, test, revoke, view failed deliveries. **Machine routes** `/integrations/v1/*` (see the contract below) |
| Machine routes reuse existing logic | `loadMenu(…, { forGuest: true })`, `availableTables`, `assertNoClash`, `upsertCustomer`, `announceReservations`; the order tracking lookup used by `/public/track/:code` |
| Booking rules for the API | Reject when outside opening hours, online booking off, party above the maximum, inside the lead time, or slot in the past. Do not pick a specific table unless one is free; staff still seat the guest. Idempotent by `Idempotency-Key` (existing `lib/idempotency.ts`) |
| Event emitters | `billing/service.ts` when a bill becomes `paid` → `bill.paid`; reservation create/update/cancel/seat/no-show → `reservation.created/updated/cancelled/seated/no_show`; items ready on a takeaway/counter order with a phone → `order.ready`. Only when the tenant has an active link and the guest has a phone |
| Dispatcher | New job beside `runMaintenance` (own advisory lock, every 15 s): send pending outbox rows to Talko `POST /api/events` with `Idempotency-Key = outbox id`; back off 1, 5, 15, 60, 180 min; mark `dead` after 24 h and show it in settings. Skip `bill.paid` older than 6 h (e.g. bills synced late from the offline hub) so nobody gets a review request the next day |
| Reminder job | Every 5 min: confirmed reservations starting within the owner's reminder window with `reminder_sent_at` null → `reservation.reminder` |
| Opt-out webhook | `POST /integrations/v1/webhooks/talko`: verify `X-Alabs-Signature` with the stored secret, dedupe on `X-Alabs-Delivery`, set `marketing_opt_in = false` for that phone |
| Web: Settings → Integrations | Connect / disconnect Talko, outlet mapping, opening hours editor, online booking switch and limits, Google review link, delivery log with retry |
| Floor/reservations UI | Source badge (WhatsApp, Instagram…) on bookings |
| Plans | `features.talko_link` in `plans` so it can be sold as an add-on |
| Tests | Machine routes added to `cross-tenant.test.ts` (key of tenant A can't touch tenant B); new tables in `rls.test.ts`; booking API tests (hours, clash, idempotent retry); outbox tests (written in the bill transaction, rolled back with it, retried, deduped, stale skip) |

## Changes in Talko AI (`alabs-connect-saas`)

### Database

| Change | Why |
| --- | --- |
| New migration: table `wa_api_event_receipts (tenant_id, idem_key, response jsonb, created_at, unique(tenant_id, idem_key))` | `/api/events` has no idempotency today. Without it, one Mezvaan retry = two WhatsApp messages |
| No new integration table | `wa_integrations` already holds kind, config, encrypted secret, status |

### Code

| Area | Change |
| --- | --- |
| `src/app/api/events/route.ts` | Read `Idempotency-Key`; if seen for this tenant, return the stored response and send nothing |
| `src/lib/integrations.ts` | New kind `mezmitra` (label "Mezvaan"; new group `RESTAURANT_KINDS`). `verify()` calls `/integrations/v1/whoami`. `deliver()` handles `contact.optout` (so it is also in `EVENT_KINDS`). Config: `baseUrl`, `outletMap`, `defaultOutletId` |
| Connect route (`src/app/api/admin/integrations`) | For `mezmitra`: verify → `createApiKey(tenant, "Mezvaan link")` + random webhook secret → `POST /integrations/v1/link` → save. Disconnect revokes the Talko API key and calls Mezvaan to revoke its side |
| New `src/lib/mezmitra.ts` | Typed client: `getOutlets`, `getMenu`, `availability`, `book`, `cancel`, `orderStatus`. Same style as `calcomSlots`: timeouts, never throws, returns `null` when not connected |
| `src/lib/llm.ts` | `RESTAURANT_TOOLS` offered only when an active `mezmitra` link exists: `get_menu`, `check_table_availability`, `book_table`, `cancel_booking`, `order_status`. Results pushed into `toolFacts`. System prompt rule: never state availability, price or a confirmation that no tool returned. Built-in commerce tools are off for linked tenants |
| `src/lib/flowengine.ts` + flow builder | New node `booktable`: ask party size → date → show free times as a WhatsApp list → book → confirm, or the fallback text. Built like the existing `book` node, with its resume step |
| Instagram / Messenger / web chat | These contacts have no phone number. Before `book_table`, the AI asks for one (the existing ask-phone behaviour); the booking stores `external_ref` so staff can trace it |
| API rule presets | On connect, create **paused** rules for `mezmitra.reservation.created`, `mezmitra.reservation.reminder`, `mezmitra.order.ready`, `mezmitra.bill.paid` (thank-you, plus a review request with a 45 min delay, a 2,160 h (90-day) frequency cap and the condition `data.marketing_opt_in = true`). The owner picks an approved template for each and switches it on |
| Entitlements | Add `restaurant_link` to the entitlement registry so it can be sold per plan |
| Settings UI | Mezvaan card: status, outlet ↔ channel mapping, "Test connection", shortcut to the four rules |
| Tests (vitest) | Connector verify/deliver; client against a mock Mezvaan; AI tool runs with failures (timeout → no "booked" claim); `/api/events` replay sends once; `booktable` node flow |

## The contract (v1)

Kept in both repos as `docs/integrations/talko-mezmitra-v1.md` with JSON examples. Both test suites check against the same fixtures, so if one side changes a field, its tests fail.

**Talko → Mezvaan** (`Authorization: Bearer mzk_live_…`)

| Endpoint | Scope | Returns |
| --- | --- | --- |
| `GET /integrations/v1/whoami` | — | tenant name, outlets, scopes |
| `POST /integrations/v1/link` | `link` | stores Talko's API key, base URL, webhook secret |
| `GET /integrations/v1/outlets` | `outlets.read` | id, name, address, phone, opening hours, online booking settings |
| `GET /integrations/v1/outlets/:id/menu` | `menu.read` | guest menu (names, prices, veg, in stock, modifiers) and `menu_version` |
| `GET /integrations/v1/outlets/:id/availability?date&party_size` | `reservations.read` | open start times for that day |
| `POST /integrations/v1/outlets/:id/reservations` | `reservations.write` | `201 {id, ref, slot_start, party_size, status}` or a typed error: `closed`, `full`, `party_too_large`, `too_soon`, `booking_off` |
| `POST /integrations/v1/reservations/:id/cancel` (phone must match) | `reservations.write` | updated booking |
| `GET /integrations/v1/orders/track/:code` | `orders.read` | status, ready time |
| `POST /integrations/v1/webhooks/talko` | signed | `contact.optout` |

**Mezvaan → Talko** (`POST /api/events`, existing endpoint)

`{ event: "mezmitra.bill.paid", phone: "+91…", name, data: { outlet_id, outlet_name, bill_id, invoice_no, total_rupees, visit_count, marketing_opt_in, review_url, occurred_at } }`. The other events send the same envelope with their own `data`. Only the fields a message needs are sent; no item lists, no GSTIN.

## How each risk is handled

| Risk | Guard |
| --- | --- |
| Two menus or two prices | Menu lives only in Mezvaan; Talko commerce tools off for linked tenants |
| Double booking | Mezvaan's existing clash check is the only gate; Talko never decides availability |
| Same message sent twice | `Idempotency-Key` on both directions; Talko frequency cap on top |
| Bill or booking saved but event lost | Outbox row written in the same transaction |
| Talko down | Outbox retries; billing and the floor never wait on it |
| Mezvaan down | AI tools fail → AI says it can't confirm and hands over to staff |
| AI invents a time, price or confirmation | Tool-only facts + GroundingFirewall + "confirmed only on 201" rule |
| Leaked key | Keys are scoped, hashed, revocable from either side; rate limits on both APIs; `cross-tenant.test.ts` covers the new routes |
| Messaging someone who said STOP | Talko opt-out list is checked at send time (existing); Mezvaan mirrors it in `marketing_opt_in` |
| Late events from the offline hub | `bill.paid` older than 6 h is skipped, not sent |
| Phone format mismatch (`+91…` vs `91…`) | Converted only at the API edge, with tests for both formats |
| One side changes the API | Shared v1 contract and fixtures; breaking changes go to `/v2` |

## Build order

| Phase | Scope | Done when |
| --- | --- | --- |
| 0 | Contract doc + fixtures; decisions below answered | Both repos have the same contract file |
| 1 | Link and trust: encryption, integration auth, link/unlink both sides, whoami, outlets, Talko `/api/events` idempotency | Owner pastes a key in Talko, both settings pages say Connected; disconnect from either side works |
| 2 | Events out: outbox, dispatcher, `bill.paid`, `reservation.*`, `order.ready`, reminders; opt-out webhook; paused rule presets | A paid test bill produces exactly one WhatsApp thank-you, and a replayed event produces none |
| 3 | Booking in chat: opening hours + online booking settings, availability and booking API, AI tools, `booktable` flow node | A WhatsApp chat books a table that appears on the floor map with a WhatsApp badge; a full slot is never "confirmed" |
| 4 | Menu answers (`get_menu`) and order status in chat | Price questions answered with the live price; an out-of-stock item is never offered |
| 5 (later) | Order takeaway on WhatsApp → Mezvaan order source `whatsapp`, manager approval, pay-at-counter or UPI link | Separate scoping |

Phases 1 to 4 are worth piloting at the hotel restaurant before taking orders over chat.

## Decisions needed from you

1. **Pricing:** sell the link as a paid add-on in both products, or include it in a bundle plan?
2. **Who confirms chat bookings:** confirmed instantly, or held as "requested" until a manager accepts (like guest QR orders)?
3. **Review requests:** OK to send only to guests with `marketing_opt_in = true`? This is the rule Meta's marketing templates need, and it means fewer requests.
4. **Instagram/Messenger bookings:** always ask for a phone number (needed for reminders), or allow bookings without one?
5. **Hosting:** Mezvaan's public API URL that Talko will call in production (Talko is on Vercel).
