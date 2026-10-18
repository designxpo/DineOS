-- What became of a dish that was cancelled after the kitchen made it. All three used the
-- ingredients, but a remake points to a kitchen problem and a staff meal is a cost, not waste.

alter table order_items
  add column cancelled_disposition text check (cancelled_disposition in ('discarded', 'remake', 'staff_meal'));
alter table order_items add constraint order_items_disposition_check check (cancelled_disposition is null or cancelled_made is true);
