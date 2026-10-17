-- Manager PINs approve voids, refunds, cancellations and large discounts. A few wrong guesses in a
-- row lock that manager's PIN for a while, so a cashier cannot work through every combination; the
-- owner is told. Setting a new PIN, or a correct PIN after the lock ends, starts the count again.
alter table users add column pin_failed_attempts integer not null default 0;
alter table users add column pin_locked_until timestamptz;
