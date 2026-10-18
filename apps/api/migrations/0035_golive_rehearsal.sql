-- The go-live rehearsal: before paying in full, the owner and cashier run the restaurant's hardest
-- moments on their own devices (a mixed bar and kitchen order, a split, a free dish, a cooked
-- cancellation, a printer out of paper, the internet off, the day-end export) and the owner signs
-- an acceptance sheet listing what passed and what is out of scope. Full payment starts after it.

create table golive_rehearsals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  started_by uuid references users(id),
  started_at timestamptz not null default now(),
  signed_at timestamptz,
  signed_by uuid references users(id),
  -- The owner's name as typed on the sheet.
  signer_name text check (length(signer_name) between 2 and 80),
  -- The sheet as signed: each scenario's result, note and what Mezmitra saw, and the screens and
  -- print computers used. Kept as it was, whatever changes later.
  sheet jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((signed_at is null) = (signed_by is null) and (signed_at is null) = (sheet is null))
);
-- One rehearsal in progress per outlet.
create unique index golive_rehearsals_open_key on golive_rehearsals (outlet_id) where signed_at is null;
create index golive_rehearsals_outlet_idx on golive_rehearsals (outlet_id, started_at desc);
select mezmitra_secure_table('golive_rehearsals');

create table golive_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  rehearsal_id uuid not null references golive_rehearsals(id) on delete cascade,
  scenario text not null,
  result text not null check (result in ('passed', 'failed', 'out_of_scope')),
  note text check (length(note) <= 500),
  -- Times it was marked failed: "passed first time" is a measure the plan tracks.
  failures integer not null default 0,
  checked_by uuid references users(id),
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rehearsal_id, scenario)
);
select mezmitra_secure_table('golive_checks');
