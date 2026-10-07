// src/components/scanner/scan-state-machine.ts
//
// Pure, DOM-free state machine for the client scanner flow:
//   ready -> detected -> submitting -> result -> ready
//   submitting -> retrying -> submitting (auto-retry loop, sub-project 5b)
//
// Deliberately has zero dependency on qr-scanner, fetch, or React, so it
// can be unit-tested directly (see scan-state-machine.test.ts) without a
// browser/camera/live network call — same "extract the decision logic,
// unit-test that" convention as src/lib/shell/admin-access.ts and
// src/lib/auth/post-login-destination.ts.
//
// This machine's whole job is to prevent unnecessary duplicate
// scan-qr-attempt submissions when a QR is held in front of the camera
// across many decoded frames — it is NOT a source of database
// correctness (scan_attempt_transactional's advisory lock and the
// attendance_records partial unique index remain the real, authoritative
// duplicate-prevention mechanism; see scan-qr-attempt-live.test.ts's own
// 'duplicate' coverage). A client-side race or a bypassed UI would still
// be caught server-side — this only avoids wasting requests/UX noise in
// the normal case.
//
// Sub-project 5b (offline scanning support) adds the 'retrying' state and
// its surrounding actions. The idempotency key and any timestamp are
// ALWAYS generated OUTSIDE this reducer and passed in as action payloads
// — crypto.randomUUID()/Date.now() inside the reducer body would make it
// impure, breaking this file's own stated design goal and its existing
// toEqual-based tests, which assert on exact, predictable state shapes.
// See docs/superpowers/specs/2026-10-06-offline-scanning-support-
// design.md lines 120-158 for the full design rationale behind every
// field/transition below.
export type ScanState =
  | { kind: 'ready' }
  | { kind: 'detected'; qrPayload: string }
  | { kind: 'submitting'; qrPayload: string; idempotencyKey: string; attemptSeq: number; startedAt: number }
  | { kind: 'retrying'; qrPayload: string; idempotencyKey: string; attemptSeq: number; startedAt: number }
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
  // Caller generates idempotencyKey/attemptSeq/startedAt (the first
  // attempt of a brand-new scan starts attemptSeq at 0); the reducer
  // never invents or validates these values, only stores them.
  | { type: 'SUBMIT_START'; idempotencyKey: string; attemptSeq: number; startedAt: number }
  | { type: 'SUBMIT_SUCCESS'; result: ScanQrResultLike }
  | { type: 'SUBMIT_ERROR' }
  // Transport-shaped failure (fetch() rejection, timeout abort, non-2xx,
  // unparseable body, or a parsed { ok:false, retryable:true } body) —
  // submitting -> retrying. qrPayload/idempotencyKey/attemptSeq/startedAt
  // all carry over unchanged from the prior 'submitting' state.
  | { type: 'SUBMIT_TRANSPORT_FAILURE' }
  // A parsed { ok:false, retryable:false } body — submitting -> ready,
  // never passing through 'retrying' at all. message is surfaced via the
  // sibling lastRejection piece of state the caller maintains (see
  // scanner-client.tsx), not stored inside this reducer's own state.
  | { type: 'SUBMIT_REJECTED'; message: string }
  // retrying -> submitting: caller supplies a freshly-incremented
  // attemptSeq (guards a late response from a superseded attempt);
  // idempotencyKey/qrPayload/startedAt carry over from the prior
  // 'retrying' state unchanged.
  | { type: 'RETRY_ATTEMPT'; attemptSeq: number }
  // retrying -> ready, discarding the key. User-initiated via the
  // "Cancel" button; the caller's click handler is responsible for also
  // calling retry.cancel() and start() synchronously in the same tick
  // (see scanner-client.tsx) — this action alone only updates state.
  | { type: 'CANCEL_RETRY' }
  // retrying -> ready: the health-check Route Handler returned 401 (a
  // real, deterministic "you are not who you claim to be"), which can
  // only ever happen while already in 'retrying' (the health check is
  // only polled from inside the retry loop) — SUBMIT_REJECTED is not a
  // valid transition from 'retrying' (only from 'submitting'), which is
  // exactly why this is a separate action rather than reusing it.
  | { type: 'RETRY_ABORTED'; message: string }
  // ready/detected -> ready: the definite-offline short-circuit (browser
  // reported offline before any network call was even attempted). A
  // dedicated action rather than reusing SUBMIT_START/SUBMIT_ERROR —
  // conceptually this was never a submission attempt at all, so it needs
  // no idempotencyKey/attemptSeq/startedAt.
  | { type: 'OFFLINE_BLOCKED' }
  | { type: 'RESET' };

/**
 * Pure reducer. The critical invariant this enforces: a DETECT action is
 * only ever accepted from the 'ready' state — any detection while
 * 'detected'/'submitting'/'retrying'/'result' is a no-op (returns the
 * same state unchanged), which is what makes repeated frames of the same
 * held-up QR incapable of triggering a second submission. The
 * camera-facing caller additionally debounces identical payloads before
 * even calling this (see use-qr-scanner.ts), but this reducer alone is
 * already sufficient to guarantee "at most one in-flight submission at a
 * time" regardless of how many DETECT actions arrive — including across
 * an entire retry cycle, since 'retrying' is just as non-'ready' as
 * 'submitting' is.
 */
export function scanStateReducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case 'DETECT':
      if (state.kind !== 'ready') return state;
      return { kind: 'detected', qrPayload: action.qrPayload };
    case 'SUBMIT_START':
      if (state.kind !== 'detected') return state;
      return {
        kind: 'submitting',
        qrPayload: state.qrPayload,
        idempotencyKey: action.idempotencyKey,
        attemptSeq: action.attemptSeq,
        startedAt: action.startedAt,
      };
    case 'SUBMIT_SUCCESS':
      if (state.kind !== 'submitting') return state;
      return { kind: 'result', result: action.result };
    case 'SUBMIT_ERROR':
      if (state.kind !== 'submitting') return state;
      return { kind: 'ready' };
    case 'SUBMIT_TRANSPORT_FAILURE':
      if (state.kind !== 'submitting') return state;
      return {
        kind: 'retrying',
        qrPayload: state.qrPayload,
        idempotencyKey: state.idempotencyKey,
        attemptSeq: state.attemptSeq,
        startedAt: state.startedAt,
      };
    case 'SUBMIT_REJECTED':
      if (state.kind !== 'submitting') return state;
      return { kind: 'ready' };
    case 'RETRY_ATTEMPT':
      if (state.kind !== 'retrying') return state;
      return {
        kind: 'submitting',
        qrPayload: state.qrPayload,
        idempotencyKey: state.idempotencyKey,
        attemptSeq: action.attemptSeq,
        startedAt: state.startedAt,
      };
    case 'CANCEL_RETRY':
      if (state.kind !== 'retrying') return state;
      return { kind: 'ready' };
    case 'RETRY_ABORTED':
      if (state.kind !== 'retrying') return state;
      return { kind: 'ready' };
    case 'OFFLINE_BLOCKED':
      if (state.kind !== 'ready' && state.kind !== 'detected') return state;
      return { kind: 'ready' };
    case 'RESET':
      return { kind: 'ready' };
    default:
      return state;
  }
}

export const INITIAL_SCAN_STATE: ScanState = { kind: 'ready' };
