-- DineOS Phase 1 schema.
-- Tenant isolation: every business table carries tenant_id and a row-level security policy keyed on
-- the per-transaction setting app.tenant_id. The API connects as dineos_app, which cannot bypass RLS.
-- Platform administration connects as dineos_admin (BYPASSRLS). Roles are created by `npm run db:setup`.

create or replace function app_tenant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ===================================================================== platform

create table plans (
  code text primary key,
  name text not null,
  price_paise integer not null default 0 check (price_paise >= 0),
  billing_period text not null default 'monthly' check (billing_period in ('monthly', 'yearly')),
  features jsonb not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$'),
  plan_code text not null references plans(code),
  status text not null default 'active' check (status in ('active', 'suspended', 'cancelled')),
  branding jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  plan_code text not null references plans(code),
  period_start date not null,
  period_end date not null,
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create table platform_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscription_id uuid references subscriptions(id),
  number text not null unique,
  amount_paise integer not null check (amount_paise >= 0),
  period_start date not null,
  period_end date not null,
  status text not null default 'unpaid' check (status in ('unpaid', 'paid', 'void')),
  due_date date,
  paid_reference text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table platform_admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  password_hash text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index platform_admins_email_key on platform_admins (lower(email));

create table admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references platform_admins(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ===================================================================== people

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  phone text,
  email text,
  password_hash text not null,
  pin_hash text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (phone is not null or email is not null)
);
create unique index users_tenant_email_key on users (tenant_id, lower(email)) where email is not null;
create unique index users_tenant_phone_key on users (tenant_id, phone) where phone is not null;

create table outlets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  legal_name text,
  address text,
  city text,
  state_code text check (state_code ~ '^[0-9]{2}$'),
  phone text,
  gstin text check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  fssai_no text,
  invoice_prefix text not null default 'INV' check (invoice_prefix ~ '^[A-Z0-9]{1,4}$'),
  timezone text not null default 'Asia/Kolkata',
  auto_accept boolean not null default false,
  approve_flagged_orders boolean not null default true,
  service_charge_bp integer not null default 0 check (service_charge_bp between 0 and 2500),
  service_charge_tax_rate_bp integer not null default 500 check (service_charge_tax_rate_bp between 0 and 2800),
  default_tax_rate_bp integer not null default 500 check (default_tax_rate_bp between 0 and 2800),
  prices_include_tax boolean not null default false,
  kitchen_stations text[] not null default '{kitchen}',
  upi_vpa text,
  upi_payee_name text,
  menu_version integer not null default 1,
  event_seq integer not null default 0,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outlets_tenant_idx on outlets (tenant_id);

create table user_outlet_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  -- null outlet means the role applies to every outlet of the tenant (owners)
  outlet_id uuid references outlets(id),
  role text not null check (role in ('owner', 'manager', 'cashier', 'waiter', 'kitchen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index user_outlet_roles_key on user_outlet_roles (user_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid), role);

create table user_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  impersonated_by uuid references platform_admins(id),
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One-time tokens a manager issues by entering their PIN, used for voids, refunds and overrides.
create table approval_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  approver_id uuid not null references users(id),
  requested_by uuid not null references users(id),
  action text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid references outlets(id),
  actor_user_id uuid references users(id),
  actor_admin_id uuid references platform_admins(id),
  approved_by uuid references users(id),
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audit_log_tenant_created_idx on audit_log (tenant_id, created_at desc);

-- ===================================================================== menu

create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  name text not null,
  sort integer not null default 0,
  available_schedule jsonb,
  is_active boolean not null default true,
  translations jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menu_categories_outlet_idx on menu_categories (outlet_id) where deleted_at is null;

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  category_id uuid not null references menu_categories(id),
  name text not null,
  description text,
  photo_url text,
  price_paise integer not null check (price_paise >= 0),
  is_veg boolean not null default true,
  hsn_sac text,
  tax_rate_bp integer not null default 500 check (tax_rate_bp between 0 and 2800),
  tags text[] not null default '{}',
  in_stock boolean not null default true,
  station text not null default 'kitchen',
  sort integer not null default 0,
  translations jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menu_items_outlet_idx on menu_items (outlet_id) where deleted_at is null;

create table modifier_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  name text not null,
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select >= 1),
  sort integer not null default 0,
  translations jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (max_select >= min_select)
);

create table modifiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  group_id uuid not null references modifier_groups(id),
  name text not null,
  price_delta_paise integer not null default 0,
  is_veg boolean not null default true,
  in_stock boolean not null default true,
  sort integer not null default 0,
  translations jsonb not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table item_modifier_groups (
  tenant_id uuid not null references tenants(id),
  item_id uuid not null references menu_items(id),
  group_id uuid not null references modifier_groups(id),
  sort integer not null default 0,
  primary key (item_id, group_id)
);

-- ===================================================================== tables and sessions

create table tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  label text not null,
  seats integer not null default 4 check (seats between 1 and 50),
  zone text,
  sort integer not null default 0,
  qr_token_version integer not null default 1,
  assigned_waiter_id uuid references users(id),
  -- Points at the pending or open session this table belongs to. Merged tables share one session.
  current_session_id uuid,
  state text not null default 'vacant'
    check (state in ('vacant', 'occupied', 'ordered', 'served', 'bill_requested', 'needs_cleaning')),
  needs_cleaning boolean not null default false,
  camera_zone_polygon jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tables_outlet_label_key on tables (outlet_id, lower(label)) where is_active;

create table table_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  table_id uuid not null references tables(id),
  -- pending: guests have a cart but nothing is ordered yet; the table still shows vacant.
  status text not null default 'pending' check (status in ('pending', 'open', 'closed')),
  opened_at timestamptz,
  closed_at timestamptz,
  guest_count integer,
  waiter_id uuid references users(id),
  bill_requested_at timestamptz,
  cart jsonb not null default '[]',
  cart_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index table_sessions_table_idx on table_sessions (table_id, created_at desc);

alter table tables
  add constraint tables_current_session_fk foreign key (current_session_id) references table_sessions(id);

create table table_state_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  table_id uuid not null references tables(id),
  source text not null check (source in ('order', 'camera', 'staff')),
  state text not null,
  confidence real,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index table_state_events_table_idx on table_state_events (table_id, at desc);

create table service_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  table_id uuid not null references tables(id),
  table_session_id uuid references table_sessions(id),
  kind text not null check (kind in ('call_waiter', 'bill')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'closed')),
  acknowledged_by uuid references users(id),
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index service_requests_open_idx on service_requests (outlet_id) where status <> 'closed';

