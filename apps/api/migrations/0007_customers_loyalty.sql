-- Phase 2: customer book and loyalty. Phone numbers are stored only with consent (spec §12).

-- Reusable: give a new tenant table everything 0001/0006 gave the original ones.
create or replace function dineos_secure_table(p_table text) returns void
language plpgsql as $$
declare r record;
begin
  execute format('alter table %I enable row level security', p_table);
  execute format('alter table %I force row level security', p_table);
  execute format('drop policy if exists tenant_isolation on %I', p_table);
  execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', p_table);
  execute format('grant select, insert, update, delete on %I to dineos_app, dineos_admin', p_table);
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = 'id')
     and not exists (select 1 from pg_constraint where conname = left(p_table || '_id_tenant_key', 63)) then
    execute format('alter table %I add constraint %I unique (id, tenant_id)', p_table, left(p_table || '_id_tenant_key', 63));
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = 'updated_at')
     and not exists (select 1 from pg_trigger where tgname = p_table || '_updated_at') then
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', p_table || '_updated_at', p_table);
  end if;
  perform dineos_add_tenant_fks(p_table);
end $$;

-- Pairs each single-column FK between tenant tables with a (column, tenant_id) FK. Idempotent.
create or replace function dineos_add_tenant_fks(p_table text) returns void
language plpgsql as $$
declare r record;
begin
  for r in
    select att.attname as col, rcl.relname as ref_tbl, con.confdeltype as on_delete
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_class rcl on rcl.oid = con.confrelid
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f' and array_length(con.conkey, 1) = 1 and cl.relname = p_table
      and cl.relnamespace = 'public'::regnamespace and att.attname <> 'tenant_id'
      and exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = p_table and x.column_name = 'tenant_id')
      and exists (select 1 from information_schema.columns y where y.table_schema = 'public' and y.table_name = rcl.relname and y.column_name = 'tenant_id')
  loop
    if not exists (select 1 from pg_constraint where conname = left(p_table || '_' || r.col || '_tenant_fk', 63)) then
      execute format(
        'alter table %I add constraint %I foreign key (%I, tenant_id) references %I (id, tenant_id)%s',
        p_table, left(p_table || '_' || r.col || '_tenant_fk', 63), r.col, r.ref_tbl,
        case r.on_delete when 'c' then ' on delete cascade' else '' end);
    end if;
  end loop;
end $$;

create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  phone text not null,
  name text,
  email text,
  birthday date,
  notes text,
  -- No consent, no record: the API refuses to create a customer without it.
  consent_at timestamptz not null,
  consent_source text not null check (consent_source in ('staff', 'guest')),
  marketing_opt_in boolean not null default false,
  visits integer not null default 0,
  total_spend_paise integer not null default 0,
  points integer not null default 0 check (points >= 0),
  last_visit_at timestamptz,
  erased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customers_tenant_phone_key on customers (tenant_id, phone) where erased_at is null;
create index customers_tenant_name_idx on customers (tenant_id, lower(name));
select dineos_secure_table('customers');

create table loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  customer_id uuid not null references customers(id),
  outlet_id uuid references outlets(id),
  bill_id uuid references bills(id),
  kind text not null check (kind in ('earn', 'redeem', 'reverse', 'adjust')),
  points integer not null,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index loyalty_ledger_customer_idx on loyalty_ledger (customer_id, created_at desc);
select dineos_secure_table('loyalty_ledger');

alter table bills
  add column customer_id uuid references customers(id),
  add column loyalty_points_redeemed integer not null default 0 check (loyalty_points_redeemed >= 0),
  add column loyalty_discount_paise integer not null default 0,
  add column loyalty_points_earned integer not null default 0;
alter table table_sessions add column customer_id uuid references customers(id);
alter table orders add column customer_id uuid references customers(id);
select dineos_add_tenant_fks('bills');
select dineos_add_tenant_fks('table_sessions');
select dineos_add_tenant_fks('orders');

alter table outlets
  add column loyalty_enabled boolean not null default false,
  -- Share of each paid bill returned as points (500 = 5%).
  add column loyalty_earn_bp integer not null default 500 check (loyalty_earn_bp between 0 and 5000),
  -- What one point is worth when redeemed.
  add column loyalty_point_value_paise integer not null default 100 check (loyalty_point_value_paise > 0),
  add column loyalty_min_redeem_points integer not null default 100 check (loyalty_min_redeem_points >= 0);
