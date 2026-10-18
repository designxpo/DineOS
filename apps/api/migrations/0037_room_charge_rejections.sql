-- A room charge the front desk could not post (wrong room, guest already checked out) is not
-- settled with the hotel: it stays on a list until it is posted or taken back, with the reason.

alter table payments
  add column room_rejected_at timestamptz,
  add column room_rejected_by uuid references users(id),
  add column room_reject_reason text check (length(room_reject_reason) <= 300);
alter table payments add constraint payments_room_rejected_check check (
  (room_rejected_at is null and room_rejected_by is null and room_reject_reason is null)
  or (room_rejected_at is not null and room_posted_at is null and room_reject_reason is not null)
);
