// src/components/scanner/cafeteria-scanner-client.tsx
//
// Explicitly simple per the confirmed scope decision (no offline retry,
// no wake-lock, no sound/haptic — "نطوره لاحقاً لو احتجنا"). That
// sophistication lives in scanner-client.tsx (the existing /scanner
// route) and is deliberately NOT duplicated here. Reuses useQrScanner
// (the pure camera-decode hook) as-is.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQrScanner, type CameraStatus } from './use-qr-scanner';
import { Button } from '@/components/ui/button';

type ScanResult = 'admitted' | 'already_used_today' | 'ineligible' | 'invalid_qr' | 'error';

// Color families only — the actual label/instruction text is translated
// via t(`cafeteria.result.${lastResult}`.headline/.instruction) below
// rather than hardcoded here, matching result-presentation.ts's
// precedent (this codebase is bilingual throughout, and a cafeteria
// worker may need Arabic).
//
// NOTE on scanner.cafeteria.result.* shape: this deliberately mirrors
// scanner.result.*'s {headline, instruction} object shape (rather than
// staying flat strings) specifically so it reads as a consistent part
// of the same `scanner` namespace rather than an unflagged oversight —
// see cafeteria-scanner-client.tsx's Task 6 code-review fix commit.
const RESULT_CLASSNAME: Record<ScanResult, string> = {
  admitted: 'bg-green-100 text-green-800 border-green-400',
  already_used_today: 'bg-amber-100 text-amber-800 border-amber-400',
  ineligible: 'bg-red-100 text-red-800 border-red-400',
  invalid_qr: 'bg-red-100 text-red-800 border-red-400',
  error: 'bg-red-100 text-red-800 border-red-400',
};

export function CafeteriaScannerClient() {
  const t = useTranslations('scanner');
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);

  // useQrScanner (below) needs handleDecode, and handleDecode needs to
  // call stop() (also from useQrScanner) — a genuine circular
  // dependency between the two. A ref sidesteps it: stopRef is updated
  // (synchronously, after useQrScanner runs) to always point at the
  // current stop, and handleDecode reads through the ref rather than
  // closing over stop directly, so it never needs stop in its own
  // useCallback deps and there's no reference-before-initialization on
  // the `const { stop } = useQrScanner(...)` line below.
  const stopRef = useRef<(() => void) | null>(null);

  const handleDecode = useCallback(
    async (payload: string) => {
      if (busy) return; // defense in depth against a rapid double-decode within the same in-flight fetch
      setBusy(true);
      try {
        const res = await fetch('/api/cafeteria-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qrPayload: payload }),
        });
        const body = await res.json();
        // Stop decoding the moment a result is back — the real fix for
        // the "camera keeps re-submitting the same held-up QR" bug.
        // Must run before setLastResult() so the camera is already
        // stopped by the time the result renders on screen; stop() is
        // safe to call here (see use-qr-scanner.ts's stop(), a plain
        // scannerRef.current?.stop() with no teardown of the instance).
        stopRef.current?.();
        setLastResult(body.ok ? body.result.result : 'error');
      } catch {
        stopRef.current?.();
        setLastResult('error');
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  // use-qr-scanner.ts's actual return shape is { videoRef, status, start,
  // stop, destroy } — start()/stop() are NOT called automatically by the
  // hook itself (confirmed by reading its source: no mount-time effect).
  // Camera is requested once, on mount, and released on unmount, mirroring
  // scanner-client.tsx's own identical useEffect(() => { start(); return
  // stop; }, []) pattern exactly.
  const { videoRef, status, start, stop } = useQrScanner(handleDecode);

  // Keep stopRef pointed at the latest stop — in an effect, not inline
  // during render (the react-hooks/refs rule flags writing a ref's
  // .current outside an event handler/effect). stop() is referentially
  // stable across renders (see use-qr-scanner.ts: useCallback with an
  // empty dep array), so in practice this effect body only ever runs
  // once, well before start() (called in the mount effect below) can
  // produce any decode tick that would read stopRef.
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  useEffect(() => {
    start();
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume decoding only on the operator's explicit "Scan next" tap —
  // mirrors scanner-client.tsx's handleScanNext, which calls start()
  // synchronously inside the real click handler (no intervening
  // await/effect) so qr-scanner's internal video.play() call stays
  // within the user-gesture window Safari requires. start() is safe to
  // call again here: use-qr-scanner.ts's start() reuses the existing
  // scanner instance via its own start() when one is already around
  // (the exact "resuming after stop() paused decoding" case documented
  // in that hook).
  const handleScanNext = useCallback(() => {
    setLastResult(null);
    start();
  }, [start]);

  return (
    <div className="flex flex-col items-center gap-4">
      <video ref={videoRef} className="w-full rounded-lg bg-black" playsInline muted />
      <CameraStatusMessage t={t} status={status} />
      {lastResult && (
        <div className={`w-full rounded-md border-2 p-4 text-center text-lg font-semibold ${RESULT_CLASSNAME[lastResult]}`}>
          <p>{t(`cafeteria.result.${lastResult}.headline`)}</p>
          <p className="text-sm font-normal">{t(`cafeteria.result.${lastResult}.instruction`)}</p>
        </div>
      )}
      <Button onClick={handleScanNext} disabled={busy}>
        {t('cafeteria.scanNext')}
      </Button>
    </div>
  );
}

// Translated camera-status copy, mirroring scanner-client.tsx's own
// handling of the same CameraStatus union: 'permission_denied' and
// 'unavailable' are the two realistic kiosk failure modes with
// dedicated {title, description} copy under scanner.camera.*; 'error'
// has the same shape. 'requesting' reuses the existing flat
// camera.requestingPermission string (scanner-client.tsx shows this
// exact string, unwrapped, for the same status). 'active'/'idle' show
// nothing, matching scanner-client.tsx's own precedent of never
// rendering camera-status text once the camera is live (or before
// start() has been called at all).
// Maps CameraStatus's snake_case 'permission_denied' value to the
// camelCase 'permissionDenied' key actually used under scanner.camera.*
// in en.json/ar.json. Interpolating `status` directly into the
// translation key (as this used to do) silently broke the
// permission_denied case only — 'unavailable' and 'error' are single
// words so they happened to match either way, masking the bug.
const CAMERA_MESSAGE_KEY: Record<'permission_denied' | 'unavailable' | 'error', string> = {
  permission_denied: 'permissionDenied',
  unavailable: 'unavailable',
  error: 'error',
};

function CameraStatusMessage({ t, status }: { t: ReturnType<typeof useTranslations>; status: CameraStatus }) {
  if (status === 'active' || status === 'idle') return null;
  if (status === 'requesting') {
    return <p className="text-sm text-charcoal/70">{t('camera.requestingPermission')}</p>;
  }
  // 'permission_denied' | 'unavailable' | 'error' — all share the same
  // {title, description} shape under scanner.camera.*.
  const messageKey = CAMERA_MESSAGE_KEY[status];
  return (
    <div className="text-center text-sm text-charcoal/70">
      <p className="font-medium">{t(`camera.${messageKey}.title`)}</p>
      <p>{t(`camera.${messageKey}.description`)}</p>
    </div>
  );
}
