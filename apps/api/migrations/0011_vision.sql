-- Phase 3: camera table vision. An edge worker at the outlet watches IP cameras, decides per
-- table zone whether it is vacant, occupied or left messy, and sends only that state and a
-- confidence. No video is stored; a single still is kept briefly, on request, for drawing zones.

create table cameras (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  outlet_id uuid not null references outlets(id),
  -- The vision device (edge box) that reads this camera.
  device_id uuid not null references devices(id),
  name text not null,
  -- Name of the stream setting on the edge box (e.g. "courtyard" -> DINEOS_RTSP_COURTYARD).
  -- The RTSP address and password stay on the box and never reach the cloud.
  rtsp_secret_ref text not null check (rtsp_secret_ref ~ '^[a-z0-9_]{1,40}$'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_seen_at timestamptz,
  last_error text,
  fps real,
  snapshot bytea,
  snapshot_width integer,
  snapshot_height integer,
  snapshot_at timestamptz,
  snapshot_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index cameras_outlet_ref_key on cameras (outlet_id, rtsp_secret_ref);
select dineos_secure_table('cameras');

-- The polygon (camera_zone_polygon, from Phase 1) is drawn on this camera's picture, in 0..1
-- coordinates so it survives a change of stream resolution.
alter table tables
  add column camera_id uuid references cameras(id),
  -- Latest reading from the camera: vacant, occupied or needs_cleaning.
  add column camera_state text check (camera_state in ('vacant', 'occupied', 'needs_cleaning')),
  add column camera_confidence real,
  add column camera_at timestamptz,
  -- When the camera first saw people at a table nobody has opened yet (unattended guests).
  add column camera_occupied_since timestamptz;
select dineos_add_tenant_fks('tables');

create index table_state_events_camera_idx on table_state_events (outlet_id, at) where source = 'camera';
