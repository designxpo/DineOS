-- Restaurants asking for a demo from the website. Platform data, not a tenant's: only DineOS admins
-- (and the public form, through the API) touch it.
create table demo_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  restaurant text not null check (length(restaurant) between 1 and 120),
  phone text not null check (length(phone) between 8 and 20),
  city text check (length(city) <= 60),
  tables text check (tables in ('1-10', '11-25', '26-40', '41+')),
  plan text check (length(plan) <= 40),
  -- What hurts most, from the form's list.
  pains text[] not null default '{}',
  note text check (length(note) <= 1000),
  status text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost')),
  contacted_at timestamptz,
  created_at timestamptz not null default now()
);
create index demo_requests_created_idx on demo_requests (created_at desc);
alter table demo_requests enable row level security;
grant select, insert, update on demo_requests to dineos_admin;
