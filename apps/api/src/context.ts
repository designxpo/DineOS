import type { FastifyBaseLogger } from 'fastify';
import { sql, type Transaction } from 'kysely';
import type { Channel, EventType, OutletEvent } from '@dineos/shared/events';
import type { Config } from './config';
import { createDb, json, type Database, type DB } from './db';
import { EventBus } from './lib/bus';
import { webPushSender, type PushSender } from './lib/push';
import { msg91Sender, type OtpSender } from './lib/sms';
import { createStorage, type Storage } from './lib/storage';

export interface EmitInput {
  outletId: string;
  type: EventType;
  channels: Channel[];
  payload: unknown;
}

/** A tenant-scoped database transaction. Every query inside it is filtered by row-level security. */
export interface Tx {
  db: Transaction<DB>;
  tenantId: string;
  /**
   * Records an outlet event in the outbox and returns its sequence number. The event is pushed to
   * sockets only after commit. Takes a row lock on the outlet until commit, so emit late in the
   * transaction.
   */
  emit(event: EmitInput): Promise<number>;
  /** Runs after a successful commit (never on rollback). Errors are logged, not thrown. */
  afterCommit(fn: () => unknown): void;
}

export interface AppContext {
  config: Config;
  /** dineos_app: subject to RLS. Only use through tx(). */
  db: Database;
  /** dineos_admin: bypasses RLS. Platform admin routes, auth bootstrap and background jobs only. */
  adminDb: Database;
  bus: EventBus;
  storage: Storage;
  /** Delivers loyalty codes by SMS; null until MSG91 is set up. Tests swap in a fake. */
  otp: OtpSender | null;
  /** Web Push to staff phones; null until VAPID keys are set. Tests swap in a fake. */
  push: PushSender | null;
  log: FastifyBaseLogger;
  tx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Staff screens connected to an outlet right now (set once realtime is attached). */
  presence?: (tenantId: string, outletId: string) => Promise<number>;
}

export function createContext(config: Config, log: FastifyBaseLogger): AppContext {
  const db = createDb(config.DATABASE_URL, 20);
  const adminDb = createDb(config.DATABASE_ADMIN_URL, 5);
  const bus = new EventBus();
  const storage = createStorage(config);

  async function tx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const events: OutletEvent[] = [];
    const hooks: (() => unknown)[] = [];
    const result = await db.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      const scoped: Tx = {
        db: trx,
        tenantId,
        async emit(e) {
          const { event_seq } = await trx
            .updateTable('outlets')
            .set((eb) => ({ event_seq: eb('event_seq', '+', 1) }))
            .where('id', '=', e.outletId)
            .returning('event_seq')
            .executeTakeFirstOrThrow();
          const at = new Date();
          await trx
            .insertInto('outlet_events')
            .values({
              tenant_id: tenantId,
              outlet_id: e.outletId,
              seq: event_seq,
              type: e.type,
              channels: e.channels,
              payload: json(e.payload),
              created_at: at,
            })
            .execute();
          events.push({
            outlet_id: e.outletId,
            seq: event_seq,
            type: e.type,
            channels: e.channels,
            payload: e.payload,
            at: at.toISOString(),
          });
          return event_seq;
        },
        afterCommit(fn) {
          hooks.push(fn);
        },
      };
      return fn(scoped);
    });
    if (events.length) bus.publish(tenantId, events);
    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        log.error({ err }, 'afterCommit hook failed');
      }
    }
    return result;
  }

  return {
    config,
    db,
    adminDb,
    bus,
    storage,
    otp: config.MSG91_AUTH_KEY && config.MSG91_OTP_TEMPLATE_ID ? msg91Sender({ authKey: config.MSG91_AUTH_KEY, templateId: config.MSG91_OTP_TEMPLATE_ID }) : null,
    push:
      config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
        ? webPushSender({ publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: config.VAPID_SUBJECT })
        : null,
    log,
    tx,
    async close() {
      await Promise.all([db.destroy(), adminDb.destroy()]);
    },
  };
}
