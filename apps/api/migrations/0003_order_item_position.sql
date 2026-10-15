-- Items inserted in one statement share created_at; keep the order the guest or waiter entered them.
alter table order_items add column position integer not null default 0;
create index order_items_order_position_idx on order_items (order_id, position);
