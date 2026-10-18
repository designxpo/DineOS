-- Delivery apps pay out in cycles, after taking commission, ad spend, discounts they funded,
-- refunds and tax. The owner records what the app says (gross, each deduction, net) and what
-- arrived in the bank; Mezmitra sets that beside what the outlet billed for those orders, shows the
-- gap, and keeps a dispute with the app until it is credited or let go.

create table channel_payouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  channel text not null check (channel in ('zomato', 'swiggy')),
  period_from date not null,
  period_to date not null check (period_to >= period_from),
  -- What the app's statement says.
  orders_claimed integer not null check (orders_claimed >= 0),
  gross_paise integer not null check (gross_paise >= 0),
  net_paise integer not null,
  -- The app's payout or bank reference, and the bank credit it arrived as, if it has.
  reference text check (length(reference) <= 80),
  bank_credit_id uuid references bank_credits(id),
  -- A shortfall taken up with the app: open until it is credited back or let go.
  dispute_status text check (dispute_status in ('open', 'recovered', 'written_off')),
  dispute_note text check (length(dispute_note) <= 1000),
  recovered_paise integer not null default 0 check (recovered_paise >= 0),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, channel, period_from, period_to)
);
create index channel_payouts_outlet_idx on channel_payouts (outlet_id, period_to desc);
select mezmitra_secure_table('channel_payouts');

create table channel_payout_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  payout_id uuid not null references channel_payouts(id) on delete cascade,
  kind text not null check (kind in ('commission', 'ads', 'discount_funded', 'refund', 'tax', 'penalty', 'other')),
  -- Taken off the payout (positive), or given back to the outlet (negative).
  amount_paise integer not null,
  note text check (length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index channel_payout_lines_idx on channel_payout_lines (payout_id);
select mezmitra_secure_table('channel_payout_lines');
