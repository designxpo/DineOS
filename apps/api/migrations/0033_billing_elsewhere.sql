-- Outlets that already bill on another system (often paid a year ahead) use Mezmitra beside it
-- first: the money check. They upload that system's sales export and their bank statement, and
-- every UPI payment the bills say was taken is checked against the bank, as for Mezmitra's own
-- bills. Billing moves to Mezmitra when their year ends; until then nothing is billed here twice.

-- The billing system the outlet uses instead of Mezmitra (e.g. Petpooja). Null: it bills here.
-- While set, no orders or bills are made in Mezmitra for the outlet and the QR menu is for reading.
alter table outlets add column billing_elsewhere text check (length(billing_elsewhere) between 1 and 40);

-- One uploaded sales export.
create table sales_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  file_name text not null,
  -- The outlet's billing system when it was uploaded.
  system text not null,
  period_from date not null,
  period_to date not null,
  bills integer not null default 0,
  duplicates integer not null default 0,
  -- Cancelled, void or zero bills, and rows that were not bills (totals, blank lines).
  skipped integer not null default 0,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sales_imports_outlet_idx on sales_imports (outlet_id, period_to desc);
select mezmitra_secure_table('sales_imports');

-- A bill from the other system. Its money is in payments, like a Mezmitra bill's, so the UPI check
-- and bank matching treat both alike.
create table outside_bills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  import_id uuid not null references sales_imports(id) on delete cascade,
  bill_no text check (length(bill_no) <= 60),
  business_date date not null,
  billed_at timestamptz not null,
  -- Exports with dates only are put at noon so the day is right; the time is not shown.
  time_known boolean not null default true,
  total_paise integer not null check (total_paise > 0),
  -- The same bill in two overlapping exports is stored once.
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index outside_bills_fingerprint_key on outside_bills (outlet_id, fingerprint);
create index outside_bills_import_idx on outside_bills (import_id);
select mezmitra_secure_table('outside_bills');

alter table payments add column outside_bill_id uuid references outside_bills(id);
select mezmitra_add_tenant_fks('payments');
alter table payments drop constraint payments_for_check;
alter table payments add constraint payments_for_check check (num_nonnulls(bill_id, wallet_topup_id, outside_bill_id) = 1);
create index payments_outside_bill_idx on payments (outside_bill_id) where outside_bill_id is not null;
