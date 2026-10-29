import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const SCRYPT = { N: 16384, r: 8, p: 1 };

/** scrypt$N$r$p$salt$hash, all base64url. Built-in crypto only, no native modules. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(secret, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

/** Opaque bearer token. The prefix tells the auth layer what kind of principal it is. */
export function randomToken(prefix: 'st' | 'gt' | 'dv' | 'ad' | 'ap' | 'mzk'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(secret: string, purpose: string, data: Buffer): Buffer {
  return createHmac('sha256', secret).update(purpose).update('\0').update(data).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const SECRET_VERSION = 'v1';
const secretKeys = new Map<string, Buffer>();

function secretKey(master: string): Buffer {
  let key = secretKeys.get(master);
  if (!key) {
    // scrypt only maps an already strong secret to 32 bytes; the salt names the purpose.
    key = scryptSync(master, 'mezmitra:integration-secret:v1', 32);
    secretKeys.set(master, key);
  }
  return key;
}

/**
 * Encrypts a secret we must be able to read back (another product's API key), AES-256-GCM.
 * `context` is bound in as associated data (e.g. "link:<id>:peer_api_key"), so a value copied into
 * another row or column fails to decrypt. Output: v1:<iv>:<tag>:<ciphertext>, base64url.
 */
export function encryptSecret(master: string, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(master), iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [SECRET_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

/** Reverses encryptSecret. Throws when the key, the context or the value is wrong. */
export function decryptSecret(master: string, blob: string, context: string): string {
  const [version, iv, tag, ct] = blob.split(':');
  if (version !== SECRET_VERSION || !iv || !tag || ct === undefined) throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(master), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
