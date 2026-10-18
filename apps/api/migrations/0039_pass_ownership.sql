-- Food waiting at the pass has an owner. When an item turns ready the clock starts; a waiter takes
-- it (or the manager sees it going cold). Serving it ends it: the pass list is just the ready items.

alter table order_items
  add column ready_at timestamptz,
  add column claimed_by uuid references users(id),
  add column claimed_at timestamptz;

update order_items set ready_at = updated_at where status = 'ready';

-- Every writer that marks an item ready (kitchen, order status, hub sync) gets the clock for free,
-- and a dish that goes back to the kitchen and comes out again starts with nobody holding it.
create function order_items_ready_clock() returns trigger language plpgsql as $$
begin
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    new.ready_at := now();
    new.claimed_by := null;
    new.claimed_at := null;
  end if;
  return new;
end $$;
create trigger order_items_ready_clock before insert or update of status on order_items for each row execute function order_items_ready_clock();

create index order_items_ready_idx on order_items (order_id) where status = 'ready';
