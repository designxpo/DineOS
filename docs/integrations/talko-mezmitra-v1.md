# Talko AI × Mezmitra link: contract v1

The same file lives in both repos (`restaurant Saas/docs/integrations/` and `alabs-connect-saas/docs/integrations/`). Change it in both, or not at all. A breaking change gets new paths (`/v2/...`), not an edit here.

## Who owns what

| Data | Owner | The other side |
| --- | --- | --- |
| Menu, prices, stock, outlets, opening hours | Mezmitra | Talko reads it live; keeps no copy. Talko's own catalog is off in chats for a linked tenant |
| Tables, availability, bookings | Mezmitra | Talko asks for free times and books one of them; never decides availability |
| Bills, orders, loyalty | Mezmitra | Talko receives events only |
| WhatsApp/IG/Messenger numbers, conversations, templates, AI | Talko | Mezmitra never sees them |
| Messaging opt-out | Talko | Mezmitra is told and sets `marketing_opt_in = false` |

Guests are matched by phone. Mezmitra stores `+91XXXXXXXXXX`; Talko stores digits (`91XXXXXXXXXX`) and strips non-digits on every lookup.

## Configuration (server, never per tenant)

| Side | Variable | Meaning |
| --- | --- | --- |
| Mezmitra | `TALKO_API_URL` | Talko's origin. All tenants' events go here. Must be https in production |
| Mezmitra | `INTEGRATION_ENC_KEY` | 32+ chars. Encrypts Talko's API key and webhook secret (AES-256-GCM, bound to the link row) |
| Talko | `MEZMITRA_API_URL` | Mezmitra's API origin. Must be https in production |
| Talko | `SECRET_ENC_KEY` | Existing. Encrypts the Mezmitra link key and the webhook secret |

No tenant can type a URL for either side, so a link cannot be pointed at another host. Neither side follows redirects; every call times out (8 s).

## Plans

- Mezmitra: plan feature `talko_link` (on for `trial` and `premium`). Checked when a key is made, on every request with a link key, and before every event is sent. A downgrade stops the link at once.
- Talko: entitlement `restaurant_link` (on for `trial`, `growth` and `scale`). Checked when connecting, for the AI tools, the flow step and the ping.

## Linking (one paste)

1. Mezmitra owner: Settings → Talko AI → Connect. Mezmitra makes a link `mzk_` + 43 base64url characters, stores only its SHA-256, and shows it once. The key is `pending`: it may call only `whoami` and `link`, and expires after 24 h.
2. Talko owner: Integrations → Mezmitra → paste.
3. Talko → `GET /v1/talko/whoami` → must say `pending`.
4. Talko mints its own API key (`ak_live_…`, only for Mezmitra) and a 43-character webhook secret.
5. Talko → `POST /v1/talko/link {api_key, webhook_secret, account}`. Mezmitra encrypts both and marks the link `active`. **Allowed once per key**: a key that leaks later cannot re-point events.
6. Talko saves the connection (link key encrypted). If anything fails, Talko revokes its API key and calls `unlink`.

Disconnecting from either side revokes both: Mezmitra marks the link `revoked` and drops the stored Talko key; Talko revokes its API key and calls `POST /v1/talko/unlink`.

## Talko → Mezmitra (`Authorization: Bearer mzk_…`)

All responses are JSON. Errors are `{ "error": { "code", "message" } }`.

