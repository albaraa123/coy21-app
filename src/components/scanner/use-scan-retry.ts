// src/components/scanner/use-scan-retry.ts
//
// Sub-project 5b (offline scanning support) — the client-side auto-retry
// loop driving the scan-state-machine's 'retrying' state. Every scan
// submission (original AND retry) is a fetch() to the scan Route Handler
// (/api/scan-qr-attempt), never a Server Action call, per
// docs/superpowers/specs/2026-10-06-offline-scanning-support-design.md's
// platform-constraint decision (Next.js serializes Server Actions
// dispatched from the same client, so a retry would otherwise queue
// behind a hung original request).
//
// A React hook's internals cannot be called or tested outside a
// component render — there's no renderer in this repo (no
// @testing-library/react) to produce a live hook instance to call into.
// So the actual stateful retry logic below is written as a plain,
// non-hook factory function (createScanRetryController), unit-tested
// directly via plain function calls in use-scan-retry.test.ts (mocked
// dispatch/fetchImpl, no React involved at all) — same "extract the
// decision logic, unit-test that" convention as scan-state-machine.ts
// and use-network-status.ts, just one level deeper since this module
// also carries stateful (timer/AbortController) behavior that those
// pure-function-only siblings don't have to.
//
// useScanRetry itself is a thin wrapper around the factory, constructing
// exactly one controller instance per component lifetime and exposing
// its methods to scanner-client.tsx. Uses useState's lazy initializer
// rather than a useRef + "assign during render if null" check (the
// plan's own original sketch) — React's react-hooks/refs lint rule
// flags reading ref.current during render at all, even guarded by a
// null check, so useState(() => ...) is the lint-clean equivalent:
// still constructed exactly once, on mount, never set again afterward.
'use client';

import { useState } from 'react';
import type { ScanAction } from './scan-state-machine';

// --- Pure functions (TDD Step 5) ---------------------------------------

export function nextBackoffDelayMs(previousDelayMs: number): number {
  return Math.min(previousDelayMs * 2, 10_000);
}

// True means "discard this response -- it belongs to a superseded
// attempt." Must compare BOTH key and seq: retries intentionally reuse
// the same idempotencyKey across a whole retry cycle, so a seq-only or
// key-only comparison alone cannot tell a stale response for attempt N
// apart from the current attempt N+1 that happens to share the same key
// (or, across a brand-new scan, happens to reuse seq 0).
export function isStaleAttempt(guardKey: string, guardSeq: number, responseKey: string, responseSeq: number): boolean {
  return responseKey !== guardKey || responseSeq !== guardSeq;
}

// --- Stateful factory function (TDD Step 7) -----------------------------

export interface ScanRetryDeps {
  dispatch: (action: ScanAction) => void;
  fetchImpl: typeof fetch; // injectable for tests
}

