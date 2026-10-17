import type { CameraDTO, VisionConfigDTO } from '@mezmitra/shared/dto';
import type { CameraState } from '@mezmitra/shared/table-state';
import type { Tx } from '../../context';
import { refreshTableStates } from '../tables/sessions';

const ONLINE_WINDOW_MS = 3 * 60_000;

/** Detection settings sent to every edge worker (spec §11: 2-5 fps, 20-30 s hold). */
export const VISION_SETTINGS: VisionConfigDTO['settings'] = { fps: 2, hold_seconds: 25, resend_seconds: 300, min_confidence: 0.6 };

type Polygon = [number, number][];

async function zonesFor(tx: Tx, cameraIds: string[]) {
  if (!cameraIds.length) return [];
  return tx.db
    .selectFrom('tables')
    .select(['id', 'label', 'camera_id', 'camera_zone_polygon'])
    .where('camera_id', 'in', cameraIds)
    .where('is_active', '=', true)
    .where('camera_zone_polygon', 'is not', null)
    .orderBy('label')
    .execute();
}

export async function loadCameras(tx: Tx, outletId: string, ids?: string[]): Promise<CameraDTO[]> {
  let q = tx.db
    .selectFrom('cameras')
    .innerJoin('devices', 'devices.id', 'cameras.device_id')
    .select([
      'cameras.id',
      'cameras.outlet_id',
      'cameras.device_id',
      'devices.name as device_name',
      'cameras.name',
      'cameras.rtsp_secret_ref',
      'cameras.status',
      'cameras.last_seen_at',
      'cameras.last_error',
      'cameras.fps',
      'cameras.snapshot_at',
      'cameras.snapshot_width',
      'cameras.snapshot_height',
      'cameras.snapshot_requested_at',
    ])
    .where('cameras.outlet_id', '=', outletId);
  if (ids) q = q.where('cameras.id', 'in', ids);
  const rows = await q.orderBy('cameras.name').execute();
  const zones = await zonesFor(tx, rows.map((r) => r.id));
  return rows.map((c) => ({
    ...c,
    status: c.status as CameraDTO['status'],
    online: !!c.last_seen_at && Date.now() - c.last_seen_at.getTime() < ONLINE_WINDOW_MS,
    last_seen_at: c.last_seen_at?.toISOString() ?? null,
    snapshot_at: c.snapshot_at?.toISOString() ?? null,
    snapshot_requested_at: c.snapshot_requested_at?.toISOString() ?? null,
    zones: zones.filter((z) => z.camera_id === c.id).map((z) => ({ table_id: z.id, label: z.label, polygon: z.camera_zone_polygon as unknown as Polygon })),
  }));
}

export async function visionConfig(tx: Tx, device: { deviceId: string; outletId: string }): Promise<VisionConfigDTO> {
  const cams = await tx.db
    .selectFrom('cameras')
    .select(['id', 'name', 'rtsp_secret_ref', 'snapshot_requested_at'])
    .where('device_id', '=', device.deviceId)
    .where('status', '=', 'active')
    .orderBy('name')
    .execute();
  const zones = await zonesFor(tx, cams.map((c) => c.id));
  return {
    device_id: device.deviceId,
    outlet_id: device.outletId,
    cameras: cams.map((c) => ({
      id: c.id,
      name: c.name,
      rtsp_secret_ref: c.rtsp_secret_ref,
      snapshot_requested: !!c.snapshot_requested_at,
      zones: zones.filter((z) => z.camera_id === c.id).map((z) => ({ table_id: z.id, label: z.label, polygon: z.camera_zone_polygon as unknown as Polygon })),
    })),
    settings: VISION_SETTINGS,
  };
}

export interface Reading {
  table_id: string;
  state: CameraState;
  confidence: number;
  observed_at: string;
}

/**
 * Records one camera reading and lets it move the table only where the fusion rule allows: with
 * no open visit or order (spec §5). Late or out-of-order readings are logged but never applied.
 */
export async function applyReading(tx: Tx, device: { deviceId: string; outletId: string }, r: Reading): Promise<'applied' | 'stale' | 'not_found'> {
  const table = await tx.db
    .selectFrom('tables')
    .innerJoin('cameras', 'cameras.id', 'tables.camera_id')
    .leftJoin('table_sessions', 'table_sessions.id', 'tables.current_session_id')
    .select(['tables.id', 'tables.outlet_id', 'tables.camera_state', 'tables.camera_at', 'tables.camera_occupied_since', 'table_sessions.status as session_status'])
    .where('tables.id', '=', r.table_id)
    .where('cameras.device_id', '=', device.deviceId)
    .forUpdate(['tables'])
    .executeTakeFirst();
  if (!table || table.outlet_id !== device.outletId) return 'not_found';
  const at = new Date(r.observed_at);
  await tx.db
    .insertInto('table_state_events')
    .values({ tenant_id: tx.tenantId, outlet_id: table.outlet_id, table_id: table.id, source: 'camera', state: r.state, confidence: r.confidence, at })
    .execute();
  if (table.camera_at && at <= table.camera_at) return 'stale';

  const attended = table.session_status === 'open';
  const occupiedSince =
    r.state === 'occupied' && !attended ? (table.camera_state === 'occupied' && table.camera_occupied_since ? table.camera_occupied_since : at) : null;
  await tx.db
    .updateTable('tables')
    .set({ camera_state: r.state, camera_confidence: r.confidence, camera_at: at, camera_occupied_since: occupiedSince })
    .where('id', '=', table.id)
    .execute();
  await refreshTableStates(tx, [table.id], 'camera', { confidence: r.confidence, log: false });
  if (table.camera_state !== r.state) await tx.emit({ outletId: table.outlet_id, type: 'tables.updated', channels: ['outlet'], payload: { table_id: table.id, camera: r.state } });
  return 'applied';
}
