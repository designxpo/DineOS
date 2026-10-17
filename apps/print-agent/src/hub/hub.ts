// Outlet hub: the print agent plus a LAN copy of the outlet for internet outages.
//
//   online:  prints cloud jobs as usual, refreshes its snapshot every minute
//   offline: staff devices switch to http://<hub>:4100; orders, kitchen tickets, bills and
//            payments carry on, printed straight to the outlet's printers
//   back:    sends everything to the cloud (retrying until accepted), then follows the cloud again

import { batchSyncPayload, type HubSnapshot, type HubSyncResult } from '@dineos/shared/hub';
import type { FoundPrinter } from '@dineos/shared/print';
import { PrintAgent, type PrinterConfig, type Transport } from '../agent';
import { emptyState, HubEngine, type HubState } from './engine';
import { HubServer } from './server';
import { JsonStore } from './store';

export interface HubOptions {
  apiUrl: string;
  token: string;
  port: number;
  host?: string;
  /** JSON file holding the hub's state; null keeps it in memory (tests). */
  dataFile: string | null;
  webUpstream: string | null;
  printers?: Record<string, PrinterConfig>;
  transport?: Transport;
  discover?: () => Promise<FoundPrinter[]>;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  healthMs?: number;
  snapshotMs?: number;
  now?: () => Date;
}

export class OutletHub {
  readonly engine: HubEngine;
  readonly server: HubServer;
  readonly agent: PrintAgent;
  private readonly store: JsonStore<HubState>;
  private readonly log: (msg: string) => void;
  private readonly fetch: typeof fetch;
  private timers: NodeJS.Timeout[] = [];
  private agentStarted = false;
  private busy: Promise<void> | null = null;
  port = 0;

  constructor(private readonly opts: HubOptions) {
    this.log = opts.log ?? ((m) => console.log(`[outlet-hub] ${new Date().toISOString()} ${m}`));
    this.fetch = opts.fetch ?? fetch;
    this.store = new JsonStore<HubState>(opts.dataFile, emptyState);
    this.agent = new PrintAgent({ apiUrl: opts.apiUrl, token: opts.token, printers: opts.printers, transport: opts.transport, discover: opts.discover, log: this.log });
    let server: HubServer | null = null;
    this.engine = new HubEngine(this.store.load(), {
      now: opts.now,
      changed: () => this.store.save(this.engine.state),
      emit: (e) => server?.broadcast(e),
      print: (target, doc) => {
        const printers = Object.keys(this.agent.printerConfig).length ? this.agent.printerConfig : { ...this.engine.state.printers, ...(opts.printers ?? {}) };
        if (doc.kind === 'drawer' && !printers[target]?.drawer) return;
        this.agent.printLocal(target, doc, printers);
      },
    });
    server = new HubServer({
      engine: this.engine,
      webUpstream: opts.webUpstream,
      persist: () => this.store.save(this.engine.state),
      log: this.log,
      status: () => this.status(),
    });
    this.server = server;
  }

  status() {
    const s = this.engine.state;
    return {
      hub: true,
      outlet: s.snapshot ? { id: s.snapshot.outlet.id, name: s.snapshot.outlet.name } : null,
      online: this.engine.online,
      pending_sync: this.engine.hasPendingSync(),
      snapshot_at: s.snapshot?.generated_at ?? null,
      last_sync: s.sync,
      web_url: s.snapshot?.web_url ?? null,
    };
  }

  async start(): Promise<void> {
    this.port = await this.server.listen(this.opts.port, this.opts.host);
    this.log(`serving the outlet on port ${this.port}${this.engine.state.snapshot ? ` for ${this.engine.state.snapshot.outlet.name}` : ' (waiting for the first snapshot)'}`);
    await this.tick();
    this.timers.push(setInterval(() => void this.tick(), this.opts.healthMs ?? 10_000));
    this.timers.push(setInterval(() => void this.tick(true), this.opts.snapshotMs ?? 60_000));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.busy;
    await this.agent.stop();
    await this.server.close();
  }

  private async cloud<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const res = await this.fetch(`${this.opts.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** One pass of the cloud link; passes never overlap. */
  tick(refresh = false): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.link(refresh).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async link(refresh: boolean): Promise<void> {
    const was = this.engine.online;
    try {
      await this.cloud('GET', '/healthz', undefined, 4000);
      this.engine.online = true;
    } catch {
      this.engine.online = false;
      if (was) this.log('cloud unreachable: the hub now serves the outlet on the LAN');
      return;
    }
    if (!was) this.log('cloud reachable');
    // Printer changes made in the portal reach the agent while online; keep a copy for outages.
    if (this.agentStarted) this.engine.state.printers = this.agent.printerConfig;
    if (!this.agentStarted) {
      try {
        await this.agent.start();
        this.agentStarted = true;
        this.engine.state.printers = this.agent.printerConfig;
      } catch (err) {
        this.log(`print agent not started yet: ${(err as Error).message}`);
      }
    }
    try {
      if (this.engine.hasPendingSync()) await this.sync();
      if (refresh || !was || !this.engine.state.snapshot) {
        const snapshot = await this.cloud<HubSnapshot>('GET', '/v1/device/hub/snapshot');
        this.engine.applySnapshot(snapshot);
      }
    } catch (err) {
      this.engine.state.sync = { ...this.engine.state.sync, error: (err as Error).message };
      this.store.save(this.engine.state);
      this.log(`cloud link: ${(err as Error).message}`);
    }
  }

  /** Sends what changed offline. Accepted items are marked; refused ones stay listed in status. */
  async sync(): Promise<HubSyncResult> {
    const { payload, revs } = this.engine.buildSyncPayload();
    const result: HubSyncResult = { applied: { sessions: [], orders: [], bills: [], tables: [] }, failed: [] };
    // In batches small enough for hosted platforms' request limits, oldest visits first.
    for (const batch of batchSyncPayload(payload)) {
      let part: HubSyncResult;
      try {
        part = await this.cloud<HubSyncResult>('POST', '/v1/device/hub/sync', batch, 60_000);
      } catch (err) {
        // Keep what already landed; the rest goes on the next attempt.
        if (result.applied.sessions.length + result.applied.orders.length + result.applied.bills.length) this.engine.markSynced(result, revs);
        throw err;
      }
      for (const key of ['sessions', 'orders', 'bills', 'tables'] as const) result.applied[key].push(...part.applied[key]);
      result.failed.push(...part.failed);
    }
    this.engine.markSynced(result, revs);
    const n = result.applied.orders.length + result.applied.bills.length + result.applied.sessions.length;
    this.log(`synced ${n} change(s) to the cloud${result.failed.length ? `; ${result.failed.length} refused: ${result.failed.map((f) => f.message).join('; ')}` : ''}`);
    return result;
  }
}
