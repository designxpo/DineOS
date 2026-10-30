'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, Check, Copy, Monitor, Network, Plus, Printer, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DeviceInfo, FoundPrinter, PrinterConfig } from '@mezmitra/shared/print';
import { API_URL, errorMessage } from '@/lib/api';
import { ago, dateTime, time } from '@/lib/format';
import { useStaff } from '@/lib/staff';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { ConfirmDialog, Sheet } from '@/components/ui/overlay';
import { Badge, Card, Field, Input, Segmented, Select, Spinner, Switch } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useSaveOutlet } from './use-save-outlet';

interface PrintDevice {
  id: string;
  kind: string;
  name: string;
  status: string;
  online: boolean;
  last_seen_at: string | null;
  config: { printers?: Record<string, PrinterConfig> };
  info: DeviceInfo;
}

type Os = 'windows' | 'mac' | 'linux';

const KIND_LABEL: Record<FoundPrinter['kind'], string> = { system: 'USB / installed', device: 'USB', network: 'Network' };
const targetLabel = (t: string) => (t === 'bill' ? 'Bills' : `${t.charAt(0).toUpperCase()}${t.slice(1)} tickets`);
const deviceName = (d: PrintDevice) => d.info.hostname || d.name;

/** The printer's name as the computer reported it, or the address typed in. */
function printerName(d: PrintDevice, address: string): string {
  const found = d.info.printers?.find((p) => p.address === address);
  if (!found) return address.replace(/^printer:/, '');
  return found.kind === 'network' ? found.label : `${found.label} (${KIND_LABEL[found.kind]})`;
}

/** One line that installs the print agent as a service that starts with the computer. */
function installCommand(os: Os, token: string, hub: boolean): string {
  const web = window.location.origin;
  const api = new URL(API_URL, web).origin;
  if (os === 'windows') {
    return `$env:MEZMITRA_WEB='${web}'; $env:MEZMITRA_API='${api}'; $env:MEZMITRA_TOKEN='${token}';${hub ? " $env:MEZMITRA_HUB='1';" : ''} irm ${web}/agent/install.ps1 | iex`;
  }
  return `curl -fsSL ${web}/agent/install.sh | ${os === 'linux' ? 'sudo ' : ''}sh -s -- --web ${web} --api ${api} --token ${token}${hub ? ' --hub' : ''}`;
}

function guessOs(): Os {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent;
  if (/Macintosh/.test(ua) && !/Mobile/.test(ua)) return 'mac';
  if (/Linux/.test(ua) && !/Android/.test(ua)) return 'linux';
  return 'windows';
}

/**
 * Settings > Printers. One always-on computer at the outlet (usually the billing PC) runs the
 * print agent; kitchen and bill printers plug into it by USB or sit on the same network. The
 * agent lists the printers it can reach, so the owner picks from them instead of typing addresses.
 */
