-- Phase 2: hybrid offline tier. One print-agent device per outlet can run as the outlet hub: it
-- keeps a copy of the menu, tables, staff sessions and open tables, serves the staff app on the
-- LAN while the internet is down, and sends what happened back when the connection returns.

alter table outlets
  add column hub_device_id uuid references devices(id),
  -- LAN address staff devices switch to, e.g. http://192.168.1.20:4100
  add column hub_url text check (hub_url is null or hub_url ~ '^https?://[^ ]+$');
select dineos_add_tenant_fks('outlets');

-- Bills printed by the hub while offline use their own gap-free series (PREFIXH/2627/00001), so
-- the hub never needs the cloud's counter. Both series are reported for GST.
alter table bills add column invoice_series text not null default 'main' check (invoice_series in ('main', 'hub'));
drop index bills_invoice_seq_key;
create unique index bills_invoice_seq_key on bills (outlet_id, fy_code, invoice_series, invoice_seq) where invoice_seq is not null;

-- The number the hub printed on the kitchen ticket (e.g. H12); the cloud gives synced orders a
-- regular order number of the day.
alter table orders add column offline_ref text;
