-- Draft bills are recomputed from orders; these columns hold the inputs that survive a recompute.
alter table bills
  -- Split bills own a fixed set of order items; null means "every unbilled item in scope".
  add column item_scope jsonb,
  -- { "<order_item_id>": paise } per-line discounts.
  add column item_discounts jsonb not null default '{}',
  add column service_charge_tax_rate_bp integer not null default 500;

comment on column bills.amount_shares is '{"count": n} or {"amounts": [paise, ...]} when split by amount';
