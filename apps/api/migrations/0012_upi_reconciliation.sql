-- Phase 4 (without a gateway): UPI payments are confirmed by staff, so owners check them against
-- the bank. A statement export is imported; each credit is matched to a recorded UPI payment by
-- its UTR, or by amount and date. What is left over on either side is what needs a look.

create table bank_statements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  file_name text not null,
  period_from date not null,
  period_to date not null,
  credits integer not null default 0,
  duplicates integer not null default 0,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bank_statements_outlet_idx on bank_statements (outlet_id, period_to desc);
select dineos_secure_table('bank_statements');

create table bank_credits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  statement_id uuid not null references bank_statements(id) on delete cascade,
  txn_date date not null,
  amount_paise integer not null check (amount_paise > 0),
  narration text not null default '',
  reference text,
  utr text,
  is_upi boolean not null default false,
  -- Same credit seen in two overlapping statements is stored once.
  fingerprint text not null,
  payment_id uuid references payments(id),
  match_kind text check (match_kind in ('utr', 'amount_date', 'manual')),
  matched_by uuid references users(id),
  matched_at timestamptz,
  -- Money that is not a sale (owner's transfer, refund from a supplier...).
  dismissed_reason text,
  dismissed_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((payment_id is null) = (match_kind is null))
);
create unique index bank_credits_fingerprint_key on bank_credits (outlet_id, fingerprint);
create unique index bank_credits_payment_key on bank_credits (payment_id) where payment_id is not null;
create index bank_credits_statement_idx on bank_credits (statement_id, txn_date);
select dineos_secure_table('bank_credits');
