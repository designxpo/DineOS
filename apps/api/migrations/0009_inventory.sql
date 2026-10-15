-- Phase 2: ingredients, recipes and stock movements. Accepted orders consume stock automatically.

create table ingredients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  name text not null,
  unit text not null check (unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  stock_qty numeric(14, 3) not null default 0,
  reorder_level numeric(14, 3) not null default 0 check (reorder_level >= 0),
  -- Moving-average cost of one unit, updated on each purchase.
  cost_per_unit_paise numeric(14, 4) not null default 0 check (cost_per_unit_paise >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ingredients_outlet_name_key on ingredients (outlet_id, lower(name)) where is_active;
select dineos_secure_table('ingredients');

create table recipes (
  tenant_id uuid not null references tenants(id),
  item_id uuid not null references menu_items(id),
  ingredient_id uuid not null references ingredients(id),
  qty numeric(14, 3) not null check (qty > 0),
  primary key (item_id, ingredient_id)
);
select dineos_secure_table('recipes');

create table modifier_recipes (
  tenant_id uuid not null references tenants(id),
  modifier_id uuid not null references modifiers(id),
  ingredient_id uuid not null references ingredients(id),
  qty numeric(14, 3) not null check (qty > 0),
  primary key (modifier_id, ingredient_id)
);
select dineos_secure_table('modifier_recipes');

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  ingredient_id uuid not null references ingredients(id),
  type text not null check (type in ('purchase', 'sale', 'return', 'wastage', 'adjust', 'count')),
  -- Signed change in stock, in the ingredient's unit.
  qty numeric(14, 3) not null,
  unit_cost_paise numeric(14, 4),
  stock_after numeric(14, 3),
  order_item_id uuid references order_items(id),
  supplier text,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stock_movements_ingredient_idx on stock_movements (ingredient_id, created_at desc);
create index stock_movements_outlet_idx on stock_movements (outlet_id, created_at desc);
select dineos_secure_table('stock_movements');

-- Each order item is consumed once and returned once at most.
alter table order_items add column stock_applied boolean not null default false;

-- Mark dishes sold out automatically when an ingredient runs out.
alter table outlets add column inventory_auto_stockout boolean not null default false;
