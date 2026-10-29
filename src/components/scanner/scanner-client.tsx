// src/components/scanner/scanner-client.tsx
//
// Phase 7C — real camera capture + submission through the trusted Phase
// 7A server boundary. Phase 7D — result presentation, operator feedback
// (sound/haptic), and error-state polish layered on top of that same
// flow, with zero changes to attendance/admission business logic, QR
// parsing/crypto, or the Phase 7A security boundary.
//
// This is the ONLY client component in the scanner flow; page.tsx
// (Server Component) does all authorization/assignment loading and
// passes only sessionId in as a prop — this component never re-derives
// or trusts anything about the caller's identity/scope itself, since
// that would duplicate server-side authorization in the browser. Every
// submission (original AND retry) goes through a fetch() to
// /api/scan-qr-attempt (see use-scan-retry.ts), which re-runs
// requireScannerDeviceCaller + verifyScannerScope on the server for
// every single call, regardless of what this component thinks its own
// state is. Sub-project 5b (offline scanning support) moved this off
// the former Server Action (scanQrAttemptConfirm) onto a Route Handler
// specifically so a retry's fetch() never queues behind a hung original
// request the way Next.js serializes same-client Server Action calls.
'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { scanStateReducer, INITIAL_SCAN_STATE } from './scan-state-machine';
import { useScanRetry } from './use-scan-retry';
import { useQrScanner } from './use-qr-scanner';
import { getOrCreateDeviceIdentifier } from './device-identifier';
import { getResultPresentation, type ResultSeverity } from './result-presentation';
import { ResultIcon } from './result-icon';
import { isSoundMuted, setSoundMuted, playScanFeedbackSound, triggerScanFeedbackHaptic } from './scan-feedback';
import { useNetworkStatus } from './use-network-status';
import { useWakeLock } from './use-wake-lock';
import { useServiceWorker } from './use-service-worker';
import { InstallGuidance } from './install-guidance';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/states/error-state';

// A non-'result' failure outcome is ALWAYS a network/auth/server
// failure (bad connection, session expired, scope revoked mid-shift,
// unexpected RPC error) — never a scan outcome. 'invalid_qr' is a
// normal, successful ScanQrResult with result: 'invalid_qr'; it goes
// through the exact same getResultPresentation() path as every other
// live result below. These two failure modes must never be
// visually/textually merged: this synthetic severity+copy pair is what
// the submitFailure/lastRejection branches render below, entirely
// independent of getResultPresentation.
const NETWORK_ERROR_SEVERITY: ResultSeverity = 'denied';

// Phase 7E — the scanner is online-only by design for the definite-
// offline case (see use-network-status.ts). Sub-project 5b (offline
// scanning support) replaces the old ad-hoc 'uncertain'/'server'
// classification with the state machine's own 'retrying' state plus a
// dedicated lastRejection message: a transport-shaped failure now
// enters 'retrying' and auto-retries via use-scan-retry.ts instead of
// immediately bouncing back to 'ready' with a generic "uncertain"
// message, and a genuine non-retryable server rejection surfaces its
// real message via lastRejection rather than a fixed 'server' copy. The
// only submission-failure shape still handled here as a one-shot,
// non-retrying overlay is the definite-offline short-circuit, which
// never attempted a network call at all and is therefore certain
// ("not admitted"), unlike every other failure mode above.
type SubmitFailureKind = 'offline-blocked';

