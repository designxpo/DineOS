import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';

/**
 * One JSON file, rewritten atomically (temp file, fsync, rename) after every change and before
 * the response goes out. A crash can never leave half a file, and a printed invoice number is on
 * disk before the guest gets the bill, so it is never reused.
 */
export class JsonStore<T> {
  constructor(
    private readonly path: string | null,
    private readonly fresh: () => T,
  ) {}

  load(): T {
    if (!this.path || !existsSync(this.path)) return this.fresh();
    const raw = readFileSync(this.path, 'utf8');
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Never start over silently: the file may hold bills that are not in the cloud yet.
      throw new Error(`${this.path} is not valid JSON. Move it away only after its bills are safe; the hub will then start fresh.`);
    }
  }

  save(data: T): void {
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // rename() replaces the old file atomically: readers see the old state or the new one.
    renameSync(tmp, this.path);
  }
}