-- ===================================================================== orders

create table orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  table_session_id uuid references table_sessions(id),
  table_id uuid references tables(id),
  order_no integer not null,
  business_date date not null,
  type text not null check (type in ('dine_in', 'takeaway', 'counter')),
  status text not null default 'placed'
    check (status in ('placed', 'accepted', 'preparing', 'ready', 'served', 'billed', 'rejected', 'cancelled')),
  source text not null check (source in ('guest_qr', 'waiter', 'pos')),
  note text,
  flagged boolean not null default false,
  flag_reason text,
  device_id text,
  customer_name text,
  customer_phone text,
  created_by uuid references users(id),
  placed_at timestamptz not null default now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  rejected_reason text,
  cancelled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (type <> 'dine_in' or table_session_id is not null)
);
create index orders_outlet_status_idx on orders (outlet_id, status, placed_at desc);
create index orders_session_idx on orders (table_session_id);
create index orders_outlet_date_idx on orders (outlet_id, business_date);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  order_id uuid not null references orders(id),
  item_id uuid not null references menu_items(id),
  name_snapshot text not null,
  price_snapshot_paise integer not null,
  unit_price_paise integer not null,
  modifiers_snapshot jsonb not null default '[]',
  is_veg boolean not null default true,
  tax_rate_bp integer not null,
  hsn_sac text,
  qty integer not null check (qty between 1 and 99),
  note text,
  status text not null default 'placed'
    check (status in ('placed', 'accepted', 'preparing', 'ready', 'served', 'cancelled')),
  station text not null,
  seat_no integer,
  cancelled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_items_order_idx on order_items (order_id);

create table kots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  order_id uuid not null references orders(id),
  kot_no integer not null,
  station text not null,
  items jsonb not null,
  is_reprint boolean not null default false,
  printed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kots_order_idx on kots (order_id);

-- ===================================================================== billing

create table bills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  table_session_id uuid references table_sessions(id),
  order_id uuid references orders(id),
  parent_bill_id uuid references bills(id),
  split_label text,
  status text not null default 'draft' check (status in ('draft', 'finalised', 'paid', 'void')),
  bill_discount jsonb,
  discount_reason text,
  service_charge_bp integer not null default 0,
  service_charge_waived boolean not null default false,
  subtotal_paise integer not null default 0,
  item_discount_paise integer not null default 0,
  bill_discount_paise integer not null default 0,
  service_charge_paise integer not null default 0,
  taxable_paise integer not null default 0,
  cgst_paise integer not null default 0,
  sgst_paise integer not null default 0,
  tax_total_paise integer not null default 0,
  round_off_paise integer not null default 0,
  total_paise integer not null default 0,
  paid_paise integer not null default 0,
  amount_shares jsonb,
  fy_code text,
  invoice_seq integer,
  invoice_no text,
  invoice_date date,
  outlet_snapshot jsonb,
  customer_name text,
  customer_gstin text,
  finalised_at timestamptz,
  finalised_by uuid references users(id),
  paid_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references users(id),
  void_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (table_session_id is not null or order_id is not null),
  check (status = 'draft' or status = 'void' or invoice_no is not null)
);
create unique index bills_invoice_seq_key on bills (outlet_id, fy_code, invoice_seq) where invoice_seq is not null;
create index bills_session_idx on bills (table_session_id);
create index bills_outlet_date_idx on bills (outlet_id, invoice_date);

