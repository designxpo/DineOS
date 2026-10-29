import type { Config } from '../config';

/** One event for Talko AI's rules engine: who it is about, and the fields its templates can use. */
export interface TalkoEvent {
  event: string;
  phone: string;
  name: string | null;
  data: Record<string, unknown>;
}

export type TalkoResult = { ok: true } | { ok: false; retry: boolean; rejected: boolean; error: string };

type TalkoConfig = Pick<Config, 'TALKO_API_URL' | 'NODE_ENV'>;

/**
 * Talko's address from the server config, never from a request: every tenant's events go to the one
 * Talko deployment we run, so a link cannot be pointed at another host to collect guests' numbers.
 * Null when unset, or when it is not https in production.
 */
export function talkoBase(cfg: TalkoConfig): string | null {
  if (!cfg.TALKO_API_URL) return null;
  const url = new URL(cfg.TALKO_API_URL);
  if (cfg.NODE_ENV === 'production' && url.protocol !== 'https:') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function call(cfg: TalkoConfig, path: string, apiKey: string, init: RequestInit, fetchFn: typeof fetch): Promise<Response | TalkoResult> {
  const base = talkoBase(cfg);
  if (!base) return { ok: false, retry: true, rejected: false, error: 'Talko AI is not set up on this server (TALKO_API_URL)' };
  try {
    return await fetchFn(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'user-agent': 'Mezmitra/1', ...init.headers },
      // A redirect could carry the key to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return { ok: false, retry: true, rejected: false, error: `Could not reach Talko AI: ${(err as Error).message}`.slice(0, 300) };
  }
}

async function outcome(res: Response): Promise<TalkoResult> {
  if (res.ok) return { ok: true };
  const text = (await res.text().catch(() => '')).slice(0, 200);
  const rejected = res.status === 401 || res.status === 403;
  const retry = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
  return {
    ok: false,
    retry,
    rejected,
    error: rejected ? 'Talko AI rejected the key: reconnect from Settings' : `Talko AI answered ${res.status}${text ? `: ${text}` : ''}`,
  };
}

/**
 * Posts one event to Talko's /api/events. The outbox row id is the Idempotency-Key, so a retry
 * after a lost response never sends the guest a second message.
 */
export async function sendTalkoEvent(cfg: TalkoConfig, apiKey: string, idempotencyKey: string, e: TalkoEvent, fetchFn: typeof fetch = fetch): Promise<TalkoResult> {
  const res = await call(
    cfg,
    '/api/events',
    apiKey,
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ event: e.event, phone: e.phone, ...(e.name ? { name: e.name } : {}), data: e.data }),
    },
    fetchFn,
  );
  return res instanceof Response ? outcome(res) : res;
}

/** Checks the stored key against Talko without sending anything to anyone. */
export async function pingTalko(cfg: TalkoConfig, apiKey: string, fetchFn: typeof fetch = fetch): Promise<TalkoResult> {
  const res = await call(cfg, '/api/integrations/mezmitra/ping', apiKey, { method: 'GET' }, fetchFn);
  return res instanceof Response ? outcome(res) : res;
}
