// localStorage that never throws (private mode, blocked storage). Where Safari or a content blocker
// refuses it, the value falls back to sessionStorage and then to memory, so signing in still works
// for the open tab; it just will not survive closing it.

const memory = new Map<string, string>();

/** Storage areas to try in order, skipping any this browser will not let the page use. */
function areas(): Storage[] {
  const found: Storage[] = [];
  for (const get of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      const area = get();
      area.getItem('mezmitra.probe');
      found.push(area);
    } catch {
      // blocked: try the next
    }
  }
  return found;
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    let raw: string | null = null;
    for (const area of areas()) {
      raw = area.getItem(key);
      if (raw) break;
    }
    raw ??= memory.get(key) ?? null;
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  const remove = value === null || value === undefined;
  const text = remove ? '' : JSON.stringify(value);
  if (remove) memory.delete(key);
  else memory.set(key, text);
  for (const area of areas()) {
    try {
      if (remove) area.removeItem(key);
      else area.setItem(key, text);
    } catch {
      // full or refused: the in-memory copy still holds it
    }
  }
}
