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
// submission still goes through scanQrAttemptConfirm, which re-runs
// requireScannerDeviceCaller + verifyScannerScope on the server for
// every single call, regardless of what this component thinks its own
// state is.
'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { scanQrAttemptConfirm } from '@/lib/attendance/scan-qr-attempt';
import { scanStateReducer, INITIAL_SCAN_STATE } from './scan-state-machine';
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

// The submission call (scanQrAttemptConfirm) throwing is ALWAYS a
// network/auth/server failure (bad connection, session expired, scope
// revoked mid-shift, unexpected RPC error) — never a scan outcome.
// 'invalid_qr' is a normal, successful ScanQrResult with
// result: 'invalid_qr'; it goes through the exact same
// getResultPresentation() path as every other live result below. These
// two failure modes must never be visually/textually merged: this
// synthetic severity+copy pair is what the submitFailure branch
// renders below, entirely independent of getResultPresentation.
const NETWORK_ERROR_SEVERITY: ResultSeverity = 'denied';

// Phase 7E — the scanner is online-only by design (see
// use-network-status.ts). Three distinct submission-failure shapes are
// tracked separately because they carry different operator meaning:
//   'offline-blocked'  browser was definitely offline BEFORE the call
//                       even started -> we never attempted the network
//                       request, so it certainly did not reach the
//                       server. Safe to say "not admitted."
//   'uncertain'        the call was attempted while the browser
//                       reported online, then failed. A generic
//                       fetch-layer error cannot distinguish "never
//                       left the device" from "reached the server but
//                       the response was lost" — so this NEVER claims
//                       an outcome, only asks the operator to verify
//                       before re-scanning (re-scanning is safe: the
//                       existing duplicate/idempotent result already
//                       covers a scan that actually went through).
//   'server'           kept for the original Phase 7D case: a request
//                       that completed but the server itself rejected
//                       (auth/scope/RPC error) — also never claims an
//                       outcome, same fixed copy as before.
type SubmitFailureKind = 'offline-blocked' | 'uncertain' | 'server';

export function ScannerClient({ sessionId }: { sessionId: string }) {
  const t = useTranslations('scanner');
  const [state, dispatch] = useReducer(scanStateReducer, INITIAL_SCAN_STATE);
  const [submitFailure, setSubmitFailure] = useState<SubmitFailureKind | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [muted, setMuted] = useState(false);
  const deviceIdentifierRef = useRef<string | null>(null);
  const feedbackFiredRef = useRef(false);
  const networkStatus = useNetworkStatus();

  useEffect(() => {
    deviceIdentifierRef.current = getOrCreateDeviceIdentifier();
    setMuted(isSoundMuted());
  }, []);

  useServiceWorker();

  const onDecode = useCallback((payload: string) => {
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
    // other failure below still genuinely attempts the submission.
    if (networkStatus === 'offline') {
      dispatch({ type: 'SUBMIT_START' });
      setSubmitFailure('offline-blocked');
      playScanFeedbackSound('denied');
      triggerScanFeedbackHaptic('denied');
      dispatch({ type: 'SUBMIT_ERROR' });
      return;
    }

    dispatch({ type: 'SUBMIT_START' });
    stop(); // pause decoding while a submission is in flight
    const wasOnlineAtSubmitTime = networkStatus === 'online';

    scanQrAttemptConfirm(qrPayload, sessionId, deviceIdentifierRef.current)
      .then((result) => {
        setSubmitFailure(null);
        dispatch({ type: 'SUBMIT_SUCCESS', result });
      })
      .catch((err) => {
        // Client-side console only — never sends the raw QR payload
        // itself, only the error the server action threw (e.g. an
        // authorization/scope message), matching the "no QR logging"
        // security requirement. The operator-facing side never sees
        // this message — see the submitFailure render branch below,
        // which uses only fixed i18n copy, never err.message or any
        // Supabase/SQLSTATE/RPC detail.
        console.error('scan submission failed', err);
        // A generic fetch-layer failure cannot distinguish "request
        // never left the device" from "reached the server but the
        // response was lost" — so unless the browser is offline RIGHT
        // NOW (checked live, not the value captured at submit time,
        // since connectivity can drop mid-request), this is treated as
        // uncertain and never claims "not admitted."
        const isOfflineNow = typeof navigator !== 'undefined' && navigator.onLine === false;
        const kind: SubmitFailureKind = isOfflineNow ? 'offline-blocked' : wasOnlineAtSubmitTime ? 'uncertain' : 'server';
        setSubmitFailure(kind);
        playScanFeedbackSound('denied');
        triggerScanFeedbackHaptic('denied');
        dispatch({ type: 'SUBMIT_ERROR' });
        start();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Fire sound/haptic feedback exactly once per result, as a render-time
  // side effect keyed on the result identity (scanAttemptId) rather than
  // inside the .then() above — keeps feedback bound to what's actually
  // on screen and immune to double-firing on re-render.
  useEffect(() => {
    if (state.kind !== 'result') return;
    if (feedbackFiredRef.current) return;
    feedbackFiredRef.current = true;
    const presentation = getResultPresentation(state.result.result);
    const severity = presentation?.severity ?? 'denied';
    playScanFeedbackSound(severity);
    triggerScanFeedbackHaptic(severity);
  }, [state]);

  // Synchronous, inside the real click handler — no intervening
  // useEffect/render — so qr-scanner's internal video.play() call stays
  // within the user-gesture window Safari requires. The <video> element
  // is always mounted (see above), so videoRef.current is always
  // non-null here.
  const handleScanNext = useCallback(() => {
    setSubmitFailure(null);
    setManualValue('');
    dispatch({ type: 'RESET' });
    start();
  }, [start]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      setSoundMuted(next);
      return next;
    });
  }, []);

  // Manual entry reuses the EXACT same DETECT action / state machine /
  // scanQrAttemptConfirm call the camera path uses — no second admission
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

        {/* Submission-failure overlay — a distinct, non-result failure
            mode from any live scan outcome (including invalid_qr, which
            is a normal successful result rendered via the branch
            above). Shares the same visual language (icon + headline +
            instruction) for a consistent operator experience, but only
            ever shows fixed i18n copy per SubmitFailureKind — never
            err.message or any backend detail. Critically, 'uncertain'
            and 'server' never claim "not admitted" — only
            'offline-blocked' does, because that is the one case we are
            actually certain the request never reached the server.
            state returns to 'ready' for every case (see SUBMIT_ERROR in
            scan-state-machine.ts), so camera/manual entry are
            immediately available again; no Scan Next button needed
            here. */}
        {submitFailure && state.kind === 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-4 text-center dark:bg-gray-900">
            <ResultIcon severity={NETWORK_ERROR_SEVERITY} />
            <h2 role="alert" className="text-lg font-semibold text-charcoal dark:text-gray-100">
              {submitFailure === 'offline-blocked' ? t('network.offlineBlocked') : t(`${submitFailure === 'uncertain' ? 'uncertainResult' : 'networkError'}.headline`)}
            </h2>
            {submitFailure !== 'offline-blocked' && (
              <p className="text-sm text-charcoal/80 dark:text-gray-300">
                {t(`${submitFailure === 'uncertain' ? 'uncertainResult' : 'networkError'}.instruction`)}
              </p>
            )}
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
              state machine, identical scanQrAttemptConfirm call,
              identical result/sound/haptic UX, and the same online-only
              rule (disabled while definitely offline, not just while
              not 'ready') so it can never fire a second, concurrent
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
