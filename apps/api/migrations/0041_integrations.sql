-- The link to Talko AI, the messaging product (WhatsApp, Instagram, Messenger, web chat). An owner
-- connects the two once; Talko then reads the menu and books tables through /v1/integrations/v1/*,
-- and Mezmitra tells Talko when a bill is paid, a booking is made or an order is ready.
-- Each product keeps its own data: nothing here copies Talko's conversations, and Talko keeps no
-- editable copy of the menu or bookings.

create table integration_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  provider text not null check (provider in ('talko')),
  -- pending: key made, Talko has not finished linking. active: both directions work.
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  -- The key Talko presents (mzk_...). Only its hash is stored; the key is shown once.
  token_hash text not null unique,
  token_prefix text not null check (length(token_prefix) <= 20),
  scopes text[] not null,
  -- Talko's side, filled in when Talko completes the link. Both secrets are encrypted at rest
  -- (lib/crypto.ts encryptSecret) and never returned by any endpoint.
  peer_account text check (length(peer_account) <= 120),
  peer_api_key_enc text,
  peer_webhook_secret_enc text,
  created_by uuid references users(id),
  linked_at timestamptz,
  last_used_at timestamptz,
  last_error text check (length(last_error) <= 500),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live link per tenant and provider.
create unique index integration_links_live_idx on integration_links (tenant_id, provider) where status <> 'revoked';
select mezmitra_secure_table('integration_links');

-- Resolves an integration key at the auth layer, before any tenant is known (like auth_device).
-- plan_allows: the tenant's plan includes the link, so a downgrade ends access without a revoke.
create function auth_integration(p_token_hash text)
returns table (link_id uuid, tenant_id uuid, provider text, status text, scopes text[], created_at timestamptz, tenant_status text, plan_allows boolean)
language sql stable security definer set search_path = public as $$
  select l.id, l.tenant_id, l.provider, l.status, l.scopes, l.created_at, t.status,
         coalesce((p.features ->> 'talko_link')::boolean, false)
  from integration_links l
  join tenants t on t.id = l.tenant_id
  left join plans p on p.code = t.plan_code
  where l.token_hash = p_token_hash
$$;
revoke execute on function auth_integration(text) from public;
grant execute on function auth_integration(text) to dineos_app, dineos_admin;

-- Events for Talko, written in the same transaction as the bill or booking they describe, so a
-- rollback takes them with it and a crash after commit cannot lose them. A dispatcher sends them.
create table integration_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  link_id uuid not null references integration_links(id),
  outlet_id uuid references outlets(id),
  event text not null check (length(event) <= 60),
  phone text not null check (length(phone) <= 20),
  name text check (length(name) <= 80),
  payload jsonb not null,
  -- One row per real-world happening (e.g. bill.paid:<bill id>), so a re-synced offline bill or a
  -- retried request cannot queue the same message twice.
  dedupe_key text not null check (length(dedupe_key) <= 120),
  -- Past this the message is no use (a thank-you the next day, a reminder after the booking) and
  -- is skipped rather than sent late.
  expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'sent', 'dead', 'skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text check (length(last_error) <= 500),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);
create index integration_outbox_due_idx on integration_outbox (next_attempt_at) where status = 'pending';
create index integration_outbox_link_idx on integration_outbox (link_id, created_at desc);
select mezmitra_secure_table('integration_outbox');

alter table outlets
  -- {"mon": [["12:00", "15:30"], ["19:00", "23:30"]], ...} in the outlet's timezone; a day left out is
  -- closed. Null until the owner sets it; online booking needs it.
  add column opening_hours jsonb,
  -- {"enabled": bool, "max_party": n, "lead_minutes": n, "days_ahead": n, "last_seating_minutes": n}
  add column online_booking jsonb not null default '{"enabled": false}',
  -- The outlet's Google review page, sent with the thank-you after a paid bill.
  add column google_review_url text check (google_review_url ~ '^https://[^\s]+$' and length(google_review_url) <= 500);

alter table reservations drop constraint reservations_source_check;
alter table reservations add constraint reservations_source_check
  check (source in ('phone', 'walk_in', 'online', 'other', 'whatsapp', 'instagram', 'messenger', 'webchat'));
alter table reservations
  -- The guest-facing booking code a chat booking is confirmed with, e.g. BK7Q4M2X.
  add column public_ref text check (public_ref ~ '^BK[A-Z0-9]{6}$'),
  -- Where a chat booking came from on Talko's side, for tracing it back to the conversation.
  add column external_ref text check (length(external_ref) <= 120),
  add column reminder_sent_at timestamptz;
create unique index reservations_public_ref_idx on reservations (tenant_id, public_ref) where public_ref is not null;
create index reservations_reminder_idx on reservations (slot_start) where status = 'booked' and reminder_sent_at is null and guest_phone is not null;

-- A guest who gives their number in a chat to book a table. Like 'guest', the number is not
-- proven to be theirs, so it may link a booking but never rename a record or opt it into marketing.
alter table customers drop constraint customers_consent_source_check;
alter table customers add constraint customers_consent_source_check check (consent_source in ('staff', 'guest', 'chat'));

-- Sold with the Premium plan; the trial includes it so restaurants can try it.
update plans set features = features || '{"talko_link": true}' where code in ('premium', 'trial');
update plans set features = features || '{"talko_link": false}' where code = 'standard';
