import { hostname } from 'node:os';
import { io, type Socket } from 'socket.io-client';
import type { OutletEvent } from '@dineos/shared/events';
import type { FoundPrinter, PrintDoc, PrinterConfig, PrintJobDTO } from '@dineos/shared/print';
import { render } from './render';
import { defaultTransport, type Transport } from './transports';
import { AGENT_VERSION } from './version';

export type { PrinterConfig } from '@dineos/shared/print';
export type { Transport } from './transports';

/** How often the agent looks for printers again, besides at start and when the portal asks. */
const DISCOVER_EVERY_MS = 6 * 3600_000;
/** Without the live link (some hosts cannot keep one open) the agent asks for jobs this often. */
const FAST_POLL_MS = 5_000;
/** How often printer changes are re-read, besides when the portal says so. */
const REFRESH_MS = 30_000;

export interface AgentOptions {
  apiUrl: string;
  token: string;
  transport?: Transport;
  /** Local overrides, merged over the printers configured in the portal. */
  printers?: Record<string, PrinterConfig>;
  log?: (msg: string) => void;
  pollMs?: number;
  /** Finds the printers this computer can reach, for the portal's printer picker. */
  discover?: () => Promise<FoundPrinter[]>;
}

interface DeviceMe {
  id: string;
  name: string;
  outlet_name: string;
  config: { printers?: Record<string, PrinterConfig> };
  /** The site's address, for the "follow your order" link on counter receipts. */
  web_origin?: string | null;
}

/**
 * Keeps an outbound connection to Mezmitra, prints jobs as they arrive and acknowledges them.
 * The REST poll on (re)connect and on a timer catches anything missed while offline, and picks up
 * printer changes made in the portal.
 */
