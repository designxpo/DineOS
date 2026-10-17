-- Knowing what happens at tables without cameras, and counter-service cafés.

-- Guests scanning the table QR is the first sign they sat down: the floor shows the table as taken
-- from then on. guests_since: when this group's first phone scanned; guest_seen_at: their latest
-- scan or cart change (a scan with no activity for a while no longer counts as people there).
alter table table_sessions add column guests_since timestamptz;
alter table table_sessions add column guest_seen_at timestamptz;

-- Bottled water left on the table is billed only if opened: the count staff gave for this visit
-- (null until asked), and the served order that carries it onto the bill.
alter table table_sessions add column water_bottles integer check (water_bottles between 0 and 50);
alter table table_sessions add column water_order_id uuid references orders(id);

-- A guest's scan is a new reason for a table's state to change.
alter table table_state_events drop constraint table_state_events_source_check;
alter table table_state_events add constraint table_state_events_source_check check (source in ('order', 'camera', 'staff', 'guest'));

-- How long a table has been waiting to be cleaned. A trigger keeps it, so every path that sets or
-- clears the flag (guests paying, staff, the camera, the outlet hub) counts.
alter table tables add column needs_cleaning_since timestamptz;
update tables set needs_cleaning_since = now() where needs_cleaning;
create function dineos_needs_cleaning_since() returns trigger language plpgsql as $$
begin
  if new.needs_cleaning and (tg_op = 'INSERT' or not old.needs_cleaning) then
    new.needs_cleaning_since := now();
  elsif not new.needs_cleaning then
    new.needs_cleaning_since := null;
  end if;
  return new;
end $$;
create trigger tables_needs_cleaning_since before insert or update of needs_cleaning on tables
  for each row execute function dineos_needs_cleaning_since();

-- Outlet settings: a table counts as clean this many minutes after its guests leave (0: staff
-- mark it), the menu item billed for each opened water bottle (null: no water check), and the
-- version of the pickup screen link (a new link retires the old one).
alter table outlets add column auto_clean_minutes integer not null default 10 check (auto_clean_minutes between 0 and 240);
alter table outlets add column table_water_item_id uuid references menu_items(id);
alter table outlets add column pickup_link_version integer not null default 1 check (pickup_link_version between 1 and 65535);

-- Counter and takeaway orders: the code in the link on the receipt that lets the guest follow the
-- order on their phone. 128 random bits; the lookup below only tells which tenant owns it.
alter table orders add column track_code text unique
  default translate(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_');

create function dineos_track_order(p_code text) returns table (tenant_id uuid, order_id uuid)
language sql stable security definer set search_path = public as $$
  select o.tenant_id, o.id from orders o where o.track_code = p_code
$$;
revoke execute on function dineos_track_order(text) from public;
grant execute on function dineos_track_order(text) to dineos_app, dineos_admin;
