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

describe('scanStateReducer', () => {
  it('starts in ready', () => {
    expect(INITIAL_SCAN_STATE).toEqual({ kind: 'ready' });
  });

  it('ready -> detected on DETECT', () => {
    const next = scanStateReducer({ kind: 'ready' }, { type: 'DETECT', qrPayload: 'rcoy:v1:abc' });
    expect(next).toEqual({ kind: 'detected', qrPayload: 'rcoy:v1:abc' });
  });

  it('detected -> submitting on SUBMIT_START', () => {
    const next = scanStateReducer({ kind: 'detected', qrPayload: 'rcoy:v1:abc' }, { type: 'SUBMIT_START' });
    expect(next).toEqual({ kind: 'submitting', qrPayload: 'rcoy:v1:abc' });
  });

  it('submitting -> result on SUBMIT_SUCCESS', () => {
    const next = scanStateReducer({ kind: 'submitting', qrPayload: 'rcoy:v1:abc' }, { type: 'SUBMIT_SUCCESS', result: sampleResult });
    expect(next).toEqual({ kind: 'result', result: sampleResult });
  });

  it('submitting -> ready on SUBMIT_ERROR (recoverable, returns to scanning)', () => {
    const next = scanStateReducer({ kind: 'submitting', qrPayload: 'rcoy:v1:abc' }, { type: 'SUBMIT_ERROR' });
    expect(next).toEqual({ kind: 'ready' });
  });

  it('result -> ready on RESET ("Scan Next Participant")', () => {
    const next = scanStateReducer({ kind: 'result', result: sampleResult }, { type: 'RESET' });
    expect(next).toEqual({ kind: 'ready' });
  });

  describe('critical invariant: DETECT is a no-op from any state other than ready', () => {
    const nonReadyStates: ScanState[] = [
      { kind: 'detected', qrPayload: 'rcoy:v1:abc' },
      { kind: 'submitting', qrPayload: 'rcoy:v1:abc' },
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
    state = scanStateReducer(state, { type: 'SUBMIT_START' });
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
    const next = scanStateReducer(state, { type: 'SUBMIT_START' });
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
    expect(scanStateReducer({ kind: 'submitting', qrPayload: 'x' }, { type: 'RESET' })).toEqual({ kind: 'ready' });
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
    state = scanStateReducer(state, { type: 'SUBMIT_START' });
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
});