export function createScanRetryController(deps: ScanRetryDeps) {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 2000;
  const guard = { idempotencyKey: '', attemptSeq: -1 };
  // Tracks the in-flight health-check fetch's own AbortController, so
  // cancel() can abort it directly — review's M6 finding: without this,
  // a health check that resolves 200 AFTER Cancel was clicked would
  // still call submit() again, since isStaleAttempt alone only stops the
  // RESULTING dispatch, not the pollHealthThenRetry callback from
  // running far enough to call submit() in the first place. Aborting the
  // fetch itself makes it reject before that callback ever runs.
  let healthCheckController: AbortController | null = null;

  function submit(qrPayload: string, sessionId: string, deviceIdentifier: string | null, idempotencyKey: string, attemptSeq: number) {
    guard.idempotencyKey = idempotencyKey;
    guard.attemptSeq = attemptSeq;
    // attemptSeq 0 only ever occurs on a genuinely new scan's first
    // submission (RETRY_ATTEMPT always increments from the guard's
    // current value, never back to 0) -- resetting backoffMs here, not
    // just in cancel(), closes the gap where a NEW scan's first retry
    // would otherwise silently inherit a prior cycle's climbed-up delay
    // if that prior cycle ended by actually succeeding/being rejected
    // rather than by an explicit Cancel click.
    if (attemptSeq === 0) backoffMs = 2000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    deps
      .fetchImpl('/api/scan-qr-attempt', {
        method: 'POST',
        body: JSON.stringify({ qrPayload, sessionId, deviceIdentifier, idempotencyKey }),
        signal: controller.signal,
      })
      .then(async (res) => {
        clearTimeout(timeout);
        if (isStaleAttempt(guard.idempotencyKey, guard.attemptSeq, idempotencyKey, attemptSeq)) return;
        if (!res.ok) {
          deps.dispatch({ type: 'SUBMIT_TRANSPORT_FAILURE' });
          return;
        }
        const outcome = await res.json().catch(() => null);
        // await res.json() is a second real suspension point -- another
        // submit() call (e.g. a RETRY_ATTEMPT firing while this response
        // body was still being parsed) could have already overwritten
        // `guard` by the time control resumes here. The check above, run
        // before this await, cannot catch that: it must be repeated now,
        // immediately before any dispatch that uses `outcome`, or a
        // stale attempt's result can reach the reducer after a newer
        // attempt has already taken over 'submitting'.
        if (isStaleAttempt(guard.idempotencyKey, guard.attemptSeq, idempotencyKey, attemptSeq)) return;
        if (!outcome) {
          deps.dispatch({ type: 'SUBMIT_TRANSPORT_FAILURE' });
          return;
        }
        if (outcome.ok) deps.dispatch({ type: 'SUBMIT_SUCCESS', result: outcome.result });
        else if (outcome.retryable) deps.dispatch({ type: 'SUBMIT_TRANSPORT_FAILURE' });
        else deps.dispatch({ type: 'SUBMIT_REJECTED', message: outcome.message });
      })
      .catch(() => {
        clearTimeout(timeout);
        if (isStaleAttempt(guard.idempotencyKey, guard.attemptSeq, idempotencyKey, attemptSeq)) return;
        deps.dispatch({ type: 'SUBMIT_TRANSPORT_FAILURE' });
      });
  }

  function pollHealthThenRetry(qrPayload: string, sessionId: string, deviceIdentifier: string | null, idempotencyKey: string) {
    const controller = new AbortController();
    // Store this controller where cancel() below can reach it, so a
    // Cancel click can abort an in-flight health-check fetch too (see
    // the header comment on healthCheckController above).
    healthCheckController = controller;
    const attemptSeqAtPollTime = guard.attemptSeq;
    deps
      .fetchImpl('/api/scanner-health', { signal: controller.signal, cache: 'no-store' })
      .then((res) => {
        if (healthCheckController === controller) healthCheckController = null;
        if (isStaleAttempt(guard.idempotencyKey, guard.attemptSeq, idempotencyKey, attemptSeqAtPollTime)) return;
        if (res.status === 200) {
          backoffMs = 2000;
          const nextSeq = guard.attemptSeq + 1;
          deps.dispatch({ type: 'RETRY_ATTEMPT', attemptSeq: nextSeq });
          submit(qrPayload, sessionId, deviceIdentifier, idempotencyKey, nextSeq);
        } else if (res.status === 401) {
          deps.dispatch({ type: 'RETRY_ABORTED', message: 'Scanner session expired — please re-authenticate' });
        } else {
          backoffMs = nextBackoffDelayMs(backoffMs);
          timerId = setTimeout(() => pollHealthThenRetry(qrPayload, sessionId, deviceIdentifier, idempotencyKey), backoffMs);
        }
      })
      .catch(() => {
        if (healthCheckController === controller) healthCheckController = null;
        // An aborted fetch (cancel() called mid-flight) also lands here
        // — isStaleAttempt is checked first by convention elsewhere, but
        // for an aborted health check there is nothing further to do
        // regardless: cancel() has already cleared any pending retry
        // timer, so simply not scheduling a new one is correct. Still
        // guard explicitly so a genuine transport-rejected (non-abort)
        // health check for an attempt that's since been superseded by a
        // NEWER retry cycle doesn't double-schedule a poll.
        if (isStaleAttempt(guard.idempotencyKey, guard.attemptSeq, idempotencyKey, attemptSeqAtPollTime)) return;
        backoffMs = nextBackoffDelayMs(backoffMs);
        timerId = setTimeout(() => pollHealthThenRetry(qrPayload, sessionId, deviceIdentifier, idempotencyKey), backoffMs);
      });
  }

  function cancel() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    // Abort any in-flight health-check fetch (M6 wiring) — this makes
    // its promise reject/settle before pollHealthThenRetry's own .then()
    // callback can call submit() again.
    if (healthCheckController) {
      healthCheckController.abort();
      healthCheckController = null;
    }
    guard.attemptSeq = -999; // sentinel that can never match a real attemptSeq
    // Reset explicitly on Cancel too (not just relying on the next scan's
    // attemptSeq === 0 reset in submit()), so a cancelled cycle never
    // leaves a climbed-up backoff value sitting in this closure for
    // longer than necessary -- belt-and-suspenders with the submit() reset.
    backoffMs = 2000;
  }

  return { submit, pollHealthThenRetry, cancel };
}

export type ScanRetryController = ReturnType<typeof createScanRetryController>;

// --- Thin hook wrapper ---------------------------------------------------

export function useScanRetry(dispatch: (action: ScanAction) => void): ScanRetryController {
  // useState's lazy initializer (not a useRef + "if null, assign during
  // render" check) — React's react-hooks/refs lint rule flags reading
  // ref.current during render, even guarded by a null check, since refs
  // are meant to be read/written only in effects/event handlers. A
  // useState lazy initializer runs exactly once (on mount, same as the
  // ref pattern would have), is an explicitly React-sanctioned way to
  // construct a value once without a render-time ref read, and the
  // state value itself is never subsequently set again, so this never
  // triggers a re-render of its own.
  const [controller] = useState<ScanRetryController>(() => createScanRetryController({ dispatch, fetchImpl: fetch }));
  return controller;
}
