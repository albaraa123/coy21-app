// src/components/scanner/cafeteria-coffee-scanner-client.tsx
//
// Mirrors cafeteria-scanner-client.tsx's structure (useQrScanner usage,
// stopRef circular-dependency workaround, CameraStatusMessage
// sub-component) but with a two-step flow: scan -> show balance ->
// operator enters amount -> confirm -> show deduction result.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQrScanner, type CameraStatus } from './use-qr-scanner';
import { Button } from '@/components/ui/button';

type DeductionResult = 'deducted' | 'insufficient_balance' | 'ineligible' | 'invalid_qr' | 'error';

interface BalanceState {
  eligible: boolean;
  remainingBalance: number | null;
  invalidQr?: boolean;
}

const DEDUCTION_RESULT_CLASSNAME: Record<DeductionResult, string> = {
  deducted: 'bg-green-100 text-green-800 border-green-400',
  insufficient_balance: 'bg-amber-100 text-amber-800 border-amber-400',
  ineligible: 'bg-red-100 text-red-800 border-red-400',
  invalid_qr: 'bg-red-100 text-red-800 border-red-400',
  error: 'bg-red-100 text-red-800 border-red-400',
};

export function CafeteriaCoffeeScannerClient() {
  const t = useTranslations('scanner');
  const [qrPayload, setQrPayload] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [deductionResult, setDeductionResult] = useState<DeductionResult | null>(null);
  const [deductionDetail, setDeductionDetail] = useState<{ amount: number | null; remaining: number | null }>({ amount: null, remaining: null });
  const [busy, setBusy] = useState(false);

  // Same circular-dependency workaround as cafeteria-scanner-client.tsx.
  const stopRef = useRef<(() => void) | null>(null);

  const handleDecode = useCallback(
    async (payload: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await fetch('/api/cafeteria-coffee-balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qrPayload: payload }),
        });
        const body = await res.json();
        // Stop decoding the moment a result is back, BEFORE any state
        // update that renders a result -- same fix, same ordering
        // requirement as cafeteria-scanner-client.tsx's own handleDecode.
        stopRef.current?.();
        if (body.ok) {
          setQrPayload(payload);
          setBalance(body.result);
        } else {
          setBalance(null);
          setDeductionResult('error');
        }
      } catch {
        stopRef.current?.();
        setBalance(null);
        setDeductionResult('error');
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  const { videoRef, status, start, stop } = useQrScanner(handleDecode);

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

  const handleConfirmDeduction = useCallback(async () => {
    if (!qrPayload) return;
    const amount = Number(amountInput);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setBusy(true);
    try {
      const res = await fetch('/api/cafeteria-coffee-deduct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrPayload, amount }),
      });
      const body = await res.json();
      if (body.ok) {
        setDeductionResult(body.result.result as DeductionResult);
        setDeductionDetail({
          amount: body.result.amountDeducted,
          remaining: balance?.remainingBalance != null ? balance.remainingBalance - (body.result.amountDeducted ?? 0) : null,
        });
      } else {
        setDeductionResult('error');
      }
    } catch {
      setDeductionResult('error');
    } finally {
      setBusy(false);
    }
  }, [qrPayload, amountInput, balance]);

  const handleScanNext = useCallback(() => {
    setQrPayload(null);
    setBalance(null);
    setAmountInput('');
    setDeductionResult(null);
    setDeductionDetail({ amount: null, remaining: null });
    start();
  }, [start]);

  return (
    <div className="flex flex-col items-center gap-4">
      <video ref={videoRef} className="w-full rounded-lg bg-black" playsInline muted />
      <CameraStatusMessage t={t} status={status} />

      {!balance && !deductionResult && status === 'active' && (
        <p className="text-sm text-charcoal/70">{t('cafeteria.coffee.scanInstruction')}</p>
      )}

      {balance && !deductionResult && (
        balance.invalidQr || !balance.eligible ? (
          <div className={`w-full rounded-md border-2 p-4 text-center text-lg font-semibold ${DEDUCTION_RESULT_CLASSNAME[balance.invalidQr ? 'invalid_qr' : 'ineligible']}`}>
            <p>{t(`cafeteria.coffee.result.${balance.invalidQr ? 'invalid_qr' : 'ineligible'}.headline`)}</p>
            <p className="text-sm font-normal">{t(`cafeteria.coffee.result.${balance.invalidQr ? 'invalid_qr' : 'ineligible'}.instruction`)}</p>
          </div>
        ) : balance.remainingBalance !== null && balance.remainingBalance <= 0 ? (
          <p className="text-sm text-charcoal/70">{t('cafeteria.coffee.noBalanceRemaining')}</p>
        ) : (
          <div className="flex w-full flex-col gap-3">
            <p className="text-center text-base font-medium">
              {t('cafeteria.coffee.eligibleBalance', { amount: balance.remainingBalance ?? 0 })}
            </p>
            <label className="flex flex-col gap-1 text-sm">
              {t('cafeteria.coffee.amountLabel')}
              <input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="rounded-md border border-charcoal/20 px-3 py-2"
              />
            </label>
            <Button onClick={handleConfirmDeduction} disabled={busy || !amountInput}>
              {t('cafeteria.coffee.confirmButton')}
            </Button>
          </div>
        )
      )}

      {deductionResult && (
        <div className={`w-full rounded-md border-2 p-4 text-center text-lg font-semibold ${DEDUCTION_RESULT_CLASSNAME[deductionResult]}`}>
          <p>{t(`cafeteria.coffee.result.${deductionResult}.headline`)}</p>
          <p className="text-sm font-normal">
            {deductionResult === 'deducted'
              ? t('cafeteria.coffee.result.deducted.instruction', { amount: deductionDetail.amount ?? 0, remaining: deductionDetail.remaining ?? 0 })
              : t(`cafeteria.coffee.result.${deductionResult}.instruction`)}
          </p>
        </div>
      )}

      {(balance || deductionResult) && (
        <Button onClick={handleScanNext} disabled={busy}>
          {t('cafeteria.coffee.scanNext')}
        </Button>
      )}
    </div>
  );
}

// Identical to cafeteria-scanner-client.tsx's own CameraStatusMessage --
// copy verbatim (including the CAMERA_MESSAGE_KEY case-mapping fix for
// 'permission_denied' -> 'permissionDenied'). Not extracted to a shared
// file in this plan (out of scope; matches this codebase's existing
// tolerance for this exact kind of small, scanner-specific duplication
// -- see cafeteria-scanner-client.tsx's own code-review history).
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
  const messageKey = CAMERA_MESSAGE_KEY[status];
  return (
    <div className="text-center text-sm text-charcoal/70">
      <p className="font-medium">{t(`camera.${messageKey}.title`)}</p>
      <p>{t(`camera.${messageKey}.description`)}</p>
    </div>
  );
}
