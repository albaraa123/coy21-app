// src/lib/attendance/qr-token-crypto.ts
//
// The ONLY module in this codebase permitted to generate/encode/hash/
// encrypt/decrypt raw QR token bytes. Implements the canonical contract in
// docs/superpowers/specs/2026-08-12-qr-token-format-and-lifecycle.md — do
// not change any byte-layout/encoding/hash-input decision here without
// updating that document first, since it is the source of truth, not this
// file's comments.
//
// Server-only by convention: never imported from a 'use client' file. This
// project has no `server-only` package installed (verified via `npm ls
// server-only`, matching the existing note in
// src/lib/agenda/server-helpers.ts) so there is no import-time guard beyond
// that convention — every caller of this module must itself only be
// reachable from 'use server' action files.
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export const QR_PAYLOAD_PREFIX = 'rcoy:v1:';
export const QR_TOKEN_TEXT_LENGTH = 43; // base64url, unpadded, 32 raw bytes
export const QR_TOKEN_VERSION = 1; // qr_credentials.token_version — the token FORMAT version, matching rcoy:v1

const RAW_TOKEN_BYTES = 32;
const ENVELOPE_VERSION_BYTE = 1;
const ENVELOPE_NONCE_BYTES = 12;
const ENVELOPE_CIPHERTEXT_BYTES = 32; // GCM: ciphertext length == plaintext length
const ENVELOPE_TAG_BYTES = 16;
const ENVELOPE_TOTAL_BYTES = 1 + ENVELOPE_NONCE_BYTES + ENVELOPE_CIPHERTEXT_BYTES + ENVELOPE_TAG_BYTES; // 61

