/**
 * A small in-memory cache with a time limit per entry and a hard cap on size, so no amount of
 * traffic can make it grow without bound. Expired entries are swept at most once per TTL; past
 * the cap, the oldest entries go first (a Map keeps insertion order).
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; at: number }>();
  private lastSweep = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  get(key: string, now = Date.now()): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    if (now - this.lastSweep > this.ttlMs) {
      this.lastSweep = now;
      for (const [k, entry] of this.map) if (now - entry.at >= this.ttlMs) this.map.delete(k);
    }
    this.map.delete(key);
    this.map.set(key, { value, at: now });
    for (const k of this.map.keys()) {
      if (this.map.size <= this.max) break;
      this.map.delete(k);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
