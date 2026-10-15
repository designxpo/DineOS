'use client';

// Short-offline support for POS, waiter and KDS screens (spec §2 "Offline behaviour").
// A mutation that cannot reach the server is stored in IndexedDB with its Idempotency-Key and
// replayed on reconnect; the server's idempotency table makes the replay safe.

import { createStore, del, entries, set } from 'idb-keyval';
import { ApiError, apiFetch, NetworkError, newKey, type RequestOptions } from './api';

export interface QueuedRequest {
  key: string;
  path: string;
  method: NonNullable<RequestOptions['method']>;
  body?: unknown;
  label: string;
  queuedAt: number;
}

const store = typeof indexedDB !== 'undefined' ? createStore('dineos-outbox', 'requests') : null;
const listeners = new Set<(n: number) => void>();

async function count(): Promise<number> {
  return store ? (await entries(store)).length : 0;
}

async function notify() {
  const n = await count();
  for (const l of listeners) l(n);
}

export function onOutboxChange(fn: (n: number) => void): () => void {
  listeners.add(fn);
  void count().then(fn);
  return () => listeners.delete(fn);
}

export type SendResult<T> = { queued: false; data: T } | { queued: true };

/**
 * Sends a mutation now, or queues it if the network is down. Server errors (validation, conflict)
 * are thrown as usual: only "could not reach the server" is queued.
 */
export async function send<T>(
  token: string,
  path: string,
  opts: { method: QueuedRequest['method']; body?: unknown; label: string; approvalToken?: string | null },
): Promise<SendResult<T>> {
  const key = newKey();
  try {
    const data = await apiFetch<T>(path, { method: opts.method, body: opts.body, token, idempotencyKey: key, approvalToken: opts.approvalToken });
    return { queued: false, data };
  } catch (err) {
    if (!(err instanceof NetworkError) || !store || opts.approvalToken) throw err;
    await set(key, { key, path, method: opts.method, body: opts.body, label: opts.label, queuedAt: Date.now() } satisfies QueuedRequest, store);
    await notify();
    return { queued: true };
  }
}

let flushing = false;

/** Replays queued requests in the order they were made. Stops at the first network failure. */
export async function flush(token: string): Promise<{ sent: number; failed: { label: string; message: string }[] }> {
  if (!store || flushing) return { sent: 0, failed: [] };
  flushing = true;
  const failed: { label: string; message: string }[] = [];
  let sent = 0;
  try {
    const queued = (await entries<string, QueuedRequest>(store)).map(([, v]) => v).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const req of queued) {
      try {
        await apiFetch(req.path, { method: req.method, body: req.body, token, idempotencyKey: req.key });
        await del(req.key, store);
        sent++;
      } catch (err) {
        if (err instanceof NetworkError) break;
        // The server refused it (e.g. the order was cancelled meanwhile): drop it and tell staff.
        await del(req.key, store);
        failed.push({ label: req.label, message: err instanceof ApiError ? err.message : 'Failed' });
      }
    }
  } finally {
    flushing = false;
    await notify();
  }
  return { sent, failed };
}