export function ScannerClient({ sessionId }: { sessionId: string }) {
  const t = useTranslations('scanner');
  const [state, dispatch] = useReducer(scanStateReducer, INITIAL_SCAN_STATE);
  const [submitFailure, setSubmitFailure] = useState<SubmitFailureKind | null>(null);
  // Sibling (not inside the reducer's own state) piece of state, per the
  // design spec's own instruction: SUBMIT_REJECTED's and RETRY_ABORTED's
  // message must be surfaced somewhere the 'ready' state can render it,
  // since 'ready' itself carries no data. Cleared on the next DETECT.
  const [lastRejection, setLastRejection] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [muted, setMuted] = useState(false);
  const deviceIdentifierRef = useRef<string | null>(null);
  const feedbackFiredRef = useRef(false);
  const networkStatus = useNetworkStatus();
  // Wraps the raw reducer dispatch so SUBMIT_REJECTED/RETRY_ABORTED —
  // both dispatched from inside use-scan-retry.ts, never directly from
  // this component — also synchronously set lastRejection in the same
  // tick as the real state transition, since the reducer itself never
  // stores the message (see scan-state-machine.ts's header comment on
  // where lastRejection lives). useCallback with an empty dep array:
  // dispatch from useReducer is referentially stable across renders, so
  // this wrapper is created once and `retry`'s single controller
  // instance always calls the latest logic without needing to be
  // recreated.
  const dispatchWithRejectionTracking = useCallback(
    (action: Parameters<typeof dispatch>[0]) => {
      if (action.type === 'SUBMIT_REJECTED' || action.type === 'RETRY_ABORTED') {
        setLastRejection(action.message);
      }
      dispatch(action);
    },
    [dispatch]
  );
  const retry = useScanRetry(dispatchWithRejectionTracking);
  // setInterval tick (not a render-time Date.now() check): calling
  // Date.now() directly during render is an impure call React's own
  // lint rule (react-hooks/purity) flags, since it can produce
  // unstable results that update unpredictably when the component
  // happens to re-render for an unrelated reason. A ticking interval
  // that re-evaluates and setState()s only when the 30-second threshold
  // is actually crossed keeps the check itself inside an effect/event
  // callback instead, where impure calls are allowed.
  // Records the startedAt of whichever retry cycle most recently
  // crossed the 30-second threshold — compared against the CURRENT
  // state's own startedAt below, rather than a plain boolean, so a
  // brand-new retry cycle (new startedAt, from a fresh scan) never
  // inherits "already past 30s" from a previous cycle that happened to
  // leave this set.
  const [retryThresholdCrossedAt, setRetryThresholdCrossedAt] = useState<number | null>(null);
  // Derived at render time from plain state (no impure Date.now() read
  // here) — false the instant state.kind leaves 'retrying' or a new
  // cycle's startedAt no longer matches, with no separate "reset"
  // setState call needed in the effect below.
  const showRetryPersistentMessage =
    state.kind === 'retrying' && retryThresholdCrossedAt !== null && retryThresholdCrossedAt === state.startedAt;
  useEffect(() => {
    if (state.kind !== 'retrying') return;
    const startedAt = state.startedAt;
    const tick = () => {
      if (Date.now() - startedAt >= 30_000) setRetryThresholdCrossedAt(startedAt);
    };
    tick(); // covers re-entering retrying after already having waited 30s+ this cycle (startedAt survives the round-trip)
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [state]);

  useEffect(() => {
    deviceIdentifierRef.current = getOrCreateDeviceIdentifier();
    setMuted(isSoundMuted());
  }, []);

  useServiceWorker();

  const onDecode = useCallback((payload: string) => {
    // Cleared here (not inside the detect-effect below) so this stays
    // outside any effect body — React's react-hooks/set-state-in-effect
    // rule flags a setState() call synchronously inside an effect, but
    // onDecode runs from qr-scanner's own decode-loop callback, not from
    // render/an effect, so this is an ordinary event-callback-driven
    // state update.
    setLastRejection(null);
    dispatch({ type: 'DETECT', qrPayload: payload });
  }, []);

  const { videoRef, status: cameraStatus, start, stop } = useQrScanner(onDecode);

  // Keeps the screen awake only while there's actually something to
  // watch for — camera active, awaiting a result. Never active while a
  // camera-permission error state is shown (nothing to keep awake for).
  useWakeLock(cameraStatus === 'active');

  // Camera is requested once, on mount — page.tsx only renders this
  // component after authorization + a valid assignment are already
  // established, never earlier. The <video> element itself stays
  // mounted for the ENTIRE lifetime of this component (see the JSX
  // below: the result state overlays on top of it rather than
  // unmounting it) specifically so that resuming playback after "Scan
  // Next Participant" can happen synchronously inside that click
  // handler — iOS Safari only permits video.play() when it runs
  // directly inside a real user-gesture handler; deferring it to a
  // useEffect that fires on a LATER render (the original bug here) loses
  // that direct connection to the tap and Safari silently blocks
  // playback, producing a black frame with no visible error.
  useEffect(() => {
    start();
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The actual submission effect — runs exactly once per 'detected'
  // state, driven by the reducer's own invariant (DETECT is a no-op from
  // any non-ready state), not by this effect's own guarding alone. This
  // is also the sole mechanism preventing a held-up QR in frame from
  // re-submitting: once DETECT moves state out of 'ready', qr-scanner's
  // onDecode may keep firing on every frame, but scanStateReducer's own
  // DETECT-only-from-ready rule makes every further decode of the same
  // (or any) code a no-op until RESET.
  useEffect(() => {
    if (state.kind !== 'detected') return;
    const qrPayload = state.qrPayload;
    feedbackFiredRef.current = false;

    // Definite-offline short-circuit: the browser told us before we
    // even tried, so this request never reached the server — safe to
    // say plainly that scanning is unavailable, no ambiguity. This is
    // the ONLY case allowed to skip the network call entirely; every
    // other failure below still genuinely attempts the submission. A
    // dedicated OFFLINE_BLOCKED action (ready/detected -> ready) is used
    // instead of SUBMIT_START/SUBMIT_ERROR — this was never a real
    // submission attempt, so it needs no idempotencyKey/attemptSeq.
    if (networkStatus === 'offline') {
      setSubmitFailure('offline-blocked');
      playScanFeedbackSound('denied');
      triggerScanFeedbackHaptic('denied');
      dispatch({ type: 'OFFLINE_BLOCKED' });
      return;
    }

    setSubmitFailure(null);
    const idempotencyKey = crypto.randomUUID();
    const attemptSeq = 0;
    const startedAt = Date.now();
    dispatch({ type: 'SUBMIT_START', idempotencyKey, attemptSeq, startedAt });
    stop(); // pause decoding while a submission is in flight
    retry.submit(qrPayload, sessionId, deviceIdentifierRef.current, idempotencyKey, attemptSeq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Every scan submission (original AND retry) goes through
  // retry.submit/retry.pollHealthThenRetry — which dispatch directly,
  // never throw into this component — so there is no .then()/.catch()
  // here to drive SUBMIT_SUCCESS/SUBMIT_TRANSPORT_FAILURE/
  // SUBMIT_REJECTED; this effect only reacts to the resulting state to
  // drive UI-only side effects (feedback sound/haptic, camera
  // stop/resume, lastRejection) that must run regardless of which
  // dispatch path produced them.
  useEffect(() => {
    if (state.kind === 'retrying' && !feedbackFiredRef.current) {
      feedbackFiredRef.current = true;
      playScanFeedbackSound('denied');
      triggerScanFeedbackHaptic('denied');
    }
  }, [state]);

  // What actually triggers the retry call after RETRY_ATTEMPT: the
  // effect above only fires on entry into 'detected' (a brand-new scan),
  // never on 'retrying' -> 'submitting' via RETRY_ATTEMPT. This second
  // effect is the new wiring the reducer transition alone does not
  // provide — see design spec line 146. It starts the health-check poll
  // loop as soon as the state machine enters 'retrying' (whether from
  // the very first SUBMIT_TRANSPORT_FAILURE or a later one in the same
  // cycle), and the actual RETRY_ATTEMPT -> submitting fetch() is issued
  // from inside retry.pollHealthThenRetry itself (see use-scan-retry.ts),
  // not from this effect.
  useEffect(() => {
    if (state.kind !== 'retrying') return;
    const { qrPayload, idempotencyKey } = state;
    retry.pollHealthThenRetry(qrPayload, sessionId, deviceIdentifierRef.current, idempotencyKey);

    // Listen for the browser's own 'online' event while in 'retrying':
    // on fire, immediately run one health-check attempt out-of-cycle
    // (don't wait for the next poll tick). pollHealthThenRetry itself
    // schedules its own next tick on failure, so calling it again here
    // on 'online' is safe — it will simply race with (and, on success,
    // short-circuit) whatever the existing backoff timer was waiting on,
    // since RETRY_ATTEMPT firing twice for the same cycle is itself
    // guarded by the reducer only accepting it from 'retrying'.
    const handleOnline = () => retry.pollHealthThenRetry(qrPayload, sessionId, deviceIdentifierRef.current, idempotencyKey);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Fire sound/haptic feedback exactly once per result, as a render-time
  // side effect keyed on the result identity (scanAttemptId) rather than
  // inside a .then() — keeps feedback bound to what's actually on
  // screen and immune to double-firing on re-render.
  useEffect(() => {
    if (state.kind !== 'result') return;
    if (feedbackFiredRef.current) return;
    feedbackFiredRef.current = true;
    const presentation = getResultPresentation(state.result.result);
    const severity = presentation?.severity ?? 'denied';
    playScanFeedbackSound(severity);
    triggerScanFeedbackHaptic(severity);
  }, [state]);

  // Resumes the camera whenever the state machine lands back in 'ready'
  // coming from a non-ready state (submitting/retrying/detected) rather
  // than from 'result' (which uses its own explicit handleScanNext
  // button, not an automatic resume) — covers SUBMIT_REJECTED,
  // RETRY_ABORTED, and the OFFLINE_BLOCKED short-circuit alike, all of
  // which land in 'ready' without the user having clicked anything.
  // Also surfaces SUBMIT_REJECTED's/RETRY_ABORTED's message via
  // lastRejection, set synchronously by the dispatch wrapper below
  // rather than here, so this effect only needs to resume the camera.
  const previousStateKindRef = useRef(state.kind);
  useEffect(() => {
    const previousKind = previousStateKindRef.current;
    previousStateKindRef.current = state.kind;
    if (state.kind !== 'ready') return;
    if (previousKind === 'submitting' || previousKind === 'retrying' || previousKind === 'detected') {
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  // Synchronous, inside the real click handler — no intervening
  // useEffect/render — so qr-scanner's internal video.play() call stays
  // within the user-gesture window Safari requires. The <video> element
  // is always mounted (see above), so videoRef.current is always
  // non-null here.
  const handleScanNext = useCallback(() => {
    setSubmitFailure(null);
    setLastRejection(null);
    setManualValue('');
    dispatch({ type: 'RESET' });
    start();
  }, [start]);

  // Cancel button: must, SYNCHRONOUSLY within this same click handler
  // (no intervening await/useEffect), call retry.cancel(), then
  // dispatch CANCEL_RETRY, then start() — in exactly that order, per
  // the design spec's iOS-Safari user-gesture requirement (video.play()
  // is only permitted inside a direct user-gesture callback, never a
  // later .then() or state-effect callback). retry.cancel() first so
  // the stale-response guard is updated before CANCEL_RETRY changes
  // state (not that order matters for correctness here, since cancel()
  // and the reducer update independent pieces of state, but this
  // ordering matches the plan's own step-by-step description exactly).
  const handleCancelRetry = useCallback(() => {
    retry.cancel();
    dispatch({ type: 'CANCEL_RETRY' });
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  // "Try Now": active throughout 'retrying', triggers the same
  // immediate health-check-then-retry path the background poll loop
  // uses — not a separate code path, just an out-of-cycle invocation of
  // the same pollHealthThenRetry the poll timer already calls.
  const handleTryNow = useCallback(() => {
    if (state.kind !== 'retrying') return;
    retry.pollHealthThenRetry(state.qrPayload, sessionId, deviceIdentifierRef.current, state.idempotencyKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, sessionId]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      setSoundMuted(next);
      return next;
    });
  }, []);

  // Manual entry reuses the EXACT same DETECT action / state machine /
  // retry.submit() call the camera path uses — no second admission
  // workflow, no separate validation, no separate result UX. Only
  // reachable while 'ready' (the reducer's own no-op-from-non-ready
  // invariant already blocks a second dispatch while
  // submitting/showing a result; the input is also disabled below as a
  // UX-level reinforcement of the same rule).
  const submitManualValue = useCallback(() => {
    const trimmed = manualValue.trim();
    if (!trimmed) return;
    // Manual entry funnels through the exact same DETECT -> submission
    // effect as the camera path (see the effect above), so it inherits
    // the same offline short-circuit automatically — no separate check
    // needed here beyond that shared path.
    setLastRejection(null);
    dispatch({ type: 'DETECT', qrPayload: trimmed });
    setManualValue('');
  }, [manualValue]);

  const handleManualFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitManualValue();
    },
    [submitManualValue]
  );

  if (cameraStatus === 'permission_denied') {
    return (
      <ErrorState
        title={t('camera.permissionDenied.title')}
        description={t('camera.permissionDenied.description')}
        onRetry={start}
      />
    );
  }
  if (cameraStatus === 'unavailable') {
    return <ErrorState title={t('camera.unavailable.title')} description={t('camera.unavailable.description')} onRetry={start} />;
  }
  if (cameraStatus === 'error') {
    return <ErrorState title={t('camera.error.title')} description={t('camera.error.description')} onRetry={start} />;
  }

  const isResult = state.kind === 'result';
  const presentation = isResult ? getResultPresentation(state.result.result) : null;
  // presentation === null only if a 10th, unrecognized result value ever
  // reached the client — treated as its own explicit "denied" look
  // rather than silently falling through to a success/neutral
  // appearance (see result-presentation.ts's own exhaustiveness
  // guarantee).
  const severity: ResultSeverity | null = isResult ? (presentation?.severity ?? 'denied') : null;
  const isSubmitting = state.kind === 'submitting';

  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-charcoal/10 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="flex w-full max-w-[280px] justify-end">
        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={muted}
          className="rounded-md px-2 py-1 text-xs font-medium text-charcoal/60 hover:text-charcoal dark:text-gray-400 dark:hover:text-gray-200"
        >
          {muted ? t('soundOff') : t('soundOn')}
          <span className="sr-only"> — {muted ? t('unmuteSounds') : t('muteSounds')}</span>
        </button>
      </div>

      <div className="relative w-full max-w-[280px] overflow-hidden rounded-lg bg-black">
        {/* qr-scanner attaches its own decode loop directly to this
            element; no additional canvas/overlay markup needed here.
            ALWAYS mounted (never conditionally rendered) — see the
            effect above for why. Hidden behind the result overlay via
            CSS, not unmounted, while state.kind === 'result'. */}
        <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline aria-label={t('readyToScan')} />

        {isSubmitting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/90 p-4 text-center dark:bg-gray-900/90">
            <p role="status" aria-live="polite" className="text-sm font-medium text-charcoal dark:text-gray-100">
              {t('processing')}
            </p>
            <p className="text-xs text-charcoal/60 dark:text-gray-400">{t('processingHint')}</p>
          </div>
        )}

        {/* 'retrying' overlay — the auto-retry loop is running
            (background health-check poll, 2s doubling to a 10s ceiling).
            "Try Now" and "Cancel" are visible throughout the whole
            retrying state, not just after the 30-second threshold; the
            persistent message below is additive, purely informational,
            and never pauses/alters the background poll loop itself —
            continuing to retry silently was the original problem being
            fixed, not something to preserve. */}
        {state.kind === 'retrying' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/95 p-4 text-center dark:bg-gray-900/95">
            <ResultIcon severity={NETWORK_ERROR_SEVERITY} />
            <p role="status" aria-live="polite" className="text-sm font-medium text-charcoal dark:text-gray-100">
              {t('retrying.message')}
            </p>
            {showRetryPersistentMessage && (
              <p className="text-xs text-charcoal/70 dark:text-gray-400">{t('retrying.persistentMessage')}</p>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleTryNow}>
                {t('retrying.tryNow')}
              </Button>
              <Button size="sm" variant="secondary" onClick={handleCancelRetry}>
                {t('retrying.cancel')}
              </Button>
            </div>
          </div>
        )}

        {isResult && severity && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-4 text-center dark:bg-gray-900">
            <ResultIcon severity={severity} />
            <h2 className="text-lg font-semibold text-charcoal dark:text-gray-100" role="status">
              {presentation ? t(presentation.headlineKey) : state.result.result}
            </h2>
            {presentation && <p className="text-sm text-charcoal/80 dark:text-gray-300">{t(presentation.instructionKey)}</p>}
            {state.result.participantSummary && (
              <div className="text-sm text-charcoal/80 dark:text-gray-300">
                <p className="font-medium">{state.result.participantSummary.fullName}</p>
                {state.result.participantSummary.country && (
                  <p>
                    {t('result.countryLabel')}: {state.result.participantSummary.country}
                  </p>
                )}
                {state.result.participantSummary.nationality && (
                  <p>
                    {t('result.nationalityLabel')}: {state.result.participantSummary.nationality}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Submission-failure overlay — the definite-offline
            short-circuit only (every other failure mode now goes
            through the 'retrying' overlay above, or lastRejection
            below). Shares the same visual language (icon + headline)
            for a consistent operator experience, but only ever shows
            fixed i18n copy — never err.message or any backend detail.
            state returns to 'ready' (see OFFLINE_BLOCKED in
            scan-state-machine.ts), so camera/manual entry are
            immediately available again; no Scan Next button needed
            here. */}
        {submitFailure && state.kind === 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-4 text-center dark:bg-gray-900">
            <ResultIcon severity={NETWORK_ERROR_SEVERITY} />
            <h2 role="alert" className="text-lg font-semibold text-charcoal dark:text-gray-100">
              {t('network.offlineBlocked')}
            </h2>
          </div>
        )}

        {/* lastRejection overlay — surfaces SUBMIT_REJECTED's (a
            deterministic, non-retryable server denial — auth/scope/RPC
            error) or RETRY_ABORTED's (the health check's own 401:
            "re-authenticate") message. Both land the state machine back
            in 'ready' with no data of their own, which is exactly why
            lastRejection exists as a sibling piece of state (see this
            component's top-level comment). Mutually exclusive with the
            offline-blocked overlay above in practice (lastRejection is
            only ever set from a dispatch that implies a request really
            was attempted), but guarded by !submitFailure anyway so the
            two overlays can never stack. */}
        {lastRejection && !submitFailure && state.kind === 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-4 text-center dark:bg-gray-900">
            <ResultIcon severity={NETWORK_ERROR_SEVERITY} />
            <h2 role="alert" className="text-lg font-semibold text-charcoal dark:text-gray-100">
              {t('networkError.headline')}
            </h2>
            <p className="text-sm text-charcoal/80 dark:text-gray-300">{lastRejection}</p>
          </div>
        )}
      </div>

      {isResult ? (
        <Button onClick={handleScanNext}>{t('scanNextParticipant')}</Button>
      ) : (
        <>
          {/* Online-only operational indicator (Phase 7E) — small,
              unobtrusive, never the only signal blocking a scan (the
              offline-blocked overlay above already covers that): this
              is purely informational so the operator understands why
              scanning might be unavailable before they even try. */}
          <p className="flex items-center gap-1.5 text-xs text-charcoal/50 dark:text-gray-500">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${networkStatus === 'online' ? 'bg-turquoise-dark dark:bg-turquoise' : 'bg-red-600 dark:bg-red-400'}`}
            />
            {networkStatus === 'online' ? t('network.online') : t('network.offline')}
          </p>

          {state.kind === 'ready' && cameraStatus === 'requesting' && !submitFailure && (
            <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('camera.requestingPermission')}</p>
          )}
          {state.kind === 'ready' && cameraStatus === 'active' && !submitFailure && (
            <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('readyDescription')}</p>
          )}

          {state.kind === 'ready' && <InstallGuidance />}

          {/* Secondary/collapsible fallback — camera scanning remains the
              primary workflow. Reuses the exact same submission path as
              camera detection (see submitManualValue above): identical
              state machine, identical retry.submit() call, identical
              result/sound/haptic UX, and the same online-only rule
              (disabled while definitely offline, not just while not
              'ready') so it can never fire a second, concurrent
              submission alongside an in-flight camera-triggered one. */}
          <details className="w-full">
            <summary className="cursor-pointer text-center text-xs font-medium text-charcoal/60 dark:text-gray-400">
              {t('manualEntry')}
            </summary>
            <form onSubmit={handleManualFormSubmit} className="mt-2 flex gap-2">
              <input
                type="text"
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                placeholder={t('manualEntryPlaceholder')}
                disabled={state.kind !== 'ready' || networkStatus === 'offline'}
                className="min-w-0 flex-1 rounded-md border border-charcoal/20 bg-white px-3 py-2 text-sm text-charcoal disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
              <Button
                size="sm"
                disabled={state.kind !== 'ready' || manualValue.trim() === '' || networkStatus === 'offline'}
                onClick={submitManualValue}
              >
                {t('manualEntrySubmit')}
              </Button>
            </form>
          </details>
        </>
      )}
    </div>
  );
}
