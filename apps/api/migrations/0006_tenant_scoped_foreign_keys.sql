-- Foreign-key checks ignore row-level security, so a plain FK would let tenant A store a row that
-- points at tenant B's outlet, table or order. Pair every FK between tenant tables with a
-- composite (column, tenant_id) FK so a cross-tenant reference is impossible at the database level.

do $$
declare
  r record;
begin
  -- Each tenant table needs (id, tenant_id) unique to be the target of a composite FK.
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
      and exists (
        select 1 from information_schema.columns i
        where i.table_schema = 'public' and i.table_name = c.table_name and i.column_name = 'id'
      )
  loop
    execute format('alter table %I add constraint %I unique (id, tenant_id)', r.table_name, left(r.table_name || '_id_tenant_key', 63));
  end loop;

  for r in
    select cl.relname as tbl, att.attname as col, rcl.relname as ref_tbl, con.confdeltype as on_delete
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_class rcl on rcl.oid = con.confrelid
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and array_length(con.conkey, 1) = 1
      and cl.relnamespace = 'public'::regnamespace
      and att.attname <> 'tenant_id'
      and exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = cl.relname and x.column_name = 'tenant_id')
      and exists (select 1 from information_schema.columns y where y.table_schema = 'public' and y.table_name = rcl.relname and y.column_name = 'tenant_id')
  loop
    execute format(
      'alter table %I add constraint %I foreign key (%I, tenant_id) references %I (id, tenant_id)%s',
      r.tbl,
      left(r.tbl || '_' || r.col || '_tenant_fk', 63),
      r.col,
      r.ref_tbl,
      case r.on_delete when 'c' then ' on delete cascade' else '' end
    );
  end loop;
end $$;
