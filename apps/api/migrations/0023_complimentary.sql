-- Free food and drinks: a dish (or a whole bill) given on the house to make a mishap right, for a
-- special or owner's guest, a celebration, a staff meal or marketing. Each one is kept with why,
-- for whom, who gave it, who approved it, its menu value and its ingredient cost, so the owner
-- sees what was given away. Undoing one before the bill prints keeps the row (removed_at).
create table comps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  order_item_id uuid not null references order_items(id),
  qty integer not null check (qty between 1 and 99),
  value_paise integer not null check (value_paise >= 0),
  cost_paise integer check (cost_paise >= 0),
  reason text not null check (reason in ('mishap', 'special_guest', 'owners_guest', 'celebration', 'staff_meal', 'marketing', 'other')),
  note text check (char_length(note) <= 300),
  whole_bill boolean not null default false,
  customer_id uuid references customers(id),
  given_by uuid not null references users(id),
  approved_by uuid references users(id),
  removed_at timestamptz,
  removed_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index comps_outlet_idx on comps (outlet_id, created_at);
create index comps_item_idx on comps (order_item_id) where removed_at is null;
create index comps_customer_idx on comps (customer_id) where customer_id is not null;
select dineos_secure_table('comps');

-- Bill lines show the free part apart from discounts (it is part of the item discount, so the
-- tax and totals stay as they were).
alter table bill_lines add column comp_qty integer not null default 0;
alter table bill_lines add column comp_paise integer not null default 0;

-- The owner's phone hears about free items worth this much or more (null: never).
alter table outlets add column comp_alert_paise integer default 100000 check (comp_alert_paise >= 0);

-- Tenant-safe pairs for the links added in 0021 (water item, water order).
select dineos_add_tenant_fks('table_sessions');
select dineos_add_tenant_fks('outlets');
