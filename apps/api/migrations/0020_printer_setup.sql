-- Connecting printers without typing addresses, and knowing when a ticket did not print.
--
-- devices.info: what a print agent reports about its computer and the printers it can reach
-- (installed USB printers, Linux USB devices, network printers on port 9100), so owners pick a
-- printer in Settings instead of typing an IP address.
alter table devices add column info jsonb not null default '{}';

-- A cash drawer wired to the bill printer opens on cash payments: a "drawer" print job.
alter table print_jobs drop constraint print_jobs_kind_check;
alter table print_jobs add constraint print_jobs_kind_check check (kind in ('kot', 'bill', 'test', 'drawer'));

-- Staff clear a print problem they have dealt with (the kitchen read the order off the screen,
-- or it was printed again), so the warning goes away.
alter table print_jobs add column dismissed_at timestamptz;
create index print_jobs_problem_idx on print_jobs (outlet_id, created_at) where dismissed_at is null and status <> 'printed';
