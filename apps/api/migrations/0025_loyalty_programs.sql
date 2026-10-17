-- Loyalty programmes. One per tenant (all its outlets): how guests earn (points, stamps or
-- nothing), levels, and moments (welcome, birthday, comeback, happy hours), as a config the owner
-- builds from a template or from scratch. The outlet loyalty_* columns are no longer read; an outlet
-- that had loyalty on gets a Cashback programme with the same numbers the first time it is needed.
create table loyalty_programs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 1 and 60),
  template text,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  config jsonb not null,
  activated_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index loyalty_programs_current_key on loyalty_programs (tenant_id) where status <> 'archived';
select dineos_secure_table('loyalty_programs');

alter table customers
  add column stamps integer not null default 0 check (stamps >= 0),
  add column level text;

-- Stamps are logged beside points; points and stamps lapse after a long absence ('expire'); welcome
-- points are a 'bonus'.
alter table loyalty_ledger add column stamps integer not null default 0;
alter table loyalty_ledger drop constraint loyalty_ledger_kind_check;
alter table loyalty_ledger add constraint loyalty_ledger_kind_check check (kind in ('earn', 'redeem', 'reverse', 'adjust', 'expire', 'bonus'));

-- A reward a guest has earned and not yet used: from a full stamp card, a level's monthly perk, or a
-- moment. Money off sits on a draft bill ('applied') until it prints ('used'); a free dish is a
-- free item (comps row) and is used as soon as it is given.
create table customer_rewards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  customer_id uuid not null references customers(id),
  program_id uuid references loyalty_programs(id),
  source text not null check (source in ('stamps', 'level', 'welcome', 'birthday', 'comeback')),
  label text not null,
  reward jsonb not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  status text not null default 'available' check (status in ('available', 'applied', 'used', 'cancelled')),
  bill_id uuid references bills(id),
  comp_id uuid references comps(id),
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customer_rewards_customer_idx on customer_rewards (customer_id, status, valid_to);
create index customer_rewards_bill_idx on customer_rewards (bill_id) where bill_id is not null;
select dineos_secure_table('customer_rewards');

-- Free dishes given as a loyalty reward.
alter table comps drop constraint comps_reason_check;
alter table comps add constraint comps_reason_check check (reason in ('mishap', 'special_guest', 'owners_guest', 'celebration', 'staff_meal', 'marketing', 'loyalty', 'other'));

-- Money off from rewards, beside points redeemed; both are in loyalty_discount_paise for the maths.
alter table bills add column reward_discount_paise integer not null default 0 check (reward_discount_paise >= 0);
