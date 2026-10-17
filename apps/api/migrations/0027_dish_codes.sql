-- Short codes staff type to find a dish fast ("PT", "CC2"), set by the outlet. Unique within an
-- outlet's live menu, whatever the case.
alter table menu_items add column short_code text check (short_code ~ '^[A-Za-z0-9]{1,8}$');
create unique index menu_items_short_code_key on menu_items (outlet_id, lower(short_code)) where short_code is not null and deleted_at is null;
