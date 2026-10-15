import type { OutletEvent } from '@dineos/shared/events';

export type BusListener = (tenantId: string, events: readonly OutletEvent[]) => void;

/**
 * In-process fan-out of committed outlet events. The realtime hub subscribes and forwards to
 * Socket.IO rooms (and through the Redis adapter to other nodes). Tests subscribe directly.
 */
export class EventBus {
  private listeners = new Set<BusListener>();

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(tenantId: string, events: readonly OutletEvent[]): void {
    for (const listener of this.listeners) {
      try {
        listener(tenantId, events);
      } catch {
        // a broken listener must not stop delivery to the others
      }
    }
  }
}
