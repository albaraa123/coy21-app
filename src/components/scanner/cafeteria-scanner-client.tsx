// src/components/scanner/cafeteria-scanner-client.tsx
//
// Explicitly simple per the confirmed scope decision (no offline retry,
// no wake-lock, no sound/haptic — "نطوره لاحقاً لو احتجنا"). That
// sophistication lives in scanner-client.tsx (the existing /scanner
// route) and is deliberately NOT duplicated here. Reuses useQrScanner
// (the pure camera-decode hook) as-is.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQrScanner } from './use-qr-scanner';
import { Button } from '@/components/ui/button';

type ScanResult = 'admitted' | 'already_used_today' | 'ineligible' | 'invalid_qr' | 'error';

// Color families only — the actual label text is translated via
// t(`cafeteria.result.${lastResult}`) below rather than hardcoded here,
// matching result-presentation.ts's precedent (this codebase is
// bilingual throughout, and a cafeteria worker may need Arabic).
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

  const handleDecode = useCallback(
    async (payload: string) => {
      if (busy) return; // simple re-entrancy guard — no debounce/lock state machine in this phase
      setBusy(true);
      try {
        const res = await fetch('/api/cafeteria-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qrPayload: payload }),
        });
        const body = await res.json();
        setLastResult(body.ok ? body.result.result : 'error');
      } catch {
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

  useEffect(() => {
    start();
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center gap-4">
      <video ref={videoRef} className="w-full rounded-lg bg-black" playsInline muted />
      {status !== 'active' && <p className="text-sm text-charcoal/70">{status}</p>}
      {lastResult && (
        <div className={`w-full rounded-md border-2 p-4 text-center text-lg font-semibold ${RESULT_CLASSNAME[lastResult]}`}>
          {t(`cafeteria.result.${lastResult}`)}
        </div>
      )}
      <Button onClick={() => setLastResult(null)} disabled={busy}>
        {t('cafeteria.scanNext')}
      </Button>
    </div>
  );
}
