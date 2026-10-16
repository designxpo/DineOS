'use client';

import { CloudOff, RefreshCw, Router, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { onHub } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { discard, listQueued } from '@/lib/outbox';
import { useConnection } from '@/lib/realtime';
import { useStaff } from '@/lib/staff';
import { readLocal, writeLocal } from '@/lib/storage';
import { Button } from '@/components/ui/button';

const HUB_URL_KEY = 'dineos.hub_url';
const SWITCH_AFTER_MS = 30_000;

/** Changes the hub can take over from this device's offline queue; others wait for the cloud. */
const HUB_PATHS = [
  /^\/orders$/,
  /^\/orders\/[^/]+\/(status|items)$/,
  /^\/order-items\/[^/]+\/status$/,
  /^\/bills$/,
  /^\/bills\/[^/]+(\/(finalise|payments))?$/,
  /^\/tables\/[^/]+\/(seat|clean|release)$/,
];

/**
 * On the cloud app: after half a minute without a connection, offers the outlet hub so staff
 * keep taking orders and printing bills. The session and queued changes travel in the URL
 * fragment, which never leaves the browser.
 */
export function HubSwitchBanner() {
  const { outlet, outletId, token } = useStaff();
  const { t } = useI18n();
  const connection = useConnection();
  const [downSince, setDownSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const hubUrl = outlet?.hub_url ?? readLocal<string | null>(HUB_URL_KEY, null);

  useEffect(() => {
    if (outlet) writeLocal(HUB_URL_KEY, outlet.hub_url);
  }, [outlet]);
  useEffect(() => {
    setDownSince(connection === 'offline' ? (d) => d ?? Date.now() : null);
  }, [connection]);
  useEffect(() => {
    if (downSince === null) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [downSince]);

  if (onHub() || !hubUrl || downSince === null || now - downSince < SWITCH_AFTER_MS) return null;

  const go = async () => {
    setBusy(true);
    const queued = (await listQueued()).filter((q) => HUB_PATHS.some((re) => re.test(q.path.split('?')[0]!)));
    const outbox = queued.map(({ key, path, method, body, token: tk }) => ({ key, path, method, body, token: tk }));
    const params = new URLSearchParams({ token, outlet: outletId, to: window.location.pathname, outbox: JSON.stringify(outbox) });
    // The hub replays them with the same keys; the cloud never sees them twice.
    for (const q of queued) await discard(q.key);
    window.location.href = `${hubUrl}/offline#${params.toString()}`;
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-950 lg:px-6" role="alert">
      <CloudOff className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{t('offline.no_internet')}</span> {t('offline.use_hub')}
      </p>
      <Button size="sm" onClick={() => void go()} loading={busy}>
        <Router className="size-4" /> {t('offline.switch')}
      </Button>
    </div>
  );
}

interface HubStatus {
  online: boolean;
  pending_sync: boolean;
  web_url: string | null;
  last_sync: { error: string | null; failed: { message: string }[] };
}

/** On the hub: says the outlet is in offline mode, and leads back once everything has synced. */
export function HubModeBanner() {
  const { t } = useI18n();
  const [status, setStatus] = useState<HubStatus | null>(null);
  // Read after mount: the server render cannot know which address the app is served from.
  const [hub, setHub] = useState(false);
  useEffect(() => setHub(onHub()), []);
  useEffect(() => {
    if (!hub) return;
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch('/hub/status', { cache: 'no-store' });
        if (!stop && res.ok) setStatus(await res.json());
      } catch {
        // the hub itself is restarting; try again shortly
      }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [hub]);
  if (!hub) return null;

  const back = status?.online && !status.pending_sync;
  const failed = status?.last_sync.failed.length ?? 0;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 border-b px-4 py-2.5 text-sm lg:px-6 ${back ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-violet-200 bg-violet-50 text-violet-950'}`}
      role="status"
    >
      {back ? <Wifi className="size-4 shrink-0" /> : status?.online ? <RefreshCw className="size-4 shrink-0 animate-spin" /> : <Router className="size-4 shrink-0" />}
      <p className="min-w-0 flex-1">
        {back ? (
          <>
            <span className="font-semibold">{t('offline.back_title')}</span> {t('offline.back_body')}
          </>
        ) : status?.online ? (
          <>
            <span className="font-semibold">{t('offline.syncing_title')}</span> {t('offline.syncing_body')}
          </>
        ) : (
          <>
            <span className="font-semibold">{t('offline.hub_title')}</span> {t('offline.hub_body')}
          </>
        )}
        {failed > 0 && <span className="ml-1 font-medium text-rose-700">{t('offline.refused', { n: failed })}</span>}
      </p>
      {back && status?.web_url && (
        <Button size="sm" variant="success" onClick={() => (window.location.href = `${status.web_url}${window.location.pathname}`)}>
          {t('offline.return')}
        </Button>
      )}
    </div>
  );
}
