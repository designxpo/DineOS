-- Delivery orders entered at the POS until an aggregator link exists: Zomato, Swiggy or the
-- outlet's own riders, with the platform's order number. On Zomato and Swiggy orders the platform
-- collects and pays the GST (CGST Act s. 9(5)), so those bills carry no tax and are settled by the
-- platform's payout ('platform' payments, which never touch the cash drawer). Commission per
-- platform lives on the outlet, for the delivery report's expected payout.

alter table orders drop constraint orders_type_check;
alter table orders add constraint orders_type_check check (type in ('dine_in', 'takeaway', 'counter', 'delivery'));
alter table orders
  add column channel text check (channel in ('zomato', 'swiggy', 'own')),
  add column channel_ref text,
  add constraint orders_delivery_channel_check check ((type = 'delivery') = (channel is not null));

alter table bills add column tax_by_operator boolean not null default false;

alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check check (method in ('cash', 'upi', 'card_slip', 'other', 'room', 'platform'));

alter table outlets add column delivery_commission_bp jsonb not null default '{}'::jsonb;
