-- Help from inside the portal. Staff raise a case from any screen: how bad it is, what happened, and
-- (with consent) a technical report without guest details. DineOS support picks it up, replies and
-- moves it on; the outlet sees who owns it and where it stands, says when service is running
-- again, and closes it only when it works. The measure is time to resume service.
create sequence support_case_no start 1001;
grant usage, select on sequence support_case_no to dineos_app, dineos_admin;

create table support_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  number integer not null default nextval('support_case_no') unique,
  severity text not null check (severity in ('stopped', 'degraded', 'question')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting_on_outlet', 'resolved', 'closed')),
  summary text not null check (length(summary) between 3 and 140),
  diagnostics jsonb,
  raised_by uuid references users(id),
  assignee_admin_id uuid references platform_admins(id),
  first_response_at timestamptz,
  resumed_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  reopened integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index support_cases_outlet_idx on support_cases (outlet_id, created_at desc);
create index support_cases_queue_idx on support_cases (status, severity, created_at);
select dineos_secure_table('support_cases');

create table support_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  case_id uuid not null references support_cases(id) on delete cascade,
  author text not null check (author in ('outlet', 'support', 'system')),
  user_id uuid references users(id),
  admin_id uuid references platform_admins(id),
  body text not null check (length(body) between 1 and 4000),
  -- The clock, not the transaction start: a thread written in one go keeps its order.
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now()
);
create index support_messages_case_idx on support_messages (case_id, created_at);
select dineos_secure_table('support_messages');

-- Outlets see who from DineOS support owns their case. The app role may read only an admin's id
-- and name, never their email or password hash.
grant select (id, name) on platform_admins to dineos_app;
drop policy if exists admin_names_read on platform_admins;
create policy admin_names_read on platform_admins for select to dineos_app using (true);
