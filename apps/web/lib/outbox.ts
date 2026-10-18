'use client';

// Short-offline support for POS, waiter and KDS screens (spec §2 "Offline behaviour").
// A mutation that cannot reach the server is stored in IndexedDB with its Idempotency-Key and
// replayed on reconnect; the server's idempotency table makes the replay safe.

import { createStore, del, entries, set } from 'idb-keyval';
import { ApiError, apiFetch, NetworkError, newKey, type RequestOptions } from './api';
import { moveLegacyStore } from './legacy-names';

export interface QueuedRequest {
  key: string;
  path: string;
  method: NonNullable<RequestOptions['method']>;
  body?: unknown;
  label: string;
  queuedAt: number;
  /** The session that made the change, so a shared tablet replays it as the right person. */
  token?: string;
}

/** A queued change the server refused on replay; kept until someone has seen it. */
export interface RejectedRequest {
  key: string;
  label: string;
  message: string;
  queuedAt: number;
  rejectedAt: number;
}

/** A queued change that reached the server after the connection came back. */
export interface SentRequest {
  key: string;
  label: string;
  queuedAt: number;
  sentAt: number;
}

export interface OutboxState {
  pending: number;
  rejected: number;
  /** Queued changes sent in the last day: staff check the counts match after an outage. */
  sent: number;
}

const SENT_KEPT_MS = 86_400_000;

const idb = typeof indexedDB !== 'undefined';
const store = idb ? createStore('mezmitra-outbox', 'requests') : null;
const rejectedStore = idb ? createStore('mezmitra-outbox-rejected', 'requests') : null;
const sentStore = idb ? createStore('mezmitra-outbox-sent', 'requests') : null;
// Changes queued under the product's earlier name move over before anything reads or sends them.
const moved = Promise.all([moveLegacyStore('dineos-outbox', 'requests', store), moveLegacyStore('dineos-outbox-rejected', 'requests', rejectedStore)]);
const listeners = new Set<(s: OutboxState) => void>();

async function state(): Promise<OutboxState> {
  await moved;
  return {
    pending: store ? (await entries(store)).length : 0,
    rejected: rejectedStore ? (await entries(rejectedStore)).length : 0,
    sent: (await listSent()).length,
  };
}

async function notify() {
  const s = await state();
  for (const l of listeners) l(s);
}

export function onOutboxChange(fn: (s: OutboxState) => void): () => void {
  listeners.add(fn);
  void state().then(fn);
  return () => listeners.delete(fn);
}

export async function listQueued(): Promise<QueuedRequest[]> {
  if (!store) return [];
  await moved;
  return (await entries<string, QueuedRequest>(store)).map(([, v]) => v).sort((a, b) => a.queuedAt - b.queuedAt);
}

export async function listRejected(): Promise<RejectedRequest[]> {
  if (!rejectedStore) return [];
  await moved;
  return (await entries<string, RejectedRequest>(rejectedStore)).map(([, v]) => v).sort((a, b) => b.rejectedAt - a.rejectedAt);
}

/** Queued changes sent in the last day, newest first; older ones are forgotten. */
export async function listSent(): Promise<SentRequest[]> {
  if (!sentStore) return [];
  const cutoff = Date.now() - SENT_KEPT_MS;
  const all = (await entries<string, SentRequest>(sentStore)).map(([, v]) => v);
  for (const old of all.filter((s) => s.sentAt < cutoff)) await del(old.key, sentStore);
  return all.filter((s) => s.sentAt >= cutoff).sort((a, b) => b.sentAt - a.sentAt);
}

/** Drops a queued change without sending it. */
export async function discard(key: string): Promise<void> {
  await moved;
  if (store) await del(key, store);
  await notify();
}

export async function dismissRejected(key?: string): Promise<void> {
  if (!rejectedStore) return;
  await moved;
  for (const r of key ? [{ key }] : await listRejected()) await del(r.key, rejectedStore);
  await notify();
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
    // Manager approvals are short-lived and single-use, so those actions are never queued.
    if (!(err instanceof NetworkError) || !store || opts.approvalToken) throw err;
    await moved;
    await set(key, { key, path, method: opts.method, body: opts.body, label: opts.label, queuedAt: Date.now(), token } satisfies QueuedRequest, store);
    await notify();
    return { queued: true };
  }
}

let flushing = false;

/** Replays queued requests in the order they were made. Stops at the first network failure. */
export async function flush(token: string): Promise<{ sent: number; failed: { label: string; message: string }[] }> {
  if (!store || flushing) return { sent: 0, failed: [] };
  flushing = true;
  await moved;
  const failed: { label: string; message: string }[] = [];
  let sent = 0;
  try {
    for (const req of await listQueued()) {
      try {
        await apiFetch(req.path, { method: req.method, body: req.body, token: req.token ?? token, idempotencyKey: req.key });
        await del(req.key, store);
        if (sentStore) await set(req.key, { key: req.key, label: req.label, queuedAt: req.queuedAt, sentAt: Date.now() } satisfies SentRequest, sentStore);
        sent++;
      } catch (err) {
        if (err instanceof NetworkError) break;
        // The server refused it (e.g. the order was cancelled meanwhile): keep it visible to staff.
        const message = err instanceof ApiError ? err.message : 'Failed';
        await del(req.key, store);
        if (rejectedStore) await set(req.key, { key: req.key, label: req.label, message, queuedAt: req.queuedAt, rejectedAt: Date.now() } satisfies RejectedRequest, rejectedStore);
        failed.push({ label: req.label, message });
      }
    }
  } finally {
    flushing = false;
    await notify();
  }
  return { sent, failed };
}
