-- Push alerts on staff phones while the portal is closed (Web Push with VAPID keys; delivered by
-- the browser's push service). One row per device a staff member turned alerts on for, at one
-- outlet. Devices the push service no longer knows are deleted when a send comes back 404 or 410.

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  outlet_id uuid not null references outlets(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_subscriptions_outlet_idx on push_subscriptions (outlet_id);
select dineos_secure_table('push_subscriptions');
