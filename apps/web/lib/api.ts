import type { ApiErrorBody } from '@dineos/shared/dto';

/** The cloud API. Guest pages and uploads always use it. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE_KEY = 'dineos.api_base';

/**
 * Where staff requests go: the cloud, or the outlet hub while the internet is down. The hub
 * serves this app from its own LAN address and sets the base to it during the handoff; a value
 * left over from another address is ignored.
 */
export function apiBase(): string {
  if (typeof window === 'undefined') return API_URL;
  try {
    const raw = window.localStorage.getItem(BASE_KEY);
    const base = raw ? (JSON.parse(raw) as unknown) : null;
    if (typeof base === 'string' && base === window.location.origin) return base;
  } catch {
    // storage blocked: use the cloud
  }
  return API_URL;
}

/** True when this app is running from the outlet hub (offline mode). */
export function onHub(): boolean {
  return apiBase() !== API_URL;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The request never reached the server (offline, DNS, server down). Safe to retry with the same key. */
export class NetworkError extends Error {}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  approvalToken?: string | null;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.approvalToken) headers['x-approval-token'] = opts.approvalToken;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1${path}`, { method: opts.method ?? 'GET', headers, body, signal: opts.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError('No connection to the server');
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = (data as ApiErrorBody)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

/** Downloads a binary/text resource (PDF, CSV) with auth and returns an object URL. */
export async function apiBlobUrl(path: string, token: string): Promise<string> {
  const res = await fetch(`${apiBase()}/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status, 'download_failed', 'Download failed');
  return URL.createObjectURL(await res.blob());
}

export function newKey(): string {
  return crypto.randomUUID();
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  return 'Something went wrong';
}
