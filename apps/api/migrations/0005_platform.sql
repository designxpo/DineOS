-- Gap-free numbering for our own subscription invoices to tenants (not tenant data, no RLS).
create table platform_counters (
  name text not null,
  period text not null,
  value integer not null default 0,
  primary key (name, period)
);
grant select, insert, update on platform_counters to dineos_admin;

-- Platform-level audit trail for admin actions that are not about one tenant (plans, admins).
create table platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references platform_admins(id),
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);
grant select, insert on platform_audit_log to dineos_admin;
