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
export const TRANSIENT_CODES = new Set([
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
  // Guard against a non-string code (e.g. a hand-assembled error-like
  // object, or some future caller's differently-shaped error) so this
  // function always returns a clean boolean rather than throwing from
  // `.startsWith` below. Every real @supabase/supabase-js PostgrestError
  // today has `code: string`, so this guard is currently unreachable in
  // practice, but this module is explicitly written for reuse beyond its
  // first two call sites (see Task 3/5 of the offline-scanning-support
  // plan), so it must not assume every future caller is as well-behaved.
  if (code !== undefined && code !== null && typeof code !== 'string') return false;
  if (code === '' || code === undefined || code === null) return true;
  if (TRANSIENT_CODES.has(code)) return true;
  if (code.startsWith('08')) return true; // Postgres connection-exception class
  return false;
}

// NOTE: this prefix does not exist in the live database yet. It's added
// to scan_attempt_transactional's advisory-lock-exhausted `raise exception`
// by sub-project 5b's Task 1 migration (see docs/superpowers/plans/
// 2026-10-06-offline-scanning-support.md, Task 1 Step 1 point 5, and the
// function's current unprefixed form in
// supabase/migrations/20260928000000_scan_attempt_transactional_scope_check.sql).
// Any code that calls isLockContentionError against the live RPC's error
// must not ship before that migration lands, or lock-contention will
// silently fall through to the generic non-retryable P0001 path instead
// of being correctly classified as retryable.
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
