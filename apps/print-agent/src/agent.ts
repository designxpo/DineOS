import { createConnection } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import type { OutletEvent } from '@dineos/shared/events';
import type { PrintDoc, PrintJobDTO } from '@dineos/shared/print';
import { render } from './render';

export interface PrinterConfig {
  address: string;
  width: 32 | 42 | 48;
}

export type Transport = (address: string, bytes: Buffer) => Promise<void>;

/** Sends raw bytes to a network printer (port 9100, "RAW"/JetDirect). */
export const tcpTransport: Transport = (address, bytes) =>
  new Promise((resolve, reject) => {
    const [host, port] = address.split(':');
    const socket = createConnection({ host: host!, port: Number(port ?? 9100) });
    socket.setTimeout(8000);
    socket.on('timeout', () => socket.destroy(new Error(`printer ${address} timed out`)));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(bytes));
    socket.on('close', (hadError) => (hadError ? undefined : resolve()));
  });

export interface AgentOptions {
  apiUrl: string;
  token: string;
  transport?: Transport;
  /** Local overrides, merged over the printers configured in the portal. */
  printers?: Record<string, PrinterConfig>;
  log?: (msg: string) => void;
  pollMs?: number;
}

/**
 * Keeps an outbound connection to DineOS, prints jobs as they arrive and acknowledges them.
 * The REST poll on (re)connect and on a timer catches anything missed while offline.
 */
export class PrintAgent {
  private socket: Socket | null = null;
  private printers: Record<string, PrinterConfig> = {};
  private seen = new Set<string>();
  private queues = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private readonly transport: Transport;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: AgentOptions) {
    this.transport = opts.transport ?? tcpTransport;
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
    const me = await this.api<{ name: string; outlet_name: string; config: { printers?: Record<string, PrinterConfig> } }>('GET', '/device/me');
    this.printers = { ...(me.config.printers ?? {}), ...(this.opts.printers ?? {}) };
    this.log(`connected as "${me.name}" for ${me.outlet_name}; printers: ${Object.entries(this.printers).map(([t, p]) => `${t}=${p.address}`).join(', ') || 'none'}`);

    this.socket = io(`${this.opts.apiUrl}/device`, { auth: { token: this.opts.token }, transports: ['websocket'], reconnectionDelayMax: 10_000 });
    this.socket.on('connect', () => {
      this.log('realtime connected');
      void this.poll();
    });
    this.socket.on('disconnect', (reason) => this.log(`realtime disconnected (${reason})`));
    this.socket.on('event', (event: OutletEvent<PrintJobDTO>) => {
      if (event.type === 'print.job' && event.payload?.doc) this.enqueue(event.payload);
    });

    this.timers.push(setInterval(() => void this.poll(), this.opts.pollMs ?? 30_000));
    this.timers.push(setInterval(() => void this.api('POST', '/device/heartbeat').catch(() => {}), 60_000));
  }

  async stop(): Promise<void> {
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
        await this.transport(printer.address, render(doc, printer.width ?? 48).build());
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
      const doc = render(job.doc, printer.width ?? 48);
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
