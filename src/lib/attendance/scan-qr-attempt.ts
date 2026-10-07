// src/lib/attendance/scan-qr-attempt.ts
//
// The trusted Next.js server boundary for QR-based scanner submission —
// completes Phase 7A by wiring scan_qr_attempt_transactional (the
// database bridge, migration 20260814100000) behind the same
// authorization/scope discipline scan-attempt.ts already applies to the
// applicationId-based path. Mirrors that file's verifyScannerScope shape
// deliberately — no parallel authorization architecture.
//
// scanQrAttemptConfirmForCaller takes an already-authenticated
// `caller: {userId, service}` as an injected parameter and does NOT call
// requireScannerDeviceCaller() itself — that call now lives in
// src/app/api/scan-qr-attempt/route.ts's POST handler, which is the
// trusted boundary's actual entry point since Server Actions were
// replaced by a Route Handler (see sub-project 5b's Task 3). This keeps
// ...ForCaller unit-testable without a request context, exactly as
// tests/attendance/scan-qr-attempt-server-boundary.test.ts's own header
// comment describes.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { parseCanonicalQrPayload, hashQrToken } from './qr-token-crypto';
import { getScannerParticipantSummary, type ScannerParticipantSummary } from './participant-summary';
import { isTransportShapedError, isLockContentionError } from '@/lib/supabase/upstream-error';

type ServiceClient = SupabaseClient<Database>;

export interface ScanQrResult {
  result: string;
  scanAttemptId: string;
  attendanceId: string | null;
  participantSummary: ScannerParticipantSummary | null;
}

// Per spec lines 101-105 (docs/superpowers/specs/2026-10-06-offline-
// scanning-support-design.md) — the Route Handler's JSON response body.
// The retryable/non-retryable distinction lives in this body, never the
// HTTP status, so the client's "any non-2xx or unparseable body means
// transport failure" rule (layer 1) never misfires on a deterministic
// server-side denial.
export type ScanQrOutcome =
  | { ok: true; result: ScanQrResult }
  | { ok: false; retryable: true; reason: 'lock-contention' | 'upstream-unreachable' }
  | { ok: false; retryable: false; message: string };

// Identical to scan-attempt.ts's own verifyScannerScope — not
// re-exported/shared across files in this codebase's existing
// convention (scan-attempt.ts keeps its copy module-private too), so
// this is a deliberate one-for-one mirror, not an accidental duplicate.
//
// Returns a ScanQrOutcome directly (rather than throwing) for a
// transport-shaped failure on either query, per spec line 111 (layer 2):
// a query that itself failed (populated `error`) must never be read as a
// confident "not found"/"not authorized" denial — only a clean,
// error-free, genuinely-empty result is a real, non-retryable denial.
async function verifyScannerScope(
  service: ServiceClient,
  userId: string,
  sessionId: string
): Promise<{ ok: true } | { ok: false; outcome: ScanQrOutcome }> {
  const { data: session, error: sessionError } = await service.from('sessions').select('id, room_id').eq('id', sessionId).single();
  if (sessionError && isTransportShapedError(sessionError)) {
    return { ok: false, outcome: { ok: false, retryable: true, reason: 'upstream-unreachable' } };
  }
  if (!session) return { ok: false, outcome: { ok: false, retryable: false, message: 'Session not found' } };

  const { count, error: countError } = await service
    .from('scanner_assignments')
    .select('*', { count: 'exact', head: true })
    .eq('scanner_user_id', userId)
    .eq('is_active', true)
    .or(`session_id.eq.${sessionId},room_id.eq.${session.room_id}`);
  if (countError && isTransportShapedError(countError)) {
    return { ok: false, outcome: { ok: false, retryable: true, reason: 'upstream-unreachable' } };
  }
  if (!count || count === 0) {
    return { ok: false, outcome: { ok: false, retryable: false, message: 'Not authorized for this session/room' } };
  }
  return { ok: true };
}

function toByteaHexOrNull(buf: Buffer | null): string | null {
  return buf ? `\\x${buf.toString('hex')}` : null;
}

/**
 * The trusted server-side QR scan operation. Only qrPayload/sessionId are
 * ever accepted from the browser; scanned_by, device scope, and override
 * eligibility are all derived server-side from `caller` (never trusted
 * input) — deviceIdentifier, when provided, is passed through only as a
 * display/audit label, exactly like scanAttemptConfirmForCaller's own
 * deviceIdentifier parameter; it is never treated as proof of authority.
 *
 * Malformed/non-canonical payloads never reach qr_credentials: parsing
 * happens here, and a parse failure calls the RPC with p_token_hash =
 * null, which scan_qr_attempt_transactional's own existing null/wrong-
 * length guard turns into exactly one invalid_qr scan_attempts row
 * (application_id null) — the same audit invariant a resolved-but-
 * unknown/revoked/replaced credential gets, with the raw payload never
 * persisted anywhere.
 */
export async function scanQrAttemptConfirmForCaller(
  params: { qrPayload: string; sessionId: string; deviceIdentifier: string | null },
  caller: { userId: string; service: ServiceClient },
  idempotencyKey: string
): Promise<ScanQrOutcome> {
  const { service, userId } = caller;
  const scope = await verifyScannerScope(service, userId, params.sessionId);
  if (!scope.ok) return scope.outcome;

  const parsed = parseCanonicalQrPayload(params.qrPayload);
  const tokenHash = parsed.ok ? hashQrToken(parsed.rawToken) : null;

  const { data, error } = await service.rpc('scan_qr_attempt_transactional', {
    // Same known Supabase CLI type-gen gap as p_device_identifier below —
    // the SQL parameter genuinely accepts null (see toByteaHexOrNull above).
    p_token_hash: toByteaHexOrNull(tokenHash) as string,
    p_session_id: params.sessionId,
    p_scanned_by: userId,
    // Same known Supabase CLI type-gen gap as scan_attempt_transactional's
    // p_device_identifier (see scan-attempt.ts) — the SQL parameter
    // genuinely accepts null.
    p_device_identifier: params.deviceIdentifier as string,
    // Never client-controlled. scanAttemptConfirmForCaller (the existing,
    // live applicationId-based scanner path) hardcodes this identically —
    // override is a wholly separate operation (admitOverrideForCaller),
    // reachable only via requireProgramAttendanceStaffCaller
    // (program_attendance_manager/super_admin), never through the
    // scanner_device scan path. Preserving that exact production
    // precedent, not inventing new semantics.
    p_is_override_caller: false,
    // Same reasoning as scan-attempt.ts's scanAttemptConfirmForCaller: the
    // verifyScannerScope call above is a separate round-trip from this RPC,
    // so a scanner's assignment could be deactivated in between. Passing
    // the caller's id re-verifies scope inside scan_attempt_transactional's
    // own transaction (reached via scan_qr_attempt_transactional's
    // delegation below), after its advisory lock is held.
    p_scanner_user_id: userId,
    p_idempotency_key: idempotencyKey,
  });
  if (error) {
    if (isLockContentionError(error)) return { ok: false, retryable: true, reason: 'lock-contention' };
    if (isTransportShapedError(error)) return { ok: false, retryable: true, reason: 'upstream-unreachable' };
    return { ok: false, retryable: false, message: error.message };
  }

  const applicationId = data.application_id;
  const participantSummary = applicationId ? await getScannerParticipantSummary(service, applicationId) : null;

  return {
    ok: true,
    result: {
      result: data.result,
      scanAttemptId: data.id,
      attendanceId: data.resulting_attendance_id,
      participantSummary,
    },
  };
}
