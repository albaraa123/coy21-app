// src/components/scanner/use-scan-retry.test.ts
//
// Unit tests for the PURE decision functions use-scan-retry.ts exposes
// (nextBackoffDelayMs, isStaleAttempt) and the stateful retry controller
// (createScanRetryController), exercised as a plain factory function —
// no @testing-library/react in this repo, and a React hook's internals
// cannot be called outside a component render anyway (see use-scan-
// retry.ts's own header comment for why the stateful logic is a plain
// factory function wrapped by a thin useRef hook). Same "extract the
// decision logic, unit-test that" convention as use-network-status.ts
// and its own test file's header comment.
import { describe, expect, it, vi } from 'vitest';
import { nextBackoffDelayMs, isStaleAttempt, createScanRetryController } from './use-scan-retry';

describe('nextBackoffDelayMs', () => {
  it('doubles the previous delay', () => {
    expect(nextBackoffDelayMs(2000)).toBe(4000);
    expect(nextBackoffDelayMs(4000)).toBe(8000);
  });

  it('caps at 10 seconds', () => {
    expect(nextBackoffDelayMs(8000)).toBe(10_000);
    expect(nextBackoffDelayMs(10_000)).toBe(10_000);
  });
});

describe('isStaleAttempt', () => {
  it('returns false when both key and seq match the current guard', () => {
    expect(isStaleAttempt('key-a', 2, 'key-a', 2)).toBe(false);
  });

  it('returns true when the seq differs even though the key matches (retries intentionally reuse the same key across a whole retry cycle)', () => {
    expect(isStaleAttempt('key-a', 2, 'key-a', 1)).toBe(true);
  });

  it('returns true when the key differs even though the seq matches (a brand-new scan can coincidentally reuse seq 0)', () => {
    expect(isStaleAttempt('key-a', 0, 'key-b', 0)).toBe(true);
  });

  it('returns true when both key and seq differ', () => {
    expect(isStaleAttempt('key-a', 2, 'key-b', 5)).toBe(true);
  });
});

// --- createScanRetryController: stateful behavior, plain function calls ---

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createScanRetryController', () => {
  it('Testing Requirement 15: a fetch() rejection and a parsed { ok:false, retryable:true } body both dispatch the identical SUBMIT_TRANSPORT_FAILURE', async () => {
    const dispatchRejection = vi.fn();
    const fetchImplRejection = vi.fn().mockRejectedValue(new Error('network down'));
    const controllerRejection = createScanRetryController({ dispatch: dispatchRejection, fetchImpl: fetchImplRejection });
    controllerRejection.submit('rcoy:v1:abc', 'session-1', null, 'key-a', 0);
    await vi.waitFor(() => expect(dispatchRejection).toHaveBeenCalled());

    const dispatchRetryableBody = vi.fn();
    const fetchImplRetryableBody = vi.fn().mockResolvedValue(jsonResponse({ ok: false, retryable: true, reason: 'lock-contention' }));
    const controllerRetryableBody = createScanRetryController({ dispatch: dispatchRetryableBody, fetchImpl: fetchImplRetryableBody });
    controllerRetryableBody.submit('rcoy:v1:abc', 'session-1', null, 'key-a', 0);
    await vi.waitFor(() => expect(dispatchRetryableBody).toHaveBeenCalled());

    expect(dispatchRejection).toHaveBeenCalledWith({ type: 'SUBMIT_TRANSPORT_FAILURE' });
    expect(dispatchRetryableBody).toHaveBeenCalledWith({ type: 'SUBMIT_TRANSPORT_FAILURE' });
  });

  it('a non-2xx HTTP status is also treated as SUBMIT_TRANSPORT_FAILURE', async () => {
    const dispatch = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const controller = createScanRetryController({ dispatch, fetchImpl });
    controller.submit('rcoy:v1:abc', 'session-1', null, 'key-a', 0);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith({ type: 'SUBMIT_TRANSPORT_FAILURE' });
  });

  it('a parsed { ok:true, result } body dispatches SUBMIT_SUCCESS with the result', async () => {
    const dispatch = vi.fn();
    const sampleResult = {
      result: 'flexible_admitted',
      scanAttemptId: 'attempt-1',
      attendanceId: 'attendance-1',
      participantSummary: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: sampleResult }));
    const controller = createScanRetryController({ dispatch, fetchImpl });
    controller.submit('rcoy:v1:abc', 'session-1', null, 'key-a', 0);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith({ type: 'SUBMIT_SUCCESS', result: sampleResult });
  });

  it('Testing Requirement 14: a non-retryable rejection never triggers a second fetch via pollHealthThenRetry', async () => {
    const dispatch = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, retryable: false, message: 'Not authorized for this session/room' }));
    const controller = createScanRetryController({ dispatch, fetchImpl });
    controller.submit('rcoy:v1:abc', 'session-1', null, 'key-a', 0);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());

    expect(dispatch).toHaveBeenCalledWith({ type: 'SUBMIT_REJECTED', message: 'Not authorized for this session/room' });
    // Only the one call from submit() itself — SUBMIT_REJECTED never
    // leads into the retry/health-check loop, so fetchImpl is never
    // called a second time.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cancel() followed by a late-resolving mocked fetchImpl promise never produces a dispatch (stale-response guard, including the M6 health-check-after-cancel case)', async () => {
    const dispatch = vi.fn();
    let resolveHealthCheck!: (res: Response) => void;
    const healthCheckPromise = new Promise<Response>((resolve) => {
      resolveHealthCheck = resolve;
    });
    const fetchImpl = vi.fn().mockReturnValue(healthCheckPromise);
    const controller = createScanRetryController({ dispatch, fetchImpl });

    // Simulate already being in a retry cycle, then Cancel being clicked
    // mid-health-check (the health-check fetch is in flight).
    controller.pollHealthThenRetry('rcoy:v1:abc', 'session-1', null, 'key-a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    controller.cancel();

    // The health check now resolves 200 AFTER cancel — per the plan's
    // flagged M6 finding, this must NOT trigger a RETRY_ATTEMPT/submit().
    resolveHealthCheck(new Response(null, { status: 200 }));
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatch).not.toHaveBeenCalled();
    // And no second fetch (the would-be retry submission) was ever made.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cancel() aborts the in-flight health-check fetch via its AbortController (M6 wiring)', () => {
    const dispatch = vi.fn();
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const controller = createScanRetryController({ dispatch, fetchImpl });

    controller.pollHealthThenRetry('rcoy:v1:abc', 'session-1', null, 'key-a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const signal = init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    controller.cancel();

    expect(signal.aborted).toBe(true);
  });

  it('cancel() followed by a late-resolving SUBMIT fetch (not just health-check) never produces a dispatch', async () => {
    const dispatch = vi.fn();
    let resolveSubmit!: (res: Response) => void;
    const submitPromise = new Promise<Response>((resolve) => {
      resolveSubmit = resolve;
    });
    const fetchImpl = vi.fn().mockReturnValue(submitPromise);
    const controller = createScanRetryController({ dispatch, fetchImpl });

    controller.submit('rcoy:v1:abc', 'session-1', null, 'key-a', 0);
    controller.cancel();

    resolveSubmit(jsonResponse({ ok: true, result: { result: 'admitted', scanAttemptId: 'x', attendanceId: 'y', participantSummary: null } }));
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatch).not.toHaveBeenCalled();
  });
});
