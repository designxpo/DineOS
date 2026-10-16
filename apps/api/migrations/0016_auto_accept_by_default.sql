-- New outlets accept QR orders automatically. Staff still check the first order at each table
-- (approve_flagged_orders stays on) and every order from a phone that was at the table in an
-- earlier visit, so they only touch the orders that need a person. Existing outlets keep their
-- setting.

alter table outlets alter column auto_accept set default true;
