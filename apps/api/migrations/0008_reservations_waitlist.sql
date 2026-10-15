-- Phase 2: reservations and the walk-in waitlist.

create table reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  table_id uuid references tables(id),
  customer_id uuid references customers(id),
  guest_name text not null,
  -- Kept only when the guest agreed to be contacted about the booking.
  guest_phone text,
  party_size integer not null check (party_size between 1 and 200),
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  status text not null default 'booked' check (status in ('booked', 'seated', 'completed', 'cancelled', 'no_show')),
  source text not null default 'phone' check (source in ('phone', 'walk_in', 'online', 'other')),
  notes text,
  table_session_id uuid references table_sessions(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (slot_end > slot_start)
);
create index reservations_outlet_slot_idx on reservations (outlet_id, slot_start);
create index reservations_table_slot_idx on reservations (table_id, slot_start) where status in ('booked', 'seated');
select dineos_secure_table('reservations');

create table waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  guest_name text not null,
  guest_phone text,
  party_size integer not null check (party_size between 1 and 200),
  quoted_minutes integer check (quoted_minutes between 0 and 600),
  status text not null default 'waiting' check (status in ('waiting', 'notified', 'seated', 'left')),
  notes text,
  table_id uuid references tables(id),
  table_session_id uuid references table_sessions(id),
  notified_at timestamptz,
  seated_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index waitlist_active_idx on waitlist_entries (outlet_id, created_at) where status in ('waiting', 'notified');
select dineos_secure_table('waitlist_entries');

alter table outlets
  -- Default length of a booking, used to find clashes and free tables.
  add column reservation_minutes integer not null default 90 check (reservation_minutes between 15 and 600),
  -- Minutes after the booked time before an unseated booking becomes a no-show.
  add column reservation_grace_minutes integer not null default 30 check (reservation_grace_minutes between 0 and 240);
