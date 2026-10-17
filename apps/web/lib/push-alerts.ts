// Push alerts on a staff phone (new orders to accept, waiter calls, bill requests) while Mezmitra is
// closed. The service worker shows them; the API decides who gets what.

type Send = (path: string, opts?: { method?: 'POST' | 'DELETE'; body?: unknown }) => Promise<unknown>;

export type PushState = 'unsupported' | 'needs_install' | 'blocked' | 'off' | 'on';

/** The VAPID public key comes base64url-encoded; the Push API wants bytes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return 'serviceWorker' in navigator ? navigator.serviceWorker.getRegistration() : undefined;
}

export async function pushState(): Promise<PushState> {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iPhones get push only in the app added to the Home Screen (iOS 16.4 and later).
    const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
    return /iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone ? 'needs_install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  const sub = await (await registration())?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

export async function turnOnPush(send: Send, outletId: string): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('Alerts need the installed app. Reload Mezmitra and try again.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Allow notifications for Mezmitra in your browser settings');
  const { public_key } = (await send('/push/config')) as { public_key: string };
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(public_key) }));
  const json = sub.toJSON();
  await send('/push/subscriptions', { method: 'POST', body: { outlet_id: outletId, endpoint: json.endpoint, keys: json.keys } });
}

export async function turnOffPush(send: Send): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await send('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}
