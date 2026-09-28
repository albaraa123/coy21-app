'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { sendInvitationAction, resendInvitationAction, revokeInvitationAction } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type Invitation = {
  status: string;
  sent_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  last_error: string | null;
  resend_count: number;
} | null;

export default function InvitationControls({
  applicationId,
  invitation,
  applicantId,
}: {
  applicationId: string;
  invitation: Invitation;
  applicantId: string | null;
}) {
  const t = useTranslations('participants.invitation');
  const state = invitation;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rule 1: an Auth user existing (or even an invitation being 'sent') never
  // implies ownership — only Task 21's explicit claim step links applicant_id.
  // This page still surfaces applicantId so staff can see whether the
  // application has ALREADY been claimed through that separate flow, in
  // which case none of these controls make sense any more.
  const alreadyClaimed = applicantId !== null;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      // Re-derive minimal client state rather than trusting the action's
      // return shape long-term; a full reload keeps this page's data honest
      // with what's actually in the DB (sensitive-answer visibility is
      // recomputed server-side anyway, so a full navigation reload is used
      // for simplicity instead of hand-rolling optimistic state here).
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  if (alreadyClaimed) {
    return (
      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
        <Card>
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('alreadyClaimed')}</p>
        </Card>
      </section>
    );
  }

  const statusVariant = state?.status === 'sent'
    ? 'elective'
    : state?.status === 'failed'
      ? 'cancelled'
      : state?.status === 'revoked'
        ? 'neutral'
        : 'pending';

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-charcoal dark:text-gray-100">
          <span className="text-charcoal/60 dark:text-gray-400">{t('status')}:</span>
          <Badge variant={statusVariant}>{state?.status ?? t('statusNotSent')}</Badge>
        </div>

        <div className="flex flex-col gap-1 text-xs text-charcoal/60 dark:text-gray-400">
          {state?.sent_at && <p>{t('lastSent')}: {new Date(state.sent_at).toLocaleString()}</p>}
          {state?.resend_count ? <p>{t('resentCount', { count: state.resend_count })}</p> : null}
          {state?.revoked_at && <p>{t('revoked')}: {new Date(state.revoked_at).toLocaleString()}</p>}
        </div>

        {state?.last_error && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {t('lastError')}: {state.last_error}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {(!state || state.status === 'not_sent' || state.status === 'failed' || state.status === 'revoked') && (
            <Button size="sm" disabled={busy} onClick={() => void run(() => sendInvitationAction(applicationId))}>
              {busy ? t('sending') : t('send')}
            </Button>
          )}
          {state && (state.status === 'sent' || state.status === 'failed') && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => resendInvitationAction(applicationId))}>
              {busy ? t('resending') : t('resend')}
            </Button>
          )}
          {state && (state.status === 'sent' || state.status === 'failed') && (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(() => revokeInvitationAction(applicationId))}>
              {busy ? t('revoking') : t('revoke')}
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}
