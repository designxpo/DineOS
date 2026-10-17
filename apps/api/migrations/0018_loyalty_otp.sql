-- Loyalty with a one-time code by SMS (MSG91, once its keys are set): a guest proves a number is
-- theirs before the menu shows the name and points on it. DineOS makes and checks the codes; MSG91
-- only delivers them. Codes are stored hashed and last ten minutes; a table visit remembers when
-- its number was proved.

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  table_session_id uuid not null references table_sessions(id) on delete cascade,
  phone text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index otp_codes_phone_idx on otp_codes (tenant_id, phone, created_at desc);
create index otp_codes_outlet_idx on otp_codes (outlet_id, created_at desc);
select dineos_secure_table('otp_codes');

alter table table_sessions add column customer_verified_at timestamptz;