create table bill_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  bill_id uuid not null references bills(id) on delete cascade,
  order_item_id uuid references order_items(id),
  name text not null,
  qty integer not null,
  unit_price_paise integer not null,
  gross_paise integer not null,
  item_discount_paise integer not null default 0,
  bill_discount_paise integer not null default 0,
  taxable_paise integer not null,
  tax_rate_bp integer not null,
  cgst_paise integer not null,
  sgst_paise integer not null,
  amount_paise integer not null,
  hsn_sac text,
  seat_no integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bill_lines_bill_idx on bill_lines (bill_id);
create index bill_lines_order_item_idx on bill_lines (order_item_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  bill_id uuid not null references bills(id),
  kind text not null default 'payment' check (kind in ('payment', 'refund')),
  method text not null check (method in ('cash', 'upi', 'card_slip', 'other')),
  amount_paise integer not null check (amount_paise > 0),
  tendered_paise integer,
  change_paise integer,
  reference text,
  confirmed_by uuid references users(id),
  approved_by uuid references users(id),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_bill_idx on payments (bill_id);
create index payments_outlet_created_idx on payments (outlet_id, created_at);

-- ===================================================================== infrastructure

-- Gap-free counters: order numbers per day, KOT numbers per day, invoice numbers per financial year.
-- Incremented inside the caller's transaction, so a rollback returns the number.
create table counters (
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  name text not null,
  period text not null,
  value integer not null default 0,
  primary key (outlet_id, name, period)
);

create table outlet_events (
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  seq integer not null,
  type text not null,
  channels text[] not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (outlet_id, seq)
);
create index outlet_events_created_idx on outlet_events (created_at);

create table idempotency_keys (
  tenant_id uuid not null references tenants(id),
  key text not null,
  actor text not null,
  method text not null,
  path text not null,
  request_hash text not null,
  status_code integer,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor, key)
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  kind text not null check (kind in ('print_agent', 'vision')),
  name text not null,
  token_hash text not null unique,
  -- print agents: { "printers": { "kitchen": "192.168.1.50:9100", "bill": "192.168.1.51:9100" } }
  config jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table print_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  kind text not null check (kind in ('kot', 'bill', 'test')),
  -- station name for KOTs, 'bill' for bills
  target text not null,
  ref_id uuid,
  doc jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'printed', 'failed')),
  attempts integer not null default 0,
  device_id uuid references devices(id),
  last_error text,
  sent_at timestamptz,
  printed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index print_jobs_pending_idx on print_jobs (outlet_id, created_at) where status in ('queued', 'sent');

-- ===================================================================== triggers

do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_at'
  loop
    execute format('create trigger %I_updated_at before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ===================================================================== row-level security

do $$
declare t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and tb.table_type = 'BASE TABLE'
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())',
      t);
  end loop;
end $$;

alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_isolation on tenants using (id = app_tenant_id()) with check (id = app_tenant_id());

-- ===================================================================== pre-tenant lookups
-- These run before a tenant is known (login, token checks). They are SECURITY DEFINER so they can
-- read across tenants, and each returns only the minimum needed to establish the tenant context.

create or replace function auth_tenant_by_slug(p_slug text)
returns table (id uuid, name text, status text)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, t.status from tenants t where t.slug = lower(p_slug)
$$;

create or replace function auth_user_session(p_token_hash text)
returns table (session_id uuid, user_id uuid, tenant_id uuid, expires_at timestamptz, impersonated_by uuid, tenant_status text, user_status text)
language sql stable security definer set search_path = public as $$
  select s.id, s.user_id, s.tenant_id, s.expires_at, s.impersonated_by, t.status, u.status
  from user_sessions s
  join tenants t on t.id = s.tenant_id
  join users u on u.id = s.user_id
  where s.token_hash = p_token_hash
$$;

create or replace function auth_device(p_token_hash text)
returns table (device_id uuid, tenant_id uuid, outlet_id uuid, kind text, status text, tenant_status text)
language sql stable security definer set search_path = public as $$
  select d.id, d.tenant_id, d.outlet_id, d.kind, d.status, t.status
  from devices d join tenants t on t.id = d.tenant_id
  where d.token_hash = p_token_hash
$$;

create or replace function auth_tenant_status(p_tenant_id uuid)
returns text
language sql stable security definer set search_path = public as $$
  select status from tenants where id = p_tenant_id
$$;

-- ===================================================================== grants

grant usage on schema public to dineos_app, dineos_admin;

do $$
declare t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and tb.table_type = 'BASE TABLE'
      and c.table_name not in ('subscriptions', 'platform_invoices')
  loop
    execute format('grant select, insert, update, delete on %I to dineos_app', t);
  end loop;
end $$;

grant select on plans, tenants, subscriptions, platform_invoices to dineos_app;
grant update (name, branding) on tenants to dineos_app;
revoke all on platform_admins, admin_sessions from dineos_app;

grant select, insert, update, delete on all tables in schema public to dineos_admin;

revoke execute on function auth_tenant_by_slug(text), auth_user_session(text), auth_device(text), auth_tenant_status(uuid) from public;
grant execute on function auth_tenant_by_slug(text), auth_user_session(text), auth_device(text), auth_tenant_status(uuid) to dineos_app, dineos_admin;
grant execute on function app_tenant_id() to dineos_app, dineos_admin;
