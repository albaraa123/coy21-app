'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { requestMyQrCredential, reissueMyQrCredentialAction } from './actions';
import type { ParticipantQrState } from '@/lib/attendance/participant-qr';

// Never persisted, never read from localStorage/sessionStorage — this
// component's only copy of the QR image lives in React state, cleared
// the moment the component unmounts (route navigation/logout/refresh),
// matching the "transient in browser memory/DOM/canvas only" rule.
export default function MyQrClient({
  initialState,
  initialQrImageDataUri,
}: {
  initialState: ParticipantQrState;
  initialQrImageDataUri: string | null;
}) {
  const t = useTranslations('myQr');
  const [state, setState] = useState(initialState);
  const [qrImageDataUri, setQrImageDataUri] = useState(initialQrImageDataUri);
  const [busy, setBusy] = useState(false);
  const [confirmingReissue, setConfirmingReissue] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleRequestQr = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await requestMyQrCredential();
      setState(result.state);
      setQrImageDataUri(result.qrImageDataUri);
    } catch {
      setActionError(t('actionError'));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const handleReissue = useCallback(async () => {
    if (state.kind !== 'QR_AVAILABLE') return;
    setBusy(true);
    setActionError(null);
    setConfirmingReissue(false);
    try {
      const result = await reissueMyQrCredentialAction({ expectedCurrentCredentialId: state.credentialId });
      setState(result.state);
      setQrImageDataUri(result.qrImageDataUri);
    } catch {
      setActionError(t('actionError'));
    } finally {
      setBusy(false);
    }
  }, [state, t]);

  if (state.kind === 'ERROR') {
    return (
      <Card>
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {t('states.error')}
        </p>
      </Card>
    );
  }

  if (state.kind === 'NOT_ELIGIBLE') {
    return (
      <Card>
        <p className="text-sm text-charcoal/80 dark:text-gray-300">{t('states.notEligible')}</p>
      </Card>
    );
  }

  if (state.kind === 'CREDENTIAL_REVOKED') {
    // Unreachable today — getMyQrState never returns this kind (see its
    // own doc comment: no backend workflow sets a staff/security
    // revocation reason yet). Kept only for type exhaustiveness against
    // a future staff-revocation feature.
    return (
      <Card>
        <p className="text-sm text-charcoal/80 dark:text-gray-300">{t('states.revoked')}</p>
      </Card>
    );
  }

  if (state.kind === 'NOT_YET_AVAILABLE') {
    return (
      <Card className="flex flex-col gap-4 items-center text-center">
        <p className="text-sm text-charcoal/80 dark:text-gray-300">{t('states.notYetAvailable')}</p>
        {/* Only rendered because Phase 6.1's participant_self_service
            issuance channel already exists and is the approved,
            production-intended path for an accepted participant with no
            credential yet — not a newly invented capability. */}
        <Button onClick={handleRequestQr} disabled={busy}>
          {busy ? t('requesting') : t('requestButton')}
        </Button>
        {actionError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {actionError}
          </p>
        )}
      </Card>
    );
  }

  // state.kind === 'QR_AVAILABLE'
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col items-center gap-3 text-center">
        <p className="text-base font-medium text-charcoal dark:text-gray-100">{state.participant.fullName}</p>
        {state.participant.attendeeCode && (
          <div className="flex items-center gap-2 rounded-md bg-turquoise/10 px-3 py-1">
            <span className="font-mono text-sm font-bold tracking-widest text-turquoise">
              {state.participant.attendeeCode}
            </span>
          </div>
        )}
        {qrImageDataUri && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrImageDataUri}
            alt={t('qrAltText')}
            className="w-full max-w-[280px] rounded-lg bg-white p-2"
            width={600}
            height={600}
          />
        )}
        <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('instruction')}</p>
        {(state.participant.country || state.participant.nationality) && (
          <p className="text-xs text-charcoal/60 dark:text-gray-400">
            {[state.participant.country, state.participant.nationality].filter(Boolean).join(' · ')}
          </p>
        )}
      </Card>

      <p className="text-center text-xs text-charcoal/50 dark:text-gray-500">{t('brightnessHint')}</p>

      <div className="flex flex-col items-center gap-2">
        {!confirmingReissue ? (
          <button
            type="button"
            onClick={() => setConfirmingReissue(true)}
            disabled={busy}
            className="text-xs font-medium text-charcoal/60 underline hover:text-charcoal dark:text-gray-400 dark:hover:text-gray-200"
          >
            {t('reissueLink')}
          </button>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-md border border-amber-600/40 bg-amber-50 p-3 text-center dark:border-amber-400/30 dark:bg-amber-950/30">
            <p className="text-xs text-amber-800 dark:text-amber-300">{t('reissueWarning')}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={handleReissue} disabled={busy}>
                {busy ? t('requesting') : t('reissueConfirm')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmingReissue(false)} disabled={busy}>
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {actionError}
          </p>
        )}
      </div>
    </div>
  );
}
