import { describe, it, expect } from 'vitest';
import { generateCafeteriaToken, hashCafeteriaToken, canonicalEncodeCafeteriaToken, parseCanonicalCafeteriaPayload } from './token';

describe('cafeteria token', () => {
  it('generates a 32-byte raw token and a matching canonical payload', () => {
    const { rawToken, payload } = generateCafeteriaToken();
    expect(rawToken).toHaveLength(32);
    expect(payload).toMatch(/^cafe:v1:[A-Za-z0-9_-]{43}$/);
  });

  it('round-trips encode/parse', () => {
    const { rawToken, payload } = generateCafeteriaToken();
    const parsed = parseCanonicalCafeteriaPayload(payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rawToken.equals(rawToken)).toBe(true);
  });

  it('rejects a malformed payload (wrong prefix)', () => {
    const parsed = parseCanonicalCafeteriaPayload('rcoy:v1:' + 'A'.repeat(43));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a payload with invalid base64url characters', () => {
    const parsed = parseCanonicalCafeteriaPayload('cafe:v1:' + '+'.repeat(43));
    expect(parsed.ok).toBe(false);
  });

  it('hash is deterministic and 32 bytes (sha256)', () => {
    const { rawToken } = generateCafeteriaToken();
    const h1 = hashCafeteriaToken(rawToken);
    const h2 = hashCafeteriaToken(rawToken);
    expect(h1.equals(h2)).toBe(true);
    expect(h1).toHaveLength(32);
  });
});
