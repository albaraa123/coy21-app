// src/lib/attendance/qr-encryption-keys.ts
//
// Resolves the external AES-256-GCM key material for a given
// qr_encryption_key_registry key_version, per §7 of
// docs/superpowers/specs/2026-08-12-qr-token-format-and-lifecycle.md.
//
// The database never stores raw key bytes (qr_encryption_key_registry is
// metadata-only: key_version/status/timestamps) — this module is the ONLY
// place that reads actual key material, from server-only environment
// variables. Never imported from a 'use client' file; never re-exported to
// any client-reachable code path.
const KEY_BYTES = 32;

function envVarNameForKeyVersion(keyVersion: number): string {
  return `QR_ENCRYPTION_KEY_V${keyVersion}`;
}

/**
 * Reads and decodes the 32-byte AES-256 key for the given key_version from
 * `QR_ENCRYPTION_KEY_V<n>` (base64url, unpadded). Fails closed: throws on a
 * missing variable, malformed encoding, or wrong decoded length — never
 * silently truncates/pads/falls back to a different key.
 */
export function resolveQrEncryptionKey(keyVersion: number): Buffer {
  const varName = envVarNameForKeyVersion(keyVersion);
  const raw = process.env[varName];
  if (!raw || raw.trim() === '') {
    throw new Error(`resolveQrEncryptionKey: ${varName} is not set`);
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64url');
  } catch {
    throw new Error(`resolveQrEncryptionKey: ${varName} is not valid base64url`);
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`resolveQrEncryptionKey: ${varName} must decode to exactly ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}
