-- Paid memberships and a prepaid wallet.
--
-- A membership is sold on its own GST invoice: a bill with one line for the plan and no orders.
-- It starts when that bill is paid (after any membership of the same plan still running) and is
-- cancelled if the bill is voided or discarded. While it runs the guest gets its benefits: money
-- off eligible dishes, a free item each day, and faster points.
create table membership_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 1 and 60),
  template text,
  price_paise integer not null check (price_paise > 0),
  duration_days integer not null check (duration_days between 1 and 1095),
  tax_rate_bp integer not null check (tax_rate_bp between 0 and 2800),
  hsn_sac text,
  benefits jsonb not null,
  is_active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select dineos_secure_table('membership_plans');

create table customer_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  customer_id uuid not null references customers(id),
  plan_id uuid not null references membership_plans(id),
  -- The plan as sold: later edits to the plan do not change what this guest bought.
  plan_snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'cancelled')),
  starts_at timestamptz,
  ends_at timestamptz,
  sold_by uuid references users(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'active' or (starts_at is not null and ends_at is not null))
);
create index customer_memberships_customer_idx on customer_memberships (customer_id, status, ends_at);
select dineos_secure_table('customer_memberships');

alter table bills add column membership_id uuid references customer_memberships(id);
select dineos_add_tenant_fks('bills');
create unique index bills_membership_key on bills (membership_id) where membership_id is not null;
do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'bills'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%table_session_id IS NOT NULL%order_id IS NOT NULL%';
  execute format('alter table bills drop constraint %I', c);
end $$;
alter table bills add constraint bills_scope_check check (table_session_id is not null or order_id is not null or membership_id is not null);
alter table bills add column member_discount_paise integer not null default 0 check (member_discount_paise >= 0);

-- A membership's free item of the day waits as a reward like any other.
alter table customer_rewards add column membership_id uuid references customer_memberships(id);
select dineos_add_tenant_fks('customer_rewards');
alter table customer_rewards drop constraint customer_rewards_source_check;
alter table customer_rewards add constraint customer_rewards_source_check check (source in ('stamps', 'level', 'welcome', 'birthday', 'comeback', 'membership'));

-- The wallet: money a guest paid in advance (plus any bonus) to spend on bills at any outlet.
-- A top-up is not a sale: it gets a receipt, not a GST invoice; bills paid from the wallet are
-- taxed in full as usual. Paid and bonus balances are kept apart so a refund returns only what
-- the guest paid, and the owner sees both.
create table wallet_packs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 1 and 60),
  pay_paise integer not null check (pay_paise > 0),
  bonus_paise integer not null default 0 check (bonus_paise >= 0),
  validity_days integer not null check (validity_days between 30 and 1095),
  is_active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select dineos_secure_table('wallet_packs');

alter table customers
  add column wallet_paid_paise integer not null default 0 check (wallet_paid_paise >= 0),
  add column wallet_bonus_paise integer not null default 0 check (wallet_bonus_paise >= 0),
  add column wallet_expires_at timestamptz;

create table wallet_topups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  customer_id uuid not null references customers(id),
  pack_id uuid references wallet_packs(id),
  receipt_no text not null,
  paid_paise integer not null check (paid_paise > 0),
  bonus_paise integer not null default 0 check (bonus_paise >= 0),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index wallet_topups_receipt_key on wallet_topups (outlet_id, receipt_no);
select dineos_secure_table('wallet_topups');

create table wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid references outlets(id),
  customer_id uuid not null references customers(id),
  kind text not null check (kind in ('topup', 'spend', 'refund', 'cash_out', 'expire')),
  paid_paise integer not null,
  bonus_paise integer not null,
  bill_id uuid references bills(id),
  payment_id uuid references payments(id),
  topup_id uuid references wallet_topups(id),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index wallet_ledger_customer_idx on wallet_ledger (customer_id, created_at desc);
select dineos_secure_table('wallet_ledger');

-- Top-up money is a payment too, so day-end cash and the UPI check see it: tied to its top-up
-- instead of a bill. Paying a bill from the wallet is the 'wallet' method.
alter table payments alter column bill_id drop not null;
alter table payments add column wallet_topup_id uuid references wallet_topups(id);
select dineos_add_tenant_fks('payments');
alter table payments add constraint payments_for_check check ((bill_id is null) <> (wallet_topup_id is null));
create index payments_topup_idx on payments (wallet_topup_id) where wallet_topup_id is not null;
alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check check (method in ('cash', 'upi', 'card_slip', 'other', 'room', 'platform', 'wallet'));

-- Codes staff text to a guest at the counter to spend their wallet: no table visit behind them.
alter table otp_codes alter column table_session_id drop not null;
alter table otp_codes add column customer_id uuid references customers(id);
alter table otp_codes add column purpose text not null default 'loyalty' check (purpose in ('loyalty', 'wallet'));
select dineos_add_tenant_fks('otp_codes');
