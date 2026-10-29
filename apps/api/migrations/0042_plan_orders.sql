-- Restaurants upgrade their own plan and pay online with Razorpay (spec §15: the payment gateway
-- is now accepted as a dependency, for our own subscription billing only). One row per attempt.
-- The plan changes only after Razorpay confirms the payment, checked on our server.

create table plan_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  from_plan_code text not null references plans(code),
  plan_code text not null references plans(code),
  -- Fixed when the order is made, so a price change meanwhile cannot change what is charged.
  amount_paise integer not null check (amount_paise >= 100),
  credit_paise integer not null default 0 check (credit_paise >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  status text not null default 'created' check (status in ('created', 'paid', 'failed')),
  razorpay_order_id text unique,
  razorpay_payment_id text unique,
  invoice_id uuid references platform_invoices(id),
  last_error text check (length(last_error) <= 500),
  created_by uuid references users(id),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plan_orders_tenant_idx on plan_orders (tenant_id, created_at desc);
select mezmitra_secure_table('plan_orders');

-- The old period of a plan replaced by an upgrade.
alter table subscriptions drop constraint subscriptions_status_check;
alter table subscriptions add constraint subscriptions_status_check check (status in ('active', 'past_due', 'cancelled', 'replaced'));
