import { afterEach, describe, expect, it, vi } from 'vitest';
import { newKey } from './api';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('newKey', () => {
  it('works on plain http, where browsers leave out crypto.randomUUID (the outlet hub on the LAN)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const keys = new Set(Array.from({ length: 1000 }, () => newKey()));
    expect(keys.size).toBe(1000);
    for (const key of keys) expect(key).toMatch(V4);
  });

  it('uses crypto.randomUUID when the browser has it', () => {
    expect(newKey()).toMatch(V4);
  });
});