export function PrinterSettings() {
  const { api, outletId, outlet } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const [install, setInstall] = useState<{ deviceId: string; token: string } | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PrintDevice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { data: all, isLoading } = useQuery({
    queryKey: ['devices', outletId],
    queryFn: () => api<PrintDevice[]>(`/devices?outlet_id=${outletId}`),
    // Watch closely while a computer is being set up or searching for printers.
    refetchInterval: install || busy?.startsWith('scan') ? 3000 : 30_000,
  });
  const devices = (all ?? []).filter((d) => d.kind === 'print_agent' && d.status === 'active');
  const targets = ['bill', ...(outlet?.kitchen_stations ?? [])];

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast(done);
      await qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  const add = () =>
    run('add', async () => {
      const res = await api<{ device: { id: string }; token: string }>('/devices', { method: 'POST', body: { outlet_id: outletId, name: devices.length ? `Print computer ${devices.length + 1}` : 'Print computer' } });
      setInstall({ deviceId: res.device.id, token: res.token });
    });
  const reinstall = (d: PrintDevice) =>
    run(`reinstall:${d.id}`, async () => {
      const res = await api<{ token: string }>(`/devices/${d.id}/rotate-token`, { method: 'POST' });
      setInstall({ deviceId: d.id, token: res.token });
    });
  const scan = (d: PrintDevice) => {
    setBusy(`scan:${d.id}`);
    api(`/devices/${d.id}/scan`, { method: 'POST' })
      .then(() => toast('Searching for printers. This takes a few seconds.'))
      .catch((err) => toast(errorMessage(err), 'error'));
    setTimeout(() => setBusy((b) => (b === `scan:${d.id}` ? null : b)), 15_000);
  };
  const test = (target: string) => run(`test:${target}`, () => api('/print/test', { method: 'POST', body: { outlet_id: outletId, target } }), `Test page sent to ${targetLabel(target).toLowerCase()}`);

  const choosingDevice = devices.find((d) => d.id === choosing) ?? null;
  const installing = install ? (all ?? []).find((d) => d.id === install.deviceId) : undefined;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="font-semibold">Kitchen tickets and bills</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Choose one computer at the outlet that stays on during service, usually the billing PC. Plug the bill and kitchen printers into it by USB, or connect them to the same network (LAN or
          Wi-Fi). Mezvaan then prints each station&rsquo;s kitchen ticket (KOT) on its own printer and the bill at the billing desk, and can open the cash drawer.
        </p>
        <p className="mt-2 text-sm text-ink-faint">Without a print computer, the kitchen screen shows every order and bills print from the browser.</p>
        <Button className="mt-4" loading={busy === 'add'} onClick={() => void add()}>
          <Plus className="size-4" /> Add print computer
        </Button>
      </Card>

      {isLoading && (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      )}

      {devices.map((d) => {
        const printers = d.config.printers ?? {};
        const found = d.info.printers ?? [];
        return (
          <Card key={d.id} className="overflow-hidden">
            <div className="flex items-start gap-3 p-5 pb-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-stone-100 text-ink-soft">
                <Monitor className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{deviceName(d)}</p>
                <p className="text-xs text-ink-faint">
                  {[d.info.platform, d.info.version && `agent ${d.info.version}`].filter(Boolean).join(' · ') || 'Not installed yet'}
                  {d.last_seen_at && !d.online ? ` · last seen ${dateTime(d.last_seen_at)}` : ''}
                </p>
              </div>
              <Badge tone={d.online ? 'green' : d.last_seen_at ? 'rose' : 'neutral'}>{d.online ? 'Online' : d.last_seen_at ? 'Offline' : 'Waiting'}</Badge>
            </div>

            <ul className="divide-y divide-line border-y border-line">
              {targets.map((t) => {
                const p = printers[t];
                return (
                  <li key={t} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                    <span className="w-28 shrink-0 font-medium">{targetLabel(t)}</span>
                    <span className={cn('min-w-0 flex-1', p ? 'text-ink' : 'text-ink-faint')}>
                      {p ? (
                        <>
                          {printerName(d, p.address)}
                          <span className="text-ink-faint">
                            {' '}
                            · {p.width === 32 ? '58 mm' : '80 mm'}
                            {p.drawer ? ' · opens cash drawer' : ''}
                          </span>
                        </>
                      ) : t === 'bill' ? (
                        'Not printed; bills print from the browser'
                      ) : (
                        'Not printed; shows on the kitchen screen'
                      )}
                    </span>
                    {p && (
                      <Button size="sm" variant="ghost" loading={busy === `test:${t}`} onClick={() => void test(t)}>
                        <Printer className="size-4" /> Test
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="space-y-3 p-5">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setChoosing(d.id)}>
                  Choose printers
                </Button>
                <Button size="sm" variant="outline" loading={busy === `scan:${d.id}`} disabled={!d.online} onClick={() => scan(d)}>
                  <RefreshCw className="size-4" /> Search for printers
                </Button>
                <Button size="sm" variant="ghost" loading={busy === `reinstall:${d.id}`} onClick={() => void reinstall(d)}>
                  New install command
                </Button>
                <Button size="sm" variant="ghost" className="text-rose-700" onClick={() => setRemoving(d)}>
                  Remove
                </Button>
              </div>
              <div>
                <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">
                  Printers this computer can reach{d.info.scanned_at ? ` · checked ${ago(d.info.scanned_at)}` : ''}
                </p>
                {found.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-faint">{d.info.scanned_at ? 'None found. Check the printer is on, plugged in or on the same network, then search again.' : 'The computer lists them once the agent is running.'}</p>
                ) : (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {found.map((f) => (
                      <li key={f.address} className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-xs text-ink-soft">
                        {f.kind === 'network' ? <Network className="size-3.5" /> : <Cable className="size-3.5" />}
                        {f.label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>
        );
      })}

      {install && (
        <InstallSheet
          token={install.token}
          device={installing}
          onClose={() => setInstall(null)}
          onChoose={() => {
            setChoosing(install.deviceId);
            setInstall(null);
          }}
        />
      )}
      {choosingDevice && <PrinterMap device={choosingDevice} targets={targets} onClose={() => setChoosing(null)} />}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing ? deviceName(removing) : ''}?`}
        description="It stops printing at once. To use it again, add it as a new print computer."
        confirmLabel="Remove"
        busy={busy === 'remove'}
        onConfirm={() =>
          void run('remove', () => api(`/devices/${removing!.id}`, { method: 'PATCH', body: { status: 'revoked' } }), 'Print computer removed').then(() => setRemoving(null))
        }
      />
      {devices.length > 0 && <HubSettings devices={devices} />}
    </div>
  );
}

function InstallSheet({ token, device, onClose, onChoose }: { token: string; device: PrintDevice | undefined; onClose: () => void; onChoose: () => void }) {
  const toast = useToast();
  const [os, setOs] = useState<Os>('windows');
  const [hub, setHub] = useState(false);
  useEffect(() => setOs(guessOs()), []);
  const command = installCommand(os, token, hub);
  const connected = !!device?.online;
  const found = device?.info.printers?.length ?? 0;
  return (
    <Sheet open onClose={onClose} title="Install on the print computer" wide>
      <div className="space-y-4 text-sm">
        <p className="text-ink-soft">On the computer at the outlet that will print (it must stay on during service):</p>
        <Segmented
          value={os}
          onChange={setOs}
          options={[
            { value: 'windows', label: 'Windows' },
            { value: 'mac', label: 'Mac' },
            { value: 'linux', label: 'Linux / Raspberry Pi' },
          ]}
        />
        <p className="text-ink-soft">
          {os === 'windows'
            ? 'Open the Start menu, type PowerShell, right-click Windows PowerShell and choose "Run as administrator". Paste this line and press Enter:'
            : 'Open Terminal, paste this line and press Enter (it may ask for the computer password):'}
        </p>
        <pre className="overflow-x-auto rounded-xl bg-stone-900 p-3 text-xs leading-relaxed whitespace-pre-wrap text-stone-100 [overflow-wrap:anywhere]">{command}</pre>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(command).then(() => toast('Command copied'))}>
            <Copy className="size-4" /> Copy command
          </Button>
          <label className="flex items-center gap-2 text-ink-soft">
            <Switch checked={hub} onChange={setHub} label="Also keep the outlet running offline on this computer" />
            Also keep the outlet running offline on this computer
          </label>
        </div>
        <p className="text-xs text-ink-faint">
          It installs Node.js if needed and sets Mezvaan printing to start with the computer. The line holds this computer&rsquo;s key, so keep it private; &ldquo;New install command&rdquo; replaces it.
        </p>
        <div className={cn('flex items-center gap-3 rounded-xl border p-3', connected ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-line bg-stone-50 text-ink-soft')} role="status">
          {connected ? <Check className="size-5 shrink-0" /> : <Spinner className="size-4 shrink-0" />}
          <p className="flex-1">
            {connected
              ? `Connected to ${device!.info.hostname ?? 'the computer'}${device!.info.scanned_at ? `; found ${found} printer${found === 1 ? '' : 's'}` : '; looking for printers'}.`
              : 'Waiting for the computer to connect…'}
          </p>
          {connected && (
            <Button size="sm" onClick={onChoose}>
              Choose printers
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

const OTHER = '__other';

function PrinterMap({ device, targets, onClose }: { device: PrintDevice; targets: string[]; onClose: () => void }) {
  const { api } = useStaff();
  const qc = useQueryClient();
  const toast = useToast();
  const found = device.info.printers ?? [];
  const known = new Set(found.map((f) => f.address));
  const [map, setMap] = useState<Record<string, PrinterConfig>>(device.config.printers ?? {});
  // Targets where the owner types an address instead of picking a found printer.
  const [typed, setTyped] = useState<Set<string>>(() => new Set(Object.entries(device.config.printers ?? {}).filter(([, p]) => !known.has(p.address)).map(([t]) => t)));
  const [saving, setSaving] = useState(false);

  const set = (t: string, patch: Partial<PrinterConfig>) => setMap((m) => ({ ...m, [t]: { address: '', width: 48, ...m[t], ...patch } }));
  const pick = (t: string, value: string) => {
    if (value === OTHER) {
      setTyped((s) => new Set(s).add(t));
      set(t, { address: '' });
      return;
    }
    setTyped((s) => {
      const next = new Set(s);
      next.delete(t);
      return next;
    });
    if (!value) {
      setMap((m) => {
        const next = { ...m };
        delete next[t];
        return next;
      });
    } else set(t, { address: value });
  };
  const save = async () => {
    const printers = Object.fromEntries(Object.entries(map).filter(([, v]) => v.address.trim()));
    setSaving(true);
    try {
      await api(`/devices/${device.id}`, { method: 'PATCH', body: { config: { printers } } });
      await qc.invalidateQueries({ queryKey: ['devices'] });
      toast('Printers saved; the computer uses them straight away');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };
  const installed = found.filter((f) => f.kind !== 'network');
  const network = found.filter((f) => f.kind === 'network');

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Printers on ${deviceName(device)}`}
      footer={
        <Button block loading={saving} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <p className="mb-4 text-sm text-ink-soft">
        One printer can do several jobs; small outlets often print bills and kitchen tickets on the same one.
        {device.info.scanned_at ? ` Printers found ${time(device.info.scanned_at)}.` : ''}
      </p>
      <div className="space-y-5">
        {targets.map((t) => {
          const p = map[t];
          const isTyped = typed.has(t);
          return (
            <div key={t} className="space-y-2">
              <Field label={targetLabel(t)}>
                {(id) => (
                  <Select id={id} value={isTyped ? OTHER : (p?.address ?? '')} onChange={(e) => pick(t, e.target.value)}>
                    <option value="">{t === 'bill' ? 'Do not print (browser printing)' : 'Do not print (kitchen screen only)'}</option>
                    {installed.length > 0 && (
                      <optgroup label="Plugged into this computer">
                        {installed.map((f) => (
                          <option key={f.address} value={f.address}>
                            {f.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {network.length > 0 && (
                      <optgroup label="On the network">
                        {network.map((f) => (
                          <option key={f.address} value={f.address}>
                            {f.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value={OTHER}>Other address…</option>
                  </Select>
                )}
              </Field>
              {isTyped && (
                <Field label="Printer address" hint="A network printer's IP, e.g. 192.168.1.50:9100, or printer: and the name of a printer on that computer">
                  {(id) => <Input id={id} value={p?.address ?? ''} onChange={(e) => set(t, { address: e.target.value })} placeholder="192.168.1.50:9100" autoComplete="off" />}
                </Field>
              )}
              {p && (p.address || isTyped) && (
                <div className="flex flex-wrap items-center gap-3">
                  <Select value={p.width} onChange={(e) => set(t, { width: Number(e.target.value) as PrinterConfig['width'] })} className="w-44" aria-label={`${targetLabel(t)} paper width`}>
                    <option value={48}>80 mm paper</option>
                    <option value={42}>80 mm (42 characters)</option>
                    <option value={32}>58 mm paper</option>
                  </Select>
                  {t === 'bill' && (
                    <label className="flex items-center gap-2 text-sm text-ink-soft">
                      <Switch checked={!!p.drawer} onChange={(v) => set(t, { drawer: v })} label="Open the cash drawer on cash payments" />
                      Open the cash drawer on cash payments
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}

/** One print computer can also run the outlet hub that keeps the outlet trading offline. */
function HubSettings({ devices }: { devices: PrintDevice[] }) {
  const { outlet } = useStaff();
  const save = useSaveOutlet();
  const [deviceId, setDeviceId] = useState(outlet?.hub_device_id ?? '');
  const [url, setUrl] = useState(outlet?.hub_url ?? '');
  useEffect(() => {
    setDeviceId(outlet?.hub_device_id ?? '');
    setUrl(outlet?.hub_url ?? '');
  }, [outlet?.hub_device_id, outlet?.hub_url]);
  const hub = devices.find((d) => d.id === outlet?.hub_device_id);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Offline mode (outlet hub)</h2>
          <p className="mt-1 text-sm text-ink-soft">
            When the internet goes down, staff screens can switch to this computer on your Wi-Fi and keep taking orders, sending kitchen tickets and printing GST bills. Everything is sent to
            Mezvaan when the connection returns.
          </p>
        </div>
        {hub && <Badge tone={hub.online ? 'green' : 'amber'}>{hub.online ? 'Hub ready' : 'Hub not connected'}</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Computer that runs the hub">
          {(id) => (
            <Select id={id} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Off</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {deviceName(d)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Its address on your Wi-Fi" hint="Give the computer a fixed IP in your router">
          {(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:4100" />}
        </Field>
      </div>
      {deviceId && <p className="text-sm text-ink-faint">On that computer, run its install command with &ldquo;Also keep the outlet running offline&rdquo; switched on (New install command on its card).</p>}
      <Button onClick={() => void save({ hub_device_id: deviceId || null, hub_url: deviceId ? url.trim() || null : null })} disabled={!!deviceId && !/^https?:\/\/\S+$/.test(url.trim())}>
        Save offline mode
      </Button>
    </Card>
  );
}
