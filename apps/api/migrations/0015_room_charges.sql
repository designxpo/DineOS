-- Hotel restaurants: a bill can be charged to the guest's room. The restaurant bill is settled in
-- DineOS; the hotel collects at checkout. Each room charge is listed for the front desk to post to
-- the guest's folio, and marked once it has been posted.

alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check check (method in ('cash', 'upi', 'card_slip', 'other', 'room'));

alter table payments
  add column room_no text,
  add column room_guest text,
  add column room_posted_at timestamptz,
  add column room_posted_by uuid references users(id);
alter table payments add constraint payments_room_check check (method <> 'room' or room_no is not null);
select dineos_add_tenant_fks('payments');
create index payments_room_idx on payments (outlet_id, created_at) where method = 'room';

-- Off by default: only outlets inside a hotel charge to rooms.
alter table outlets add column room_charge_enabled boolean not null default false;
