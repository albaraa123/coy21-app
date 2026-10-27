//
// Simple hashed-random-token scheme for the cafeteria credential —
// deliberately NOT the attendance system's envelope-encrypted scheme
// (src/lib/attendance/qr-token-crypto.ts, scoped to the rcoy:v1: format).
// Lunch risk is "a stolen free lunch," not identity fraud, so there's no
// need for AES-GCM/key-rotation machinery here. The raw token is still
// never persisted in plaintext (only its SHA-256 hash is stored),
// mirroring the attendance system's "never persist the raw bearer
// credential" rule even without reusing its encryption layer.
import { randomBytes, createHash } from 'node:crypto';

export const CAFETERIA_PAYLOAD_PREFIX = 'cafe:v1:';
const RAW_TOKEN_BYTES = 32;
const TOKEN_TEXT_LENGTH = 43; // base64url, unpadded, 32 raw bytes
const BASE64URL_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_TEXT_LENGTH}}$`);

export function generateCafeteriaToken(): { rawToken: Buffer; payload: string } {
  const rawToken = randomBytes(RAW_TOKEN_BYTES);
  return { rawToken, payload: canonicalEncodeCafeteriaToken(rawToken) };
}

export function canonicalEncodeCafeteriaToken(rawToken: Buffer): string {
  if (rawToken.length !== RAW_TOKEN_BYTES) throw new Error('rawToken must be 32 bytes');
  return CAFETERIA_PAYLOAD_PREFIX + rawToken.toString('base64url');
}

export function hashCafeteriaToken(rawToken: Buffer): Buffer {
  return createHash('sha256').update(rawToken).digest();
}

export function parseCanonicalCafeteriaPayload(payload: string): { ok: true; rawToken: Buffer } | { ok: false } {
  if (!payload.startsWith(CAFETERIA_PAYLOAD_PREFIX)) return { ok: false };
  const tokenText = payload.slice(CAFETERIA_PAYLOAD_PREFIX.length);
  if (!BASE64URL_PATTERN.test(tokenText)) return { ok: false };
  return { ok: true, rawToken: Buffer.from(tokenText, 'base64url') };
}