// base64url alphabet only — reject '+', '/', '=', whitespace, or any other
// character. Anchored so a partial/embedded match can never pass.
const BASE64URL_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${QR_TOKEN_TEXT_LENGTH}}$`);

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromBase64Url(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

// ---------------------------------------------------------------------------
// §1–3: raw token generation, text encoding, QR payload construction
// ---------------------------------------------------------------------------

export interface QrTokenMaterial {
  /** 32 raw random bytes. Never persist, never log. */
  rawToken: Buffer;
  /** Canonical rcoy:v1:<43-char base64url> payload — safe to render/return to a trusted caller. */
  qrPayload: string;
}

/** §1: crypto.randomBytes(32) — the ONLY place a new raw token is ever minted. */
export function generateQrTokenMaterial(): QrTokenMaterial {
  const rawToken = randomBytes(RAW_TOKEN_BYTES);
  return { rawToken, qrPayload: canonicalEncodeQrToken(rawToken) };
}

/** §2–3: encode 32 raw bytes into the canonical rcoy:v1:<token> payload string. */
export function canonicalEncodeQrToken(rawToken: Buffer): string {
  if (rawToken.length !== RAW_TOKEN_BYTES) {
    throw new Error(`canonicalEncodeQrToken: rawToken must be exactly ${RAW_TOKEN_BYTES} bytes`);
  }
  return QR_PAYLOAD_PREFIX + toBase64Url(rawToken);
}

// ---------------------------------------------------------------------------
// §4: canonical parsing
// ---------------------------------------------------------------------------

export type ParseQrPayloadResult =
  | { ok: true; rawToken: Buffer }
  | { ok: false; reason: 'malformed' };

/**
 * §4, steps 1-8. Never throws on malformed input — returns a discriminated
 * result so callers (in particular the SQL-delegating scan wrapper's Node
 * counterpart, if any, and unit tests) can distinguish "parsed fine" from
 * "reject before any DB lookup" without exception-driven control flow for
 * an expected, common case (a mis-scanned or garbage QR payload).
 */
export function parseCanonicalQrPayload(payload: string): ParseQrPayloadResult {
  if (typeof payload !== 'string') return { ok: false, reason: 'malformed' };
  // Step 1: exact, case-sensitive prefix.
  if (!payload.startsWith(QR_PAYLOAD_PREFIX)) return { ok: false, reason: 'malformed' };
  const tokenText = payload.slice(QR_PAYLOAD_PREFIX.length);
  // Step 2+3+4: exact length, base64url alphabet only, no padding/whitespace
  // (the anchored regex enforces all three simultaneously — anything with
  // '=', '+', '/', or whitespace, or the wrong length, fails this test).
  if (!BASE64URL_TOKEN_PATTERN.test(tokenText)) return { ok: false, reason: 'malformed' };

  // Step 5-6: decode, require exactly 32 bytes.
  let rawToken: Buffer;
  try {
    rawToken = fromBase64Url(tokenText);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (rawToken.length !== RAW_TOKEN_BYTES) return { ok: false, reason: 'malformed' };

  // Step 7-8: re-encode and require an EXACT match — rejects any
  // non-canonical alternate representation of the same underlying bytes.
  const reEncoded = toBase64Url(rawToken);
  if (reEncoded !== tokenText) return { ok: false, reason: 'malformed' };

  return { ok: true, rawToken };
}

// ---------------------------------------------------------------------------
// §5: hash contract
// ---------------------------------------------------------------------------

/** §5: SHA-256 over the raw 32 bytes — never over any text form of the token. */
export function hashQrToken(rawToken: Buffer): Buffer {
  if (rawToken.length !== RAW_TOKEN_BYTES) {
    throw new Error(`hashQrToken: rawToken must be exactly ${RAW_TOKEN_BYTES} bytes`);
  }
  return createHash('sha256').update(rawToken).digest();
}

// ---------------------------------------------------------------------------
// §6: encryption contract — AES-256-GCM, 61-byte envelope
// ---------------------------------------------------------------------------

/**
 * §6: encrypt the raw 32 bytes into the canonical 61-byte envelope using the
 * given 32-byte AES-256 key. A fresh random 12-byte nonce is generated for
 * every call — never pass/reuse a caller-supplied nonce.
 */
export function encryptQrToken(rawToken: Buffer, key: Buffer): Buffer {
  if (rawToken.length !== RAW_TOKEN_BYTES) {
    throw new Error(`encryptQrToken: rawToken must be exactly ${RAW_TOKEN_BYTES} bytes`);
  }
  if (key.length !== 32) {
    throw new Error('encryptQrToken: key must be exactly 32 bytes (AES-256)');
  }
  const nonce = randomBytes(ENVELOPE_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: ENVELOPE_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(rawToken), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (ciphertext.length !== ENVELOPE_CIPHERTEXT_BYTES || tag.length !== ENVELOPE_TAG_BYTES) {
    // Structurally unreachable for AES-256-GCM with a 32-byte plaintext and
    // the fixed 16-byte tag length requested above — a hard invariant check,
    // not a normal-path validation.
    throw new Error('encryptQrToken: unexpected ciphertext/tag length');
  }
  const envelope = Buffer.concat([Buffer.from([ENVELOPE_VERSION_BYTE]), nonce, ciphertext, tag]);
  if (envelope.length !== ENVELOPE_TOTAL_BYTES) {
    throw new Error('encryptQrToken: unexpected envelope length');
  }
  return envelope;
}

/**
 * §6: decrypt a 61-byte envelope back to the raw 32 bytes. Fails closed
 * (throws) on any length/version/authentication mismatch — never returns
 * unauthenticated or partial plaintext.
 */
export function decryptQrToken(envelope: Buffer, key: Buffer): Buffer {
  if (envelope.length !== ENVELOPE_TOTAL_BYTES) {
    throw new Error(`decryptQrToken: envelope must be exactly ${ENVELOPE_TOTAL_BYTES} bytes`);
  }
  if (key.length !== 32) {
    throw new Error('decryptQrToken: key must be exactly 32 bytes (AES-256)');
  }
  const version = envelope[0];
  if (version !== ENVELOPE_VERSION_BYTE) {
    throw new Error('decryptQrToken: unsupported envelope version');
  }
  const nonce = envelope.subarray(1, 1 + ENVELOPE_NONCE_BYTES);
  const ciphertext = envelope.subarray(1 + ENVELOPE_NONCE_BYTES, 1 + ENVELOPE_NONCE_BYTES + ENVELOPE_CIPHERTEXT_BYTES);
  const tag = envelope.subarray(1 + ENVELOPE_NONCE_BYTES + ENVELOPE_CIPHERTEXT_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: ENVELOPE_TAG_BYTES });
  decipher.setAuthTag(tag);
  // cipher.final() throws on tag-verification failure (tampered ciphertext
  // or tag) — this is the fail-closed guarantee; no catch/swallow here.
  const rawToken = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (rawToken.length !== RAW_TOKEN_BYTES) {
    throw new Error('decryptQrToken: unexpected decrypted plaintext length');
  }
  return rawToken;
}

export const QR_ENVELOPE_TOTAL_BYTES = ENVELOPE_TOTAL_BYTES;
export const QR_RAW_TOKEN_BYTES = RAW_TOKEN_BYTES;
