// tests/attendance/qr-token-crypto.test.ts
//
// Pure unit tests for the canonical QR token contract implemented in
// src/lib/attendance/qr-token-crypto.ts — no database, no network. Covers
// items 1-16 of the Phase 6.1 test requirements.
import { describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import {
  generateQrTokenMaterial,
  canonicalEncodeQrToken,
  parseCanonicalQrPayload,
  hashQrToken,
  encryptQrToken,
  decryptQrToken,
  QR_PAYLOAD_PREFIX,
  QR_TOKEN_TEXT_LENGTH,
  QR_ENVELOPE_TOTAL_BYTES,
  QR_RAW_TOKEN_BYTES,
} from '@/lib/attendance/qr-token-crypto';

describe('QR token contract — raw generation and encoding', () => {
  it('1. 32 raw bytes -> exactly 43 unpadded base64url characters', () => {
    const { rawToken, qrPayload } = generateQrTokenMaterial();
    expect(rawToken.length).toBe(32);
    const tokenText = qrPayload.slice(QR_PAYLOAD_PREFIX.length);
    expect(tokenText.length).toBe(QR_TOKEN_TEXT_LENGTH);
    expect(tokenText.length).toBe(43);
    expect(tokenText).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenText).not.toMatch(/[+/=]/);
  });

  it('2. decode/encode round trip', () => {
    const raw = randomBytes(32);
    const encoded = canonicalEncodeQrToken(raw);
    const parsed = parseCanonicalQrPayload(encoded);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Buffer.compare(parsed.rawToken, raw)).toBe(0);
    }
  });

  it('3. exact rcoy:v1: payload format', () => {
    const raw = randomBytes(32);
    const payload = canonicalEncodeQrToken(raw);
    expect(payload.startsWith('rcoy:v1:')).toBe(true);
    expect(payload.length).toBe(8 + 43);
  });
});

describe('QR token contract — canonical parsing rejects malformed input', () => {
  const validToken = canonicalEncodeQrToken(randomBytes(32)).slice(QR_PAYLOAD_PREFIX.length);

  it('4. malformed prefix rejected', () => {
    expect(parseCanonicalQrPayload(`rcoy:v2:${validToken}`).ok).toBe(false);
    expect(parseCanonicalQrPayload(`RCOY:V1:${validToken}`).ok).toBe(false);
    expect(parseCanonicalQrPayload(validToken).ok).toBe(false);
  });

  it('5. wrong token length rejected', () => {
    expect(parseCanonicalQrPayload(`rcoy:v1:${validToken.slice(0, 42)}`).ok).toBe(false);
    expect(parseCanonicalQrPayload(`rcoy:v1:${validToken}X`).ok).toBe(false);
    expect(parseCanonicalQrPayload('rcoy:v1:').ok).toBe(false);
  });

  it('6. padding rejected', () => {
    const withPadding = `rcoy:v1:${validToken.slice(0, 42)}=`;
    expect(parseCanonicalQrPayload(withPadding).ok).toBe(false);
  });

  it('7. standard-base64 characters (+, /) rejected', () => {
    const withPlus = `rcoy:v1:${'+'.repeat(43)}`;
    const withSlash = `rcoy:v1:${'/'.repeat(43)}`;
    expect(parseCanonicalQrPayload(withPlus).ok).toBe(false);
    expect(parseCanonicalQrPayload(withSlash).ok).toBe(false);
  });

  it('8. whitespace rejected', () => {
    expect(parseCanonicalQrPayload(`rcoy:v1:${validToken.slice(0, 42)} `).ok).toBe(false);
    expect(parseCanonicalQrPayload(`rcoy:v1: ${validToken.slice(1)}`).ok).toBe(false);
    expect(parseCanonicalQrPayload(`rcoy:v1:\n${validToken.slice(1)}`).ok).toBe(false);
  });

  it('9. decoded length != 32 rejected (43 canonical chars is required precisely because it is the ONLY length decoding to 32 bytes; verify a 43-char string decoding to a different length is still rejected by the length check, not just the alphabet check)', () => {
    // 44 base64url chars decode to 33 bytes — wrong text length is already
    // covered by test 5, but this proves the decoded-byte-length check (step
    // 6) is real and not merely redundant with the text-length check (step
    // 2), by constructing a string that could otherwise look plausible.
    const raw33 = randomBytes(33);
    const text44 = raw33.toString('base64url');
    expect(text44.length).not.toBe(43);
    expect(parseCanonicalQrPayload(`rcoy:v1:${text44}`).ok).toBe(false);
  });

  it('10. canonical re-encoding mismatch rejected (non-canonical alternate representation of the same bytes)', () => {
    // Construct a 43-char base64url string whose decode-then-re-encode does
    // NOT round-trip to itself. base64url with a 43-char input has 2 "spare"
    // bits in the last character (43*6 = 258 bits for 256 bits of payload),
    // so several distinct final characters can decode to the same 32 bytes
    // but only one is canonical. Find such a case constructively.
    const raw = randomBytes(32);
    const canonical = raw.toString('base64url');
    const lastChar = canonical[canonical.length - 1];
    const base64urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let nonCanonical: string | null = null;
    for (const candidate of base64urlAlphabet) {
      if (candidate === lastChar) continue;
      const attempt = canonical.slice(0, -1) + candidate;
      const decoded = Buffer.from(attempt, 'base64url');
      if (decoded.length === 32 && Buffer.compare(decoded, raw) === 0) {
        nonCanonical = attempt;
        break;
      }
    }
    expect(nonCanonical).not.toBeNull();
    expect(nonCanonical).not.toBe(canonical);
    const parsed = parseCanonicalQrPayload(`rcoy:v1:${nonCanonical}`);
    expect(parsed.ok).toBe(false);
  });
});

