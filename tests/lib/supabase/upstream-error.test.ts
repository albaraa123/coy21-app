import { describe, it, expect } from 'vitest';
import { isTransportShapedError, isLockContentionError } from '@/lib/supabase/upstream-error';

describe('isTransportShapedError', () => {
  it('returns true for an empty error code (raw fetch rejection shape)', () => {
    expect(isTransportShapedError({ code: '', message: 'fetch failed' })).toBe(true);
  });
  it('returns true for an undefined code (non-JSON 5xx gateway shape)', () => {
    expect(isTransportShapedError({ code: undefined, message: '<html>502</html>' })).toBe(true);
  });
  it.each(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', '57014', '40001', '40P01', '53300', '08006'])(
    'returns true for Postgres/PostgREST transient code %s',
    (code) => {
      expect(isTransportShapedError({ code, message: 'x' })).toBe(true);
    }
  );
  it('returns false for PGRST116 (PostgREST "no rows" from .single() — a clean, well-formed denial, not a transport failure)', () => {
    expect(isTransportShapedError({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })).toBe(false);
  });
  it('returns false for a genuine deterministic rejection (P0001 without the lock-contention prefix)', () => {
    expect(isTransportShapedError({ code: 'P0001', message: 'Not authorized for this session/room' })).toBe(false);
  });
});

describe('isLockContentionError', () => {
  it('returns true only for P0001 with the exact LOCK_CONTENTION: prefix', () => {
    expect(isLockContentionError({ code: 'P0001', message: 'LOCK_CONTENTION: Another scan for this session is still being processed after 20 retries — please retry manually' })).toBe(true);
  });
  it('returns false for a different P0001 message', () => {
    expect(isLockContentionError({ code: 'P0001', message: 'Idempotency key reused with different scan data' })).toBe(false);
  });
});
