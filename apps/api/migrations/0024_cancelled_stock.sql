-- Stock for cancelled dishes. Each dish keeps what it took from stock when the kitchen accepted it
-- (ingredient ids and quantities), so cancelling it reverses exactly that, not whatever the recipe
-- says today. And a dish cancelled after the kitchen made it is wasted, not put back on the shelf:
-- cancelled_made records which, from its status at the time or the person cancelling it.
alter table order_items add column stock_used jsonb;
alter table order_items add column cancelled_made boolean;
