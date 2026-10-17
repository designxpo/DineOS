-- The product is now Mezmitra: the database's helper functions take its name. New migrations call
-- mezmitra_secure_table. The login roles (dineos_app, dineos_admin) keep their names: they are in
-- every connection string, so they change only together with the connection settings.

-- Used by migrations only. Renaming keeps each function's grants; the table helper calls the other
-- by name, so it is redefined to follow it.
alter function dineos_add_tenant_fks(text) rename to mezmitra_add_tenant_fks;
alter function dineos_secure_table(text) rename to mezmitra_secure_table;
create or replace function mezmitra_secure_table(p_table text) returns void
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
  perform mezmitra_add_tenant_fks(p_table);
end $$;
alter function dineos_needs_cleaning_since() rename to mezmitra_needs_cleaning_since;

-- Order tracking, called by the API. The release running while this migration is applied still
-- asks for the old name for a few minutes, so that name keeps working until a later release drops it.
alter function dineos_track_order(text) rename to mezmitra_track_order;
create function dineos_track_order(p_code text) returns table (tenant_id uuid, order_id uuid)
language sql stable security definer set search_path = public as $$ select * from mezmitra_track_order(p_code) $$;
revoke execute on function dineos_track_order(text) from public;
grant execute on function dineos_track_order(text) to dineos_app, dineos_admin;
