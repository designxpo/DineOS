// Signed, stateless tokens for table QR codes and guest phones (spec §6).
// Binary-packed so the printed QR stays small, signed with HMAC-SHA256 under separate purposes.

import { hmac, safeEqual } from './crypto';

function uuidToBytes(id: string): Buffer {
  const hex = id.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`invalid uuid ${id}`);
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function seal(secret: string, purpose: string, body: Buffer, sigLen: number): string {
  const sig = hmac(secret, purpose, body).subarray(0, sigLen);
  return Buffer.concat([body, sig]).toString('base64url');
}

function open(secret: string, purpose: string, token: string, bodyLen: number, sigLen: number): Buffer | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  if (raw.length !== bodyLen + sigLen) return null;
  const body = raw.subarray(0, bodyLen);
  const expected = hmac(secret, purpose, body).subarray(0, sigLen);
  return safeEqual(raw.subarray(bodyLen), expected) ? body : null;
}

// ---------------------------------------------------------------- table QR

export interface QrClaims {
  tenantId: string;
  outletId: string;
  tableId: string;
  /** Must equal tables.qr_token_version; bumping the column kills every printed copy. */
  version: number;
}

const QR_BODY = 1 + 16 * 3 + 2;
const QR_SIG = 12;

export function signQrToken(secret: string, c: QrClaims): string {
  const body = Buffer.alloc(QR_BODY);
  body.writeUInt8(1, 0);
  uuidToBytes(c.tenantId).copy(body, 1);
  uuidToBytes(c.outletId).copy(body, 17);
  uuidToBytes(c.tableId).copy(body, 33);
  body.writeUInt16BE(c.version, 49);
  return seal(secret, 'table-qr', body, QR_SIG);
}

export function verifyQrToken(secret: string, token: string): QrClaims | null {
  const body = open(secret, 'table-qr', token, QR_BODY, QR_SIG);
  if (!body || body.readUInt8(0) !== 1) return null;
  return {
    tenantId: bytesToUuid(body.subarray(1, 17)),
    outletId: bytesToUuid(body.subarray(17, 33)),
    tableId: bytesToUuid(body.subarray(33, 49)),
    version: body.readUInt16BE(49),
  };
}

// ---------------------------------------------------------------- guest phone

export interface GuestClaims {
  tenantId: string;
  outletId: string;
  tableId: string;
  sessionId: string;
  deviceId: string;
  issuedAt: number;
}

const GUEST_BODY = 1 + 16 * 5 + 4;
const GUEST_SIG = 16;
export const GUEST_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export function signGuestToken(secret: string, c: Omit<GuestClaims, 'issuedAt'>, now = Date.now()): string {
  const body = Buffer.alloc(GUEST_BODY);
  body.writeUInt8(2, 0);
  uuidToBytes(c.tenantId).copy(body, 1);
  uuidToBytes(c.outletId).copy(body, 17);
  uuidToBytes(c.tableId).copy(body, 33);
  uuidToBytes(c.sessionId).copy(body, 49);
  uuidToBytes(c.deviceId).copy(body, 65);
  body.writeUInt32BE(Math.floor(now / 1000), 81);
  return `gt_${seal(secret, 'guest', body, GUEST_SIG)}`;
}

/** Checks signature and age only. Callers must still check that the session is not closed. */
export function verifyGuestToken(secret: string, token: string, now = Date.now()): GuestClaims | null {
  if (!token.startsWith('gt_')) return null;
  const body = open(secret, 'guest', token.slice(3), GUEST_BODY, GUEST_SIG);
  if (!body || body.readUInt8(0) !== 2) return null;
  const issuedAt = body.readUInt32BE(81);
  if (now / 1000 - issuedAt > GUEST_TOKEN_TTL_SECONDS) return null;
  return {
    tenantId: bytesToUuid(body.subarray(1, 17)),
    outletId: bytesToUuid(body.subarray(17, 33)),
    tableId: bytesToUuid(body.subarray(33, 49)),
    sessionId: bytesToUuid(body.subarray(49, 65)),
    deviceId: bytesToUuid(body.subarray(65, 81)),
    issuedAt,
  };
}
