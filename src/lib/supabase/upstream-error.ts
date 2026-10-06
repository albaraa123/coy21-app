// src/lib/supabase/upstream-error.ts
//
// Shared classification for "is this Postgres/PostgREST/Supabase error
// shape a transient, retryable condition, or a genuine, deterministic
// denial?" -- written once here because sub-project 5b's Route Handlers
// (scan-qr-attempt, admit-walk-in) and the two existing auth helpers
// (requireScannerDeviceCaller, requireAdmissionStaffCaller) all need the
// identical answer to this question, and a second, independently-
// maintained copy risks silently drifting out of sync with this one.
//
// PGRST116 ("JSON object requested, multiple (or no) rows returned") is
// explicitly NOT in the transient set -- it's PostgREST's normal,
// well-formed response to a `.single()` call matching zero or >1 rows,
// not a sign anything is actually broken.
const TRANSIENT_CODES = new Set([
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003',
  '57014', '40001', '40P01', '53300',
]);

interface ErrorLike {
  code?: string | null;
  message?: string;
}

export function isTransportShapedError(err: ErrorLike | null | undefined): boolean {
  if (!err) return false;
  const code = err.code;
  if (code === '' || code === undefined || code === null) return true;
  if (TRANSIENT_CODES.has(code)) return true;
  if (code.startsWith('08')) return true; // Postgres connection-exception class
  return false;
}

export const LOCK_CONTENTION_PREFIX = 'LOCK_CONTENTION: ';

export function isLockContentionError(err: ErrorLike | null | undefined): boolean {
  if (!err) return false;
  return err.code === 'P0001' && (err.message ?? '').startsWith(LOCK_CONTENTION_PREFIX);
}

// Thrown by requireScannerDeviceCaller/requireAdmissionStaffCaller (and, in
// later tasks, the scan-qr-attempt/admit-walk-in Route Handlers) when the
// upstream Supabase call itself failed in a transport-shaped way -- i.e.
// isTransportShapedError(err) above was true, or auth.getUser() failed with
// isAuthRetryableFetchError(err) true. Callers use `instanceof
// UpstreamUnavailableError` to distinguish "retry this" from a genuine,
// deterministic denial (not authenticated / profile not found / not
// authorized), which must never be retried.
export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}
