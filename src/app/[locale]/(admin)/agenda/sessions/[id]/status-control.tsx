'use client';

// Non-cancel transitions use a plain <select> rather than Task 13's
// per-status Record<Status, Variant>-mapped Button row (see
// applications/[id]/review-controls.tsx): SessionStatus's non-cancel
// transitions carry no meaningfully different visual weight from one
// another (draft/published/confirmed/completed are all "forward,
// routine" moves), unlike accept/reject/waitlist, where visual weight
// itself communicates consequence. Only 'cancelled' is consequence-
// bearing here, and it already gets its own destructive-styled
// confirm/abort flow below, kept deliberately separate from the select.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { updateSessionStatus } from './actions';
import type { SessionStatus } from '@/lib/validation/agenda';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function StatusControl({
  sessionId,
  currentStatus,
  validNextStatuses,
}: {
  sessionId: string;
  currentStatus: string;
  validNextStatuses: SessionStatus[];
}) {
  const t = useTranslations('agenda.sessions.detail.status');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [cancellationReason, setCancellationReason] = useState('');
  const [pendingCancelTarget, setPendingCancelTarget] = useState<SessionStatus | null>(null);

  async function handleStatusChange(newStatus: string) {
    setError(null);
    if (newStatus === 'cancelled') {
      setPendingCancelTarget('cancelled');
      return;
    }
    setSubmitting(true);
    try {
      await updateSessionStatus(sessionId, newStatus as SessionStatus);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('statusError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmCancel(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await updateSessionStatus(sessionId, 'cancelled', cancellationReason);
      setPendingCancelTarget(null);
      setCancellationReason('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cancelError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <Card className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-charcoal/70 dark:text-gray-400">
          {t('current')}: <span className="font-medium text-charcoal dark:text-gray-100">{currentStatus}</span>
        </span>
        {validNextStatuses.length > 0 && (
          <select
            value=""
            onChange={(e) => e.target.value && handleStatusChange(e.target.value)}
            disabled={submitting}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('changeTo')}</option>
            {validNextStatuses.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        )}
      </Card>

      {pendingCancelTarget === 'cancelled' && (
        <form
          onSubmit={handleConfirmCancel}
          className="mt-3 flex flex-col gap-3 rounded-lg border border-red-700 bg-red-50 p-4 dark:border-red-400 dark:bg-red-950/40"
        >
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('cancellationReason')}
            <input
              type="text"
              value={cancellationReason}
              onChange={(e) => setCancellationReason(e.target.value)}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={submitting}>{t('confirmCancellation')}</Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setPendingCancelTarget(null); setCancellationReason(''); }}
            >
              {t('abort')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