| Method and path | Scope | Notes |
| --- | --- | --- |
| `GET /v1/talko/whoami` | link | `{tenant: {id, name, slug}, link: {id, status, scopes}}` |
| `POST /v1/talko/link` | link | Pending links only. 409 `already_linked` otherwise |
| `POST /v1/talko/unlink` | link | 204 |
| `GET /v1/talko/outlets` | outlets.read | Active outlets: name, address, city, phone, timezone, `opening_hours`, `online_booking {enabled, max_party, days_ahead}` |
| `GET /v1/talko/outlets/:id/menu` | menu.read | `{menu_version, categories: [{id, name, items: [{id, name, description, price_paise, is_veg, in_stock, available_now}]}]}`. No tax codes, stations or shortcuts |
| `GET /v1/talko/outlets/:id/availability?date=YYYY-MM-DD&party_size=n` | reservations.read | `{reason: null \| 'booking_off' \| 'party_too_large', max_party, slots: [{start, label}]}` |
| `POST /v1/talko/outlets/:id/reservations` | reservations.write | Body `{slot_start, party_size, guest_name, phone, channel: whatsapp\|instagram\|messenger\|webchat, external_ref?, notes?}`. 201 with the booking. 409 `slot_unavailable`, `party_too_large`, `booking_off`, `too_many_bookings` (3 upcoming per phone). The same phone, outlet, time and party returns the existing booking. 30 writes/min per key |
| `POST /v1/talko/reservations/lookup` | reservations.read | Body `{phone}`. Upcoming bookings for that number |
| `POST /v1/talko/reservations/:ref/cancel` | reservations.write | Body `{phone}`. Wrong code or wrong phone are the same 404 |
| `GET /v1/talko/orders/:code` | orders.read | Order status by tracking code; another tenant's code is 404 |

A booking view is `{id, ref, outlet_id, outlet_name, slot_start, date, time, party_size, status}`, with no table, staff or notes.

Talko calls lookup and cancel only with a WhatsApp sender's own number (WhatsApp has verified it). On Instagram, Messenger and web chat, guests can book (giving a number) but cannot list or cancel.

## Mezmitra → Talko events (`POST {TALKO_API_URL}/api/events`)

Headers: `Authorization: Bearer ak_live_…`, `Idempotency-Key: <outbox row id>`. Body: `{event, phone, name?, data}`. Talko replays the first answer for a repeated key and schedules nothing again (`wa_api_event_receipts`, kept 7 days).

| `event` | When | `data` |
| --- | --- | --- |
| `mezmitra.bill.paid` | A bill is paid in full and has a customer saved with consent. Once per table visit | `outlet_id, outlet_name, bill_id, invoice_no, total, total_paise, paid_at, visit_count, points_balance, marketing_opt_in, review_url` |
| `mezmitra.reservation.created` | A booking with a phone is made by staff (with consent) or on WhatsApp | `outlet_id, outlet_name, outlet_phone, booking_id, booking_ref, date, time, slot_start, party_size, source` |
| `mezmitra.reservation.cancelled` | Such a booking is cancelled | same |
| `mezmitra.reservation.reminder` | `reminder_minutes` before such a booking, once | same |
| `mezmitra.order.ready` | A takeaway or counter order with a phone is ready | `outlet_id, outlet_name, order_no, track_code, track_url` |

Bookings made on Instagram, Messenger or web chat never produce these: the number was typed, not verified, and WhatsApp may only message people who asked for it.

Delivery: written to `integration_outbox` in the same transaction as the change, sent right after commit, swept every minute. Retries at 1, 5, 15, 60, 180 minutes; dead after 6 attempts or 24 h; a 401/403 is dead at once and shown to the owner. Rows past `expires_at` are skipped (a thank-you 6 h after payment, a reminder after the booking started). Rows are deleted after 30 days.

Review requests are marketing messages: Talko rules for `mezmitra.bill.paid` should require `marketing_opt_in equals true` and use a frequency cap (2,160 h = 90 days).

## Talko → Mezmitra opt-out webhook

`POST {MEZMITRA_API_URL}/v1/talko/webhooks/:linkId` with Talko's standard signed envelope: `X-Alabs-Signature: sha256=<hex HMAC-SHA256 of the raw body with the webhook secret>`, `X-Alabs-Event`, `X-Alabs-Delivery`. Only `contact.optout` is acted on: Mezmitra sets `marketing_opt_in = false` for that number. Harmless to repeat.
