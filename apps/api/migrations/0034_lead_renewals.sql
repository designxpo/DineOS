-- Most restaurants we talk to already pay for billing software, often a year ahead. What they use
-- and when it renews tells us when to call back: the month before it renews.
alter table demo_requests add column current_system text check (length(current_system) <= 40);
-- The first of the month it renews.
alter table demo_requests add column renews_on date;
create index demo_requests_renews_idx on demo_requests (renews_on) where renews_on is not null;
