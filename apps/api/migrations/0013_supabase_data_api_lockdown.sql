-- Hosting on Supabase: its Data API (PostgREST) runs as the roles anon and authenticated, and
-- Supabase grants those roles everything created in schema public by default. DineOS never uses
-- the Data API (its API connects as dineos_app / dineos_admin), and some tables are platform-wide
-- without row-level security (e.g. platform_admins), so take that access away entirely: the
-- publishable key must not be able to read or call anything here. No-op where those roles do
-- not exist (plain PostgreSQL).

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke usage on schema public from %I', r);
      -- Tables, sequences and functions added by later migrations stay closed too.
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
