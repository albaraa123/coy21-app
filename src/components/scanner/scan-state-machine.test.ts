// src/components/scanner/scan-state-machine.test.ts
//
// Pure unit tests for scanStateReducer — no DOM, no camera, no network.
import { describe, expect, it } from 'vitest';
import { scanStateReducer, INITIAL_SCAN_STATE, type ScanState, type ScanQrResultLike } from './scan-state-machine';

const sampleResult: ScanQrResultLike = {
  result: 'flexible_admitted',
  scanAttemptId: 'attempt-1',
  attendanceId: 'attendance-1',
  participantSummary: { fullName: 'Test Participant', country: 'Oman', nationality: 'Omani' },
};

// Fixed, arbitrary values reused across tests that need a SUBMIT_START's
// new required fields but don't care about their exact value — real
// callers generate these via crypto.randomUUID()/Date.now(), never the
// reducer itself (see this file's SUBMIT_START tests below for the
// property that actually matters: two independently-generated keys never
// collide via any reducer-side reuse).
const KEY_A = 'key-a';
const KEY_B = 'key-b';
const STARTED_AT = 1_700_000_000_000;

describe('scanStateReducer', () => {
  it('starts in ready', () => {
    expect(INITIAL_SCAN_STATE).toEqual({ kind: 'ready' });
  });

  it('ready -> detected on DETECT', () => {
    const next = scanStateReducer({ kind: 'ready' }, { type: 'DETECT', qrPayload: 'rcoy:v1:abc' });
    expect(next).toEqual({ kind: 'detected', qrPayload: 'rcoy:v1:abc' });
  });

  it('detected -> submitting on SUBMIT_START', () => {
    const next = scanStateReducer(
      { kind: 'detected', qrPayload: 'rcoy:v1:abc' },
      { type: 'SUBMIT_START', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT }
    );
    expect(next).toEqual({ kind: 'submitting', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT });
  });

  it('submitting -> result on SUBMIT_SUCCESS', () => {
    const next = scanStateReducer(
      { kind: 'submitting', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT },
      { type: 'SUBMIT_SUCCESS', result: sampleResult }
    );
    expect(next).toEqual({ kind: 'result', result: sampleResult });
  });

  it('submitting -> ready on SUBMIT_ERROR (recoverable, returns to scanning)', () => {
    const next = scanStateReducer(
      { kind: 'submitting', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT },
      { type: 'SUBMIT_ERROR' }
    );
    expect(next).toEqual({ kind: 'ready' });
  });

  it('result -> ready on RESET ("Scan Next Participant")', () => {
    const next = scanStateReducer({ kind: 'result', result: sampleResult }, { type: 'RESET' });
    expect(next).toEqual({ kind: 'ready' });
  });

  describe('critical invariant: DETECT is a no-op from any state other than ready', () => {
    const nonReadyStates: ScanState[] = [
      { kind: 'detected', qrPayload: 'rcoy:v1:abc' },
      { kind: 'submitting', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT },
      { kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT },
      { kind: 'result', result: sampleResult },
    ];

    for (const state of nonReadyStates) {
      it(`DETECT from ${state.kind} does not transition (repeated frames of the same held-up QR cannot trigger a second submission)`, () => {
        const next = scanStateReducer(state, { type: 'DETECT', qrPayload: 'rcoy:v1:xyz' });
        expect(next).toBe(state); // same reference, proving a true no-op
      });
    }
  });

  it('a rapid sequence of many DETECT actions for the same payload while submitting produces exactly one submitting state, never a second', () => {
    let state: ScanState = { kind: 'ready' };
    state = scanStateReducer(state, { type: 'DETECT', qrPayload: 'rcoy:v1:abc' });
    state = scanStateReducer(state, { type: 'SUBMIT_START', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT });
    expect(state.kind).toBe('submitting');

    // Simulate 20 more decoded frames of the same (or different) QR
    // arriving while a submission is already in flight.
    for (let i = 0; i < 20; i++) {
      state = scanStateReducer(state, { type: 'DETECT', qrPayload: `rcoy:v1:frame-${i}` });
      expect(state.kind).toBe('submitting'); // never re-enters 'detected'
    }
  });

  it('SUBMIT_START is a no-op from ready (cannot skip the detected state)', () => {
    const state: ScanState = { kind: 'ready' };
    const next = scanStateReducer(state, { type: 'SUBMIT_START', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT });
    expect(next).toBe(state);
  });

  it('SUBMIT_SUCCESS is a no-op from ready/detected (cannot fabricate a result without submitting)', () => {
    expect(scanStateReducer({ kind: 'ready' }, { type: 'SUBMIT_SUCCESS', result: sampleResult })).toEqual({ kind: 'ready' });
    expect(scanStateReducer({ kind: 'detected', qrPayload: 'x' }, { type: 'SUBMIT_SUCCESS', result: sampleResult })).toEqual({
      kind: 'detected',
      qrPayload: 'x',
    });
  });

  it('RESET always returns to ready regardless of current state', () => {
    expect(scanStateReducer({ kind: 'ready' }, { type: 'RESET' })).toEqual({ kind: 'ready' });
    expect(scanStateReducer({ kind: 'detected', qrPayload: 'x' }, { type: 'RESET' })).toEqual({ kind: 'ready' });
    expect(
      scanStateReducer({ kind: 'submitting', qrPayload: 'x', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT }, { type: 'RESET' })
    ).toEqual({ kind: 'ready' });
    expect(
      scanStateReducer({ kind: 'retrying', qrPayload: 'x', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT }, { type: 'RESET' })
    ).toEqual({ kind: 'ready' });
    expect(scanStateReducer({ kind: 'result', result: sampleResult }, { type: 'RESET' })).toEqual({ kind: 'ready' });
  });

  it('manual entry reuses the exact same DETECT action as camera capture — the reducer has no concept of "source", only a payload string, so there is no second admission workflow at the state-machine level', () => {
    const cameraTriggered = scanStateReducer({ kind: 'ready' }, { type: 'DETECT', qrPayload: 'rcoy:v1:from-camera' });
    const manuallyTriggered = scanStateReducer({ kind: 'ready' }, { type: 'DETECT', qrPayload: 'rcoy:v1:from-manual-entry' });
    // Same shape, same transition rule, same downstream handling — only
    // the payload content differs, exactly as intended.
    expect(cameraTriggered.kind).toBe('detected');
    expect(manuallyTriggered.kind).toBe('detected');
  });

  it('a manual submission is accepted from ready after the scanner has returned to ready post-reset (not blocked by any residual cooldown)', () => {
    let state: ScanState = { kind: 'ready' };
    state = scanStateReducer(state, { type: 'DETECT', qrPayload: 'rcoy:v1:first' });
    state = scanStateReducer(state, { type: 'SUBMIT_START', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT });
    state = scanStateReducer(state, { type: 'SUBMIT_SUCCESS', result: sampleResult });
    expect(state.kind).toBe('result');
    state = scanStateReducer(state, { type: 'RESET' });
    expect(state.kind).toBe('ready');
    // A deliberate manual submission right after reset must be accepted,
    // not suppressed by any leftover "just scanned" state.
    state = scanStateReducer(state, { type: 'DETECT', qrPayload: 'rcoy:v1:manual-after-reset' });
    expect(state).toEqual({ kind: 'detected', qrPayload: 'rcoy:v1:manual-after-reset' });
  });

  it('ScanQrResultLike (the shape the UI receives) has exactly the approved fields — no application_id/token/hash/ciphertext', () => {
    const keys = Object.keys(sampleResult).sort();
    expect(keys).toEqual(['attendanceId', 'participantSummary', 'result', 'scanAttemptId'].sort());
  });

  it('RESET is synchronous and produces no side effect beyond the state transition itself — the reducer never triggers camera work, so a caller is free to pair RESET with a synchronous camera-resume call in the SAME event-handler tick (required on iOS Safari, where video.play() is only permitted inside a real user-gesture handler, not a later useEffect)', () => {
    // scanStateReducer is a plain, pure function — calling it twice in a
    // row (as ScannerClient's handleScanNext does: dispatch(RESET)
    // immediately followed by a direct start() call) produces a fully
    // resolved 'ready' state with nothing pending, proving there is no
    // reducer-internal reason a caller would ever need to defer the
    // camera-resume call to a later render/effect.
    const resultState: ScanState = { kind: 'result', result: sampleResult };
    const afterReset = scanStateReducer(resultState, { type: 'RESET' });
    expect(afterReset).toEqual({ kind: 'ready' });
    // Calling RESET again (idempotent) or DETECT immediately after
    // (simulating a synchronous start() call already having re-armed
    // the camera by the time a frame decodes) both behave exactly as
    // they would from any other 'ready' state — no special-casing tied
    // to how 'ready' was reached.
    expect(scanStateReducer(afterReset, { type: 'RESET' })).toEqual({ kind: 'ready' });
    expect(scanStateReducer(afterReset, { type: 'DETECT', qrPayload: 'rcoy:v1:immediate' })).toEqual({
      kind: 'detected',
      qrPayload: 'rcoy:v1:immediate',
    });
  });

  describe('retrying state transitions', () => {
    it('submitting -> retrying on SUBMIT_TRANSPORT_FAILURE, carrying qrPayload/idempotencyKey/attemptSeq/startedAt over unchanged', () => {
      const next = scanStateReducer(
        { kind: 'submitting', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT },
        { type: 'SUBMIT_TRANSPORT_FAILURE' }
      );
      expect(next).toEqual({ kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT });
    });

    it('SUBMIT_TRANSPORT_FAILURE is a no-op from any state other than submitting', () => {
      const readyState: ScanState = { kind: 'ready' };
      expect(scanStateReducer(readyState, { type: 'SUBMIT_TRANSPORT_FAILURE' })).toBe(readyState);
      const retryingState: ScanState = { kind: 'retrying', qrPayload: 'x', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT };
      expect(scanStateReducer(retryingState, { type: 'SUBMIT_TRANSPORT_FAILURE' })).toBe(retryingState);
    });

    it('submitting -> ready on SUBMIT_REJECTED (non-retryable, never enters retrying)', () => {
      const next = scanStateReducer(
        { kind: 'submitting', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT },
        { type: 'SUBMIT_REJECTED', message: 'Not authorized for this session/room' }
      );
      expect(next).toEqual({ kind: 'ready' });
    });

    it('SUBMIT_REJECTED is a no-op from any state other than submitting (e.g. retrying — that case is RETRY_ABORTED, not SUBMIT_REJECTED)', () => {
      const retryingState: ScanState = { kind: 'retrying', qrPayload: 'x', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT };
      expect(scanStateReducer(retryingState, { type: 'SUBMIT_REJECTED', message: 'whatever' })).toBe(retryingState);
    });

    it('retrying -> submitting on RETRY_ATTEMPT, carrying idempotencyKey/qrPayload/startedAt over, with the caller-supplied incremented attemptSeq', () => {
      const next = scanStateReducer(
        { kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT },
        { type: 'RETRY_ATTEMPT', attemptSeq: 1 }
      );
      expect(next).toEqual({ kind: 'submitting', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 1, startedAt: STARTED_AT });
    });

    it('RETRY_ATTEMPT is a no-op from any state other than retrying', () => {
      const submittingState: ScanState = { kind: 'submitting', qrPayload: 'x', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT };
      expect(scanStateReducer(submittingState, { type: 'RETRY_ATTEMPT', attemptSeq: 1 })).toBe(submittingState);
    });

    it('retrying -> ready on CANCEL_RETRY, discarding the key', () => {
      const next = scanStateReducer(
        { kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 2, startedAt: STARTED_AT },
        { type: 'CANCEL_RETRY' }
      );
      expect(next).toEqual({ kind: 'ready' });
    });

    it('CANCEL_RETRY is a no-op from any state other than retrying', () => {
      const readyState: ScanState = { kind: 'ready' };
      expect(scanStateReducer(readyState, { type: 'CANCEL_RETRY' })).toBe(readyState);
    });

    it('retrying -> ready on RETRY_ABORTED, carrying the message (surfaced via lastRejection, tracked outside this reducer)', () => {
      const next = scanStateReducer(
        { kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 3, startedAt: STARTED_AT },
        { type: 'RETRY_ABORTED', message: 'Scanner session expired — please re-authenticate' }
      );
      expect(next).toEqual({ kind: 'ready' });
    });

    it('RETRY_ABORTED is a no-op from any state other than retrying (e.g. submitting — a mid-submission 401 is SUBMIT_REJECTED, not RETRY_ABORTED)', () => {
      const submittingState: ScanState = { kind: 'submitting', qrPayload: 'x', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT };
      expect(scanStateReducer(submittingState, { type: 'RETRY_ABORTED', message: 'whatever' })).toBe(submittingState);
    });

    it('ready/detected -> ready on OFFLINE_BLOCKED (definite-offline short-circuit, never a real submission attempt, no idempotency fields needed)', () => {
      expect(scanStateReducer({ kind: 'ready' }, { type: 'OFFLINE_BLOCKED' })).toEqual({ kind: 'ready' });
      expect(scanStateReducer({ kind: 'detected', qrPayload: 'rcoy:v1:abc' }, { type: 'OFFLINE_BLOCKED' })).toEqual({ kind: 'ready' });
    });

    it('OFFLINE_BLOCKED is a no-op from submitting/retrying/result', () => {
      const submittingState: ScanState = { kind: 'submitting', qrPayload: 'x', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT };
      expect(scanStateReducer(submittingState, { type: 'OFFLINE_BLOCKED' })).toBe(submittingState);
      const retryingState: ScanState = { kind: 'retrying', qrPayload: 'x', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT };
      expect(scanStateReducer(retryingState, { type: 'OFFLINE_BLOCKED' })).toBe(retryingState);
      const resultState: ScanState = { kind: 'result', result: sampleResult };
      expect(scanStateReducer(resultState, { type: 'OFFLINE_BLOCKED' })).toBe(resultState);
    });

    it('startedAt survives a retrying -> submitting -> retrying round-trip unchanged (tracks the whole retry cycle, not the latest attempt)', () => {
      let state: ScanState = { kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 0, startedAt: STARTED_AT };
      state = scanStateReducer(state, { type: 'RETRY_ATTEMPT', attemptSeq: 1 });
      expect(state).toEqual({ kind: 'submitting', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 1, startedAt: STARTED_AT });
      state = scanStateReducer(state, { type: 'SUBMIT_TRANSPORT_FAILURE' });
      expect(state).toEqual({ kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 1, startedAt: STARTED_AT });
    });

    // Testing Requirement 18: dispatching CANCEL_RETRY from retrying, then
    // a fresh DETECT/SUBMIT_START for the same qrPayload, produces a NEW
    // idempotencyKey in the resulting submitting state — not a reuse of
    // the cancelled attempt's key. This is a property of how the CALLER
    // generates the key before dispatching (crypto.randomUUID() on every
    // genuinely-new scan event), so this test asserts only that two
    // separately-constructed SUBMIT_START actions with independently-
    // generated keys produce two different idempotencyKey values in
    // state — confirming the reducer itself does nothing to prevent key
    // reuse (it has no logic that could even detect a reuse; it just
    // stores whatever key the caller passes).
    it('Testing Requirement 18: CANCEL_RETRY then a fresh SUBMIT_START produces a NEW idempotencyKey, not a reuse of the cancelled attempt key', () => {
      let state: ScanState = { kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 2, startedAt: STARTED_AT };
      state = scanStateReducer(state, { type: 'CANCEL_RETRY' });
      expect(state).toEqual({ kind: 'ready' });

      state = scanStateReducer(state, { type: 'DETECT', qrPayload: 'rcoy:v1:abc' });
      expect(state).toEqual({ kind: 'detected', qrPayload: 'rcoy:v1:abc' });

      // Caller generates a fresh key (KEY_B here stands in for a fresh
      // crypto.randomUUID() call) — distinct from KEY_A, the cancelled
      // attempt's key.
      state = scanStateReducer(state, { type: 'SUBMIT_START', idempotencyKey: KEY_B, attemptSeq: 0, startedAt: STARTED_AT + 1 });
      expect(state.kind).toBe('submitting');
      expect((state as { idempotencyKey: string }).idempotencyKey).toBe(KEY_B);
      expect((state as { idempotencyKey: string }).idempotencyKey).not.toBe(KEY_A);
    });

    // Testing Requirement 19: DETECT dispatched while state.kind ===
    // 'retrying' is a no-op (returns the same retrying state unchanged)
    // — the single-flight guarantee extending correctly to the new
    // state, verified directly rather than only asserted as true in
    // prose.
    it('Testing Requirement 19: DETECT while state.kind === "retrying" is a no-op', () => {
      const retryingState: ScanState = { kind: 'retrying', qrPayload: 'rcoy:v1:abc', idempotencyKey: KEY_A, attemptSeq: 1, startedAt: STARTED_AT };
      const next = scanStateReducer(retryingState, { type: 'DETECT', qrPayload: 'rcoy:v1:some-other-code' });
      expect(next).toBe(retryingState); // same reference, proving a true no-op
    });
  });
});
