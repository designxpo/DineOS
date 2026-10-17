-- Which menu and settings each screen and print computer is running. A change bumps the outlet's
-- config_version; staff screens report the version they have applied as they check in, and a
-- print computer applies it when it fetches its settings. "Saved" and "on every screen" are then
-- different, visible states, and a screen that is behind can be reloaded from the office.
alter table outlets add column config_version bigint not null default 1;
alter table devices
  add column applied_version bigint,
  add column applied_at timestamptz;

create table screens (
  -- Made by the browser and kept in its storage, so a screen keeps its name across reloads.
  id uuid not null,
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  label text not null default '' check (length(label) <= 40),
  kind text not null check (kind in ('kitchen', 'till', 'floor', 'orders', 'bills', 'other')),
  user_id uuid references users(id),
  applied_version bigint,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  reload_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index screens_outlet_idx on screens (outlet_id, last_seen_at desc);
select dineos_secure_table('screens');
