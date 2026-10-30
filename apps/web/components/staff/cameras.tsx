'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Copy, ImageOff, Plus, RefreshCw, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CameraDTO, TableDTO } from '@mezmitra/shared/dto';
import { API_URL, apiBlobUrl, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet } from '@/components/ui/overlay';
import { Badge, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

interface Device {
  id: string;
  kind: string;
  name: string;
  status: string;
  online: boolean;
  last_seen_at: string | null;
}

type Point = [number, number];

/** Settings > Cameras: optional table vision (spec Phase 3). Only states leave the outlet. */
export function CamerasSettings() {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const devices = useQuery({ queryKey: ['devices', outletId], queryFn: () => api<Device[]>(`/devices?outlet_id=${outletId}`) });
  const cameras = useQuery({ queryKey: ['cameras', outletId], queryFn: () => api<CameraDTO[]>(`/cameras?outlet_id=${outletId}`), refetchInterval: 15_000 });
  const boxes = (devices.data ?? []).filter((d) => d.kind === 'vision' && d.status === 'active');
  const [token, setToken] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [zones, setZones] = useState<CameraDTO | null>(null);

  const addBox = async () => {
    try {
      const res = await api<{ token: string }>('/devices', { method: 'POST', body: { outlet_id: outletId, kind: 'vision', name: 'Camera box' } });
      setToken(res.token);
      await qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const toggle = async (c: CameraDTO) => {
    try {
      await api(`/cameras/${c.id}`, { method: 'PATCH', body: { status: c.status === 'active' ? 'disabled' : 'active' } });
      await qc.invalidateQueries({ queryKey: ['cameras'] });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <div>
          <h2 className="font-semibold">Camera table vision (optional)</h2>
          <p className="mt-1 text-sm text-ink-soft">
            A small computer at the outlet watches your existing IP cameras and tells Mezvaan whether each table is free, taken or left messy. Orders and bills always come first: the camera
            only fills gaps, such as guests who sat down and nobody has served yet.
          </p>
        </div>
        <p className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          No video leaves the outlet and nothing identifies a person. Only a table state and a confidence are sent. Put up a notice, and never point cameras at washrooms or staff rooms.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {boxes.map((b) => (
            <Badge key={b.id} tone={b.online ? 'green' : 'neutral'}>
              {b.name}: {b.online ? 'online' : b.last_seen_at ? `last seen ${ago(b.last_seen_at)}` : 'never connected'}
            </Badge>
          ))}
          <Button size="sm" variant="outline" onClick={() => void addBox()}>
            <Plus className="size-4" /> Add camera box
          </Button>
          {boxes.length > 0 && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Camera className="size-4" /> Add camera
            </Button>
          )}
        </div>
      </Card>

      {cameras.isLoading ? (
        <Spinner />
      ) : !cameras.data?.length ? (
        boxes.length > 0 && <EmptyState icon={<Camera className="size-5" />} title="No cameras yet" hint="Add each camera that can see tables, then draw the tables on its picture." />
      ) : (
        cameras.data.map((c) => (
          <Card key={c.id} className="flex flex-wrap items-center gap-4 p-4">
            <div className="grid size-11 place-items-center rounded-xl bg-stone-100 text-ink-soft">
              <Camera className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{c.name}</p>
              <p className="text-xs text-ink-faint">
                {c.device_name} · stream “{c.rtsp_secret_ref}” · {c.zones.length} table{c.zones.length === 1 ? '' : 's'}
                {c.fps ? ` · ${c.fps.toFixed(1)} fps` : ''}
              </p>
              {c.last_error && <p className="text-xs font-medium text-rose-700">{c.last_error}</p>}
            </div>
            <Badge tone={c.status === 'disabled' ? 'neutral' : c.online && !c.last_error ? 'green' : 'amber'}>
              {c.status === 'disabled' ? 'Off' : c.online ? (c.last_error ? 'Problem' : 'Watching') : 'Offline'}
            </Badge>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setZones(c)} disabled={c.status === 'disabled'}>
                Draw table zones
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void toggle(c)}>
                {c.status === 'active' ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
          </Card>
        ))
      )}

      <Sheet open={!!token} onClose={() => setToken(null)} title="Camera box added">
        <p className="text-sm text-ink-soft">On the outlet computer, with Python 3.11 and the model from the setup guide, run the worker with this token. It is shown only once.</p>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-stone-900 p-3 text-xs text-stone-100">{`MEZMITRA_API_URL=${API_URL} \\\nMEZMITRA_DEVICE_TOKEN=${token} \\\nMEZMITRA_RTSP_COURTYARD=rtsp://user:pass@192.168.1.60/stream1 \\\npython -m mezmitra_vision`}</pre>
        <Button className="mt-3" variant="outline" onClick={() => void navigator.clipboard.writeText(token ?? '').then(() => toast('Token copied'))}>
          <Copy className="size-4" /> Copy token
        </Button>
      </Sheet>
      {adding && <AddCamera boxes={boxes} onClose={() => setAdding(false)} />}
      {zones && <ZoneEditor camera={zones} onClose={() => setZones(null)} />}
    </div>
  );
}

function AddCamera({ boxes, onClose }: { boxes: Device[]; onClose: () => void }) {
  const { api, outletId } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [box, setBox] = useState(boxes[0]?.id ?? '');
  const save = async () => {
    try {
      await api('/cameras', { method: 'POST', body: { outlet_id: outletId, device_id: box, name, rtsp_secret_ref: ref } });
      await qc.invalidateQueries({ queryKey: ['cameras'] });
      toast('Camera added. Its picture will appear for drawing zones within a minute.');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <Sheet open onClose={onClose} title="Add camera" footer={<Button block onClick={() => void save()} disabled={!name.trim() || !/^[a-zA-Z0-9_]{1,40}$/.test(ref) || !box}>Add</Button>}>
      <div className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Courtyard, east corner" autoFocus />}</Field>
        <Field label="Stream setting on the camera box" hint={`The box reads the address from MEZMITRA_RTSP_${(ref || 'NAME').toUpperCase()}. The camera password stays on the box.`}>
          {(id) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase())} placeholder="courtyard_east" />}
        </Field>
        {boxes.length > 1 && (
          <Field label="Camera box">
            {(id) => (
              <Select id={id} value={box} onChange={(e) => setBox(e.target.value)}>
                {boxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
    </Sheet>
  );
}

/** Click around a table on the camera picture to outline it. Coordinates are stored as 0..1. */
function ZoneEditor({ camera, onClose }: { camera: CameraDTO; onClose: () => void }) {
  const { api, outletId, token } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const cams = useQuery({ queryKey: ['cameras', outletId], queryFn: () => api<CameraDTO[]>(`/cameras?outlet_id=${outletId}`), refetchInterval: 5000 });
  const live = cams.data?.find((c) => c.id === camera.id) ?? camera;
  const tables = useQuery({ queryKey: ['tables', outletId], queryFn: () => api<TableDTO[]>(`/tables?outlet_id=${outletId}`) });
  const [image, setImage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [points, setPoints] = useState<Point[]>([]);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live.snapshot_at) return;
    let url: string | null = null;
    apiBlobUrl(`/cameras/${camera.id}/snapshot`, token)
      .then((u) => setImage((url = u)))
      .catch(() => setImage(null));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [camera.id, live.snapshot_at, token]);

  useEffect(() => {
    const zone = live.zones.find((z) => z.table_id === selected);
    setPoints(zone ? zone.polygon : []);
  }, [selected]); // only when another table is picked, not on every refresh

  const request = async () => {
    try {
      await api(`/cameras/${camera.id}/snapshot-request`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['cameras'] });
      toast('Asked the camera box for a new picture');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const save = async (polygon: Point[] | null) => {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/tables/${selected}/camera-zone`, { method: 'PUT', body: { camera_id: polygon ? camera.id : null, polygon } });
      await qc.invalidateQueries({ queryKey: ['cameras'] });
      toast(polygon ? 'Zone saved' : 'Zone removed');
      if (!polygon) setPoints([]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const click = (e: React.MouseEvent) => {
    if (!selected || !frame.current) return;
    const r = frame.current.getBoundingClientRect();
    const p: Point = [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    setPoints((pts) => (pts.length < 24 ? [...pts, [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))]] : pts));
  };
  const others = live.zones.filter((z) => z.table_id !== selected);
  const label = (id: string) => tables.data?.find((t) => t.id === id)?.label ?? '';
  const ratio = live.snapshot_width && live.snapshot_height ? `${live.snapshot_width} / ${live.snapshot_height}` : '16 / 9';

  return (
    <Sheet open onClose={onClose} title={`Table zones: ${camera.name}`} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Table to outline" className="min-w-48 flex-1">
            {(id) => (
              <Select id={id} value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">Pick a table…</option>
                {(tables.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                    {live.zones.some((z) => z.table_id === t.id) ? ' (drawn)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button variant="ghost" size="sm" onClick={() => void request()}>
            <RefreshCw className="size-4" /> New picture
          </Button>
        </div>
        <div
          ref={frame}
          onClick={click}
          className={cn('relative w-full overflow-hidden rounded-xl bg-stone-900', selected && image ? 'cursor-crosshair' : '')}
          style={{ aspectRatio: ratio }}
        >
          {image ? (
            <img src={image} alt={`Still from ${camera.name}`} className="absolute inset-0 size-full object-fill select-none" draggable={false} />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-center text-sm text-stone-300">
              <span>
                <ImageOff className="mx-auto mb-2 size-6" />
                {live.snapshot_requested_at ? 'Waiting for the camera box to send a picture…' : 'No picture yet.'}
              </span>
            </div>
          )}
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
            {others.map((z) => (
              <polygon key={z.table_id} points={z.polygon.map((p) => p.join(',')).join(' ')} fill="rgba(255,255,255,0.12)" stroke="white" strokeWidth={0.003} />
            ))}
            {points.length > 1 && <polygon points={points.map((p) => p.join(',')).join(' ')} fill="rgba(194,83,31,0.35)" stroke="#f97316" strokeWidth={0.004} />}
          </svg>
          {others.map((z) => {
            const cx = z.polygon.reduce((a, p) => a + p[0], 0) / z.polygon.length;
            const cy = z.polygon.reduce((a, p) => a + p[1], 0) / z.polygon.length;
            return (
              <span key={z.table_id} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded bg-black/60 px-1.5 text-xs font-semibold text-white" style={{ left: `${cx * 100}%`, top: `${cy * 100}%` }}>
                {label(z.table_id) || z.label}
              </span>
            );
          })}
          {points.map((p, i) => (
            <span key={i} className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-orange-500" style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }} />
          ))}
        </div>
        <p className="text-xs text-ink-faint">
          {selected ? 'Click around the table top and the chairs, then save. People sitting should fall inside the outline.' : 'Pick a table, then click its corners on the picture.'} Faces
          are blurred on the camera box before the picture is sent, and it is deleted after a day.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save(points)} disabled={!selected || points.length < 3} loading={busy}>
            Save zone
          </Button>
          <Button variant="outline" onClick={() => setPoints((p) => p.slice(0, -1))} disabled={!points.length}>
            <Undo2 className="size-4" /> Undo point
          </Button>
          {selected && live.zones.some((z) => z.table_id === selected) && (
            <Button variant="ghost" className="text-rose-700" onClick={() => void save(null)}>
              <Trash2 className="size-4" /> Remove zone
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