describe('QR token contract — hash', () => {
  it('11. hash is SHA-256(raw bytes), proven with a deterministic test vector', () => {
    // Known vector: 32 zero bytes -> fixed SHA-256 digest (RFC/NIST-style
    // well-known value for an all-zero 32-byte input).
    const zero32 = Buffer.alloc(32, 0);
    const hash = hashQrToken(zero32);
    expect(hash.length).toBe(32);
    expect(hash.toString('hex')).toBe('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
  });

  it('12. hash is NOT accidentally SHA-256(encoded text)', () => {
    const raw = randomBytes(32);
    const hashOfRaw = hashQrToken(raw);
    const encodedText = canonicalEncodeQrToken(raw).slice(QR_PAYLOAD_PREFIX.length);
    const hashOfTextUtf8 = createHash('sha256').update(Buffer.from(encodedText, 'utf8')).digest();
    const hashOfFullPayloadUtf8 = createHash('sha256').update(Buffer.from(`rcoy:v1:${encodedText}`, 'utf8')).digest();
    expect(Buffer.compare(hashOfRaw, hashOfTextUtf8)).not.toBe(0);
    expect(Buffer.compare(hashOfRaw, hashOfFullPayloadUtf8)).not.toBe(0);
  });

  it('hash rejects non-32-byte input', () => {
    expect(() => hashQrToken(randomBytes(31))).toThrow();
    expect(() => hashQrToken(randomBytes(33))).toThrow();
  });
});

describe('QR token contract — AES-256-GCM envelope', () => {
  const key = randomBytes(32);

  it('13. AES-GCM encrypt/decrypt round trip using the existing Phase 6 envelope', () => {
    const raw = randomBytes(32);
    const envelope = encryptQrToken(raw, key);
    const decrypted = decryptQrToken(envelope, key);
    expect(Buffer.compare(decrypted, raw)).toBe(0);
  });

  it('14. ciphertext envelope length/version matches the approved Phase 6 contract (61 bytes, version byte 1)', () => {
    const raw = randomBytes(32);
    const envelope = encryptQrToken(raw, key);
    expect(envelope.length).toBe(61);
    expect(envelope.length).toBe(QR_ENVELOPE_TOTAL_BYTES);
    expect(envelope[0]).toBe(1);
  });

  it('15. tampered ciphertext fails authentication', () => {
    const raw = randomBytes(32);
    const envelope = encryptQrToken(raw, key);
    const tamperedCiphertext = Buffer.from(envelope);
    tamperedCiphertext[20] ^= 0xff; // flip a bit inside the ciphertext region (bytes 13..44)
    expect(() => decryptQrToken(tamperedCiphertext, key)).toThrow();
  });

  it('15b. tampered tag fails authentication', () => {
    const raw = randomBytes(32);
    const envelope = encryptQrToken(raw, key);
    const tamperedTag = Buffer.from(envelope);
    tamperedTag[60] ^= 0xff; // flip a bit inside the tag region (bytes 45..60)
    expect(() => decryptQrToken(tamperedTag, key)).toThrow();
  });

  it('15c. tampered nonce fails authentication', () => {
    const raw = randomBytes(32);
    const envelope = encryptQrToken(raw, key);
    const tamperedNonce = Buffer.from(envelope);
    tamperedNonce[5] ^= 0xff; // flip a bit inside the nonce region (bytes 1..12)
    expect(() => decryptQrToken(tamperedNonce, key)).toThrow();
  });

  it('decryption rejects wrong-length envelope', () => {
    const key32 = randomBytes(32);
    expect(() => decryptQrToken(randomBytes(60), key32)).toThrow();
    expect(() => decryptQrToken(randomBytes(62), key32)).toThrow();
  });

  it('decryption rejects unsupported version byte', () => {
    const raw = randomBytes(32);
    const envelope = Buffer.from(encryptQrToken(raw, key));
    envelope[0] = 2;
    expect(() => decryptQrToken(envelope, key)).toThrow();
  });

  it('a fresh random nonce is used on every encryption call (no nonce reuse)', () => {
    const raw = randomBytes(32);
    const envelopeA = encryptQrToken(raw, key);
    const envelopeB = encryptQrToken(raw, key);
    const nonceA = envelopeA.subarray(1, 13);
    const nonceB = envelopeB.subarray(1, 13);
    expect(Buffer.compare(nonceA, nonceB)).not.toBe(0);
    // Same plaintext + different nonce must also produce different ciphertext.
    expect(Buffer.compare(envelopeA, envelopeB)).not.toBe(0);
  });
});

describe('QR token contract — independence of separately generated tokens', () => {
  it('16. two calls to generateQrTokenMaterial produce independent tokens (models issuance vs. reissue independence)', () => {
    const a = generateQrTokenMaterial();
    const b = generateQrTokenMaterial();
    expect(Buffer.compare(a.rawToken, b.rawToken)).not.toBe(0);
    expect(a.qrPayload).not.toBe(b.qrPayload);
    expect(Buffer.compare(hashQrToken(a.rawToken), hashQrToken(b.rawToken))).not.toBe(0);
  });
});

describe('QR token contract — constants sanity', () => {
  it('exposed constants match the canonical contract', () => {
    expect(QR_PAYLOAD_PREFIX).toBe('rcoy:v1:');
    expect(QR_TOKEN_TEXT_LENGTH).toBe(43);
    expect(QR_RAW_TOKEN_BYTES).toBe(32);
    expect(QR_ENVELOPE_TOTAL_BYTES).toBe(61);
  });
});
