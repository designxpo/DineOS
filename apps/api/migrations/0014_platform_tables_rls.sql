-- Supabase switches row-level security on for every new table in schema public (its
-- rls_auto_enable event trigger), including platform tables that never had it. Make every
-- environment behave the same: RLS on everywhere, so local tests see what Supabase does.
--
-- Platform tables are used by dineos_admin (BYPASSRLS) and the owner. The one exception is the
-- plan catalogue, which the app role reads (outlet limits, the subscription page), so it gets a
-- read policy. Everything else stays closed to non-bypass roles.

alter table plans enable row level security;
alter table platform_admins enable row level security;
alter table admin_sessions enable row level security;
alter table platform_audit_log enable row level security;
alter table platform_counters enable row level security;
alter table schema_migrations enable row level security;

drop policy if exists plans_read on plans;
create policy plans_read on plans for select to dineos_app using (true);

-- Functions are executable by PUBLIC by default; on Supabase that includes the Data API roles.
-- Give each helper only to the roles that use it.
grant execute on function set_updated_at() to dineos_app, dineos_admin;
revoke execute on function app_tenant_id(), set_updated_at(), dineos_secure_table(text), dineos_add_tenant_fks(text) from public;
alter default privileges in schema public revoke execute on functions from public;
