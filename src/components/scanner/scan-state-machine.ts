// src/components/scanner/scan-state-machine.ts
//
// Pure, DOM-free state machine for the client scanner flow:
//   ready -> detected -> submitting -> result -> ready
//
// Deliberately has zero dependency on qr-scanner, fetch, or React, so it
// can be unit-tested directly (see scan-state-machine.test.ts) without a
// browser/camera/live network call — same "extract the decision logic,
// unit-test that" convention as src/lib/shell/admin-access.ts and
// src/lib/auth/post-login-destination.ts.
//
// This machine's whole job is to prevent unnecessary duplicate
// scanQrAttemptConfirm calls when a QR is held in front of the camera
// across many decoded frames — it is NOT a source of database
// correctness (scan_attempt_transactional's advisory lock and the
// attendance_records partial unique index remain the real, authoritative
// duplicate-prevention mechanism; see scan-qr-attempt-live.test.ts's own
// 'duplicate' coverage). A client-side race or a bypassed UI would still
// be caught server-side — this only avoids wasting requests/UX noise in
// the normal case.
export type ScanState =
  | { kind: 'ready' }
  | { kind: 'detected'; qrPayload: string }
  | { kind: 'submitting'; qrPayload: string }
  | { kind: 'result'; result: ScanQrResultLike };

// Mirrors src/lib/attendance/scan-qr-attempt.ts's ScanQrResult shape
// exactly, duplicated here only as a type (not re-implemented logic) so
// this module has zero import dependency on server-only code — a
// 'use client' component may not import from a 'use server' file's
// runtime, only reuse an equivalent type shape.
export interface ScanQrResultLike {
  result: string;
  scanAttemptId: string;
  attendanceId: string | null;
  participantSummary: { fullName: string; country: string | null; nationality: string | null } | null;
}

export type ScanAction =
  | { type: 'DETECT'; qrPayload: string }
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_SUCCESS'; result: ScanQrResultLike }
  | { type: 'SUBMIT_ERROR' }
  | { type: 'RESET' };

/**
 * Pure reducer. The critical invariant this enforces: a DETECT action is
 * only ever accepted from the 'ready' state — any detection while
 * 'detected'/'submitting'/'result' is a no-op (returns the same state
 * unchanged), which is what makes repeated frames of the same held-up QR
 * incapable of triggering a second submission. The camera-facing caller
 * additionally debounces identical payloads before even calling this
 * (see use-qr-scanner.ts), but this reducer alone is already sufficient
 * to guarantee "at most one in-flight submission at a time" regardless
 * of how many DETECT actions arrive.
 */
export function scanStateReducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case 'DETECT':
      if (state.kind !== 'ready') return state;
      return { kind: 'detected', qrPayload: action.qrPayload };
    case 'SUBMIT_START':
      if (state.kind !== 'detected') return state;
      return { kind: 'submitting', qrPayload: state.qrPayload };
    case 'SUBMIT_SUCCESS':
      if (state.kind !== 'submitting') return state;
      return { kind: 'result', result: action.result };
    case 'SUBMIT_ERROR':
      if (state.kind !== 'submitting') return state;
      return { kind: 'ready' };
    case 'RESET':
      return { kind: 'ready' };
    default:
      return state;
  }
}

export const INITIAL_SCAN_STATE: ScanState = { kind: 'ready' };
