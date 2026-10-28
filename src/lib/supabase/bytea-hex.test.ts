import { describe, it, expect } from 'vitest';
import { toByteaHex, toByteaHexOrNull, fromByteaHex } from './bytea-hex';

describe('toByteaHex', () => {
  it('encodes a buffer as a backslash-x-prefixed hex string', () => {
    expect(toByteaHex(Buffer.from('ab', 'hex'))).toBe('\\xab');
  });
});

describe('toByteaHexOrNull', () => {
  it('encodes a non-null buffer the same way as toByteaHex', () => {
    expect(toByteaHexOrNull(Buffer.from('ab', 'hex'))).toBe('\\xab');
  });
  it('returns null for a null buffer', () => {
    expect(toByteaHexOrNull(null)).toBeNull();
  });
});

describe('fromByteaHex', () => {
  it('decodes a backslash-x-prefixed hex string back to a buffer', () => {
    expect(fromByteaHex('\\xab')).toEqual(Buffer.from('ab', 'hex'));
  });
  it('round-trips through toByteaHex', () => {
    const original = Buffer.from('deadbeef', 'hex');
    expect(fromByteaHex(toByteaHex(original))).toEqual(original);
  });
});
