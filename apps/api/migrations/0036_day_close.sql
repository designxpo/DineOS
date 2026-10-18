-- The owner's day-end sign-off: at close, one screen lists every open item (unpaid bills, drafts,
-- food never billed, UPI the bank has not confirmed, free dishes, large discounts, voids, refunds,
-- stock differences), each with a way to act on it, and the owner or manager signs the day off.
-- The sign-off keeps the list as it stood, the cash expected and the cash counted.

create table day_closes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  business_date date not null,
  signed_by uuid not null references users(id),
  signed_at timestamptz not null default now(),
  -- Why the day was closed with items still open, or anything else worth keeping.
  note text check (length(note) <= 1000),
  expected_cash_paise integer not null,
  counted_cash_paise integer check (counted_cash_paise >= 0),
  net_sales_paise integer not null,
  -- The open items as they stood when signed.
  items jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, business_date)
);
select mezmitra_secure_table('day_closes');
