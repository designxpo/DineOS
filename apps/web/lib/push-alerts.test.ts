import { describe, expect, it } from 'vitest';
import { keyBytes } from './push-alerts';

describe('push key', () => {
  it('turns the base64url VAPID key into the bytes the Push API wants', () => {
    // A real P-256 public key is 65 bytes starting with 0x04.
    const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 37) % 256));
    const b64url = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect([...keyBytes(b64url)]).toEqual([...bytes]);
  });
});