export class PrintAgent {
  private socket: Socket | null = null;
  private deviceId: string | null = null;
  private webOrigin: string | null = null;
  private printers: Record<string, PrinterConfig> = {};
  private discovering: Promise<void> | null = null;
  private seen = new Set<string>();
  private queues = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly transport: Transport;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: AgentOptions) {
    this.transport = opts.transport ?? defaultTransport;
    this.log = opts.log ?? ((m) => console.log(`[print-agent] ${new Date().toISOString()} ${m}`));
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.opts.apiUrl}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async start(): Promise<void> {
    await this.refresh();

    this.socket = io(`${this.opts.apiUrl}/device`, { auth: { token: this.opts.token }, transports: ['websocket'], reconnectionDelayMax: 10_000 });
    this.socket.on('connect', () => {
      this.log('realtime connected');
      void this.poll();
    });
    this.socket.on('disconnect', (reason) => this.log(`realtime disconnected (${reason})`));
    this.socket.on('event', (event: OutletEvent) => {
      if (event.type === 'print.job' && (event.payload as PrintJobDTO | undefined)?.doc) this.enqueue(event.payload as PrintJobDTO);
      if (event.type === 'device.command') {
        const { device_id, command } = event.payload as { device_id: string | null; command: 'reload' | 'scan' };
        if (device_id && device_id !== this.deviceId) return;
        if (command === 'reload') void this.refresh().catch((err) => this.log(`could not reload printers: ${(err as Error).message}`));
        if (command === 'scan') void this.discover();
      }
    });

    this.schedulePoll();
    this.timers.push(setInterval(() => void this.refresh().catch(() => {}), REFRESH_MS));
    this.timers.push(setInterval(() => void this.api('POST', '/device/heartbeat').catch(() => {}), 60_000));
    if (this.opts.discover) {
      void this.discover();
      this.timers.push(setInterval(() => void this.discover(), DISCOVER_EVERY_MS));
    }
  }

  /** Reads this device's printers from the portal; local overrides win. */
  async refresh(): Promise<void> {
    const me = await this.api<DeviceMe>('GET', '/device/me');
    const first = this.deviceId === null;
    this.deviceId = me.id;
    this.webOrigin = me.web_origin ?? null;
    const next = { ...(me.config.printers ?? {}), ...(this.opts.printers ?? {}) };
    if (first || JSON.stringify(next) !== JSON.stringify(this.printers)) {
      this.printers = next;
      const list = Object.entries(next).map(([t, p]) => `${t}=${p.address}`).join(', ') || 'none';
      this.log(first ? `connected as "${me.name}" for ${me.outlet_name}; printers: ${list}` : `printers updated: ${list}`);
    }
  }

  /** Looks for printers and tells the portal what it found. One search at a time. */
  discover(): Promise<void> {
    const find = this.opts.discover;
    if (!find) return Promise.resolve();
    this.discovering ??= (async () => {
      try {
        const printers = await find();
        await this.api('POST', '/device/report', { version: AGENT_VERSION, platform: `${process.platform} ${process.arch}`, hostname: hostname(), printers });
        this.log(`found ${printers.length} printer${printers.length === 1 ? '' : 's'}${printers.length ? `: ${printers.map((p) => p.address).join(', ')}` : ''}`);
      } catch (err) {
        this.log(`printer search failed: ${(err as Error).message}`);
      } finally {
        this.discovering = null;
      }
    })();
    return this.discovering;
  }

  /** Polls slowly while the live link delivers jobs, and every few seconds while it is down. */
  private schedulePoll(): void {
    if (this.stopped) return;
    const slow = this.opts.pollMs ?? 30_000;
    const delay = this.socket?.connected ? slow : Math.min(slow, FAST_POLL_MS);
    this.pollTimer = setTimeout(() => void this.poll().finally(() => this.schedulePoll()), delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const t of this.timers) clearInterval(t);
    this.socket?.close();
    await Promise.allSettled([...this.queues.values()]);
  }

  async poll(): Promise<void> {
    try {
      const jobs = await this.api<PrintJobDTO[]>('GET', '/device/print-jobs');
      for (const job of jobs) this.enqueue(job);
    } catch (err) {
      this.log(`poll failed: ${(err as Error).message}`);
    }
  }

  /** Jobs for one printer print in order; different printers work in parallel. */
  enqueue(job: PrintJobDTO): void {
    if (this.seen.has(job.id)) return;
    this.seen.add(job.id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-1000));
    const key = this.printers[job.target]?.address ?? `none:${job.target}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.handle(job));
    this.queues.set(key, next);
  }

  /** Printer map from the portal (and local overrides), once start() has reached the cloud. */
  get printerConfig(): Record<string, PrinterConfig> {
    return this.printers;
  }

  /**
   * Prints a document the outlet hub made while offline. Same per-printer queue as cloud jobs,
   * nothing to acknowledge.
   */
  printLocal(target: string, doc: PrintDoc, printers: Record<string, PrinterConfig> = this.printers): void {
    const printer = printers[target] ?? printers.default;
    const key = printer?.address ?? `none:${target}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        if (!printer) throw new Error(`no printer configured for "${target}"`);
        await this.transport(printer.address, render(doc, printer.width ?? 48, { webOrigin: this.webOrigin }).build());
        this.log(`printed offline ${doc.kind} on ${target}`);
      } catch (err) {
        this.log(`offline ${doc.kind} for ${target} failed: ${(err as Error).message}`);
      }
    });
    this.queues.set(key, next);
  }

  /** Resolves when everything queued so far has been handled (used by tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }

  private async handle(job: PrintJobDTO): Promise<void> {
    const printer = this.printers[job.target] ?? this.printers.default;
    try {
      if (!printer) throw new Error(`no printer configured for "${job.target}"`);
      const doc = render(job.doc, printer.width ?? 48, { webOrigin: this.webOrigin });
      await this.transport(printer.address, doc.build());
      await this.api('POST', `/device/print-jobs/${job.id}/ack`, { status: 'printed' });
      this.log(`printed ${job.kind} ${job.id} on ${job.target}`);
    } catch (err) {
      const message = (err as Error).message;
      this.log(`job ${job.id} failed: ${message}`);
      this.seen.delete(job.id); // let a later poll retry it
      await this.api('POST', `/device/print-jobs/${job.id}/ack`, { status: 'failed', error: message }).catch(() => {});
    }
  }
}
