import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';

/** Object storage for menu photos and logos. Keys look like `{tenantId}/menu/{uuid}.jpg`. */
export interface Storage {
  /** Stores the object and returns the public URL to save on the record. */
  put(key: string, body: Buffer, contentType: string): Promise<string>;
}

/** Keys are made of ids and fixed folder names: letters, digits, '-', '_', '.' and '/' only. */
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function safeKey(key: string): string {
  const clean = normalize(key).replace(/^([/\\])+/, '');
  if (clean.split(sep).includes('..') || !KEY_SHAPE.test(clean.split(sep).join('/'))) throw new Error('invalid storage key');
  return clean;
}

/**
 * The file's path inside `baseDir`, or an error if the key would land anywhere else. Checked on
 * the resolved path, so no encoding or separator trick can step outside the storage folder.
 */
export function containedPath(baseDir: string, key: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, safeKey(key));
  if (!target.startsWith(base + sep)) throw new Error('invalid storage key');
  return target;
}

/** Only these are ever served from storage: menu photos and logos. */
const SERVED_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

class FsStorage implements Storage {
  constructor(
    private readonly dir: string,
    private readonly publicBase: string,
  ) {}

  async put(key: string, body: Buffer): Promise<string> {
    const clean = safeKey(key);
    const path = containedPath(this.dir, clean);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return `${this.publicBase}/files/${clean.split(sep).join('/')}`;
  }
}

class S3Storage implements Storage {
  constructor(private readonly config: Config) {}

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3' as string).catch(() => {
      throw new Error('STORAGE_DRIVER=s3 needs the @aws-sdk/client-s3 package installed');
    });
    const c = this.config;
    const client = new S3Client({
      endpoint: c.S3_ENDPOINT,
      region: c.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: c.S3_ACCESS_KEY ?? '', secretAccessKey: c.S3_SECRET_KEY ?? '' },
    });
    const clean = safeKey(key);
    await client.send(new PutObjectCommand({ Bucket: c.S3_BUCKET, Key: clean, Body: body, ContentType: contentType }));
    return `${c.S3_PUBLIC_URL ?? `${c.S3_ENDPOINT}/${c.S3_BUCKET}`}/${clean}`;
  }
}

export function createStorage(config: Config): Storage {
  return config.STORAGE_DRIVER === 's3'
    ? new S3Storage(config)
    : new FsStorage(config.storageDir, config.PUBLIC_API_URL);
}

/**
 * Serves fs-driver images. Keys contain random ids, so responses are cached for a year. Only
 * image files are served, with headers that stop a browser from running anything in them.
 */
export function registerFileRoute(app: FastifyInstance, config: Config): void {
  if (config.STORAGE_DRIVER !== 'fs') return;
  app.get('/files/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    let path: string;
    try {
      path = containedPath(config.storageDir, key);
    } catch {
      return reply.status(404).send();
    }
    const type = SERVED_TYPES[extname(path).toLowerCase()];
    if (!type) return reply.status(404).send();
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return reply.status(404).send();
    reply.header('content-type', type);
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    // Guest phones show menu photos from the web app, which may be on another subdomain.
    reply.header('cross-origin-resource-policy', 'cross-origin');
    return reply.send(createReadStream(path));
  });
}
