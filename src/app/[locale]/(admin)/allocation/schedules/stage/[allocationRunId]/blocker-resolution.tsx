'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { reassignDraftItem, overrideDraftItemWithGap } from './actions';
import type { DraftItem } from './draft-review';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function BlockerResolution({
  item,
  draftStatus,
  onResolved,
}: {
  item: DraftItem;
  draftStatus: string;
  onResolved: () => void;
}) {
  const t = useTranslations('allocation.schedulePublication.blockers');
  const [newSessionId, setNewSessionId] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const editable = draftStatus === 'staged' && item.resolution == null;

  async function handleReassign() {
    setError(null);
    setSubmitting(true);
    try {
      const trimmedSessionId = newSessionId.trim();
      if (!trimmedSessionId) throw new Error(t('errors.sessionRequired'));
      await reassignDraftItem({ draftItemId: item.id, newSessionId: trimmedSessionId });
      setNewSessionId('');
      setOverrideReason('');
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.reassignFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOverride() {
    setError(null);
    setSubmitting(true);
    try {
      const trimmedReason = overrideReason.trim();
      if (!trimmedReason) throw new Error(t('errors.reasonRequired'));
      await overrideDraftItemWithGap({ draftItemId: item.id, overrideReason: trimmedReason });
      setNewSessionId('');
      setOverrideReason('');
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.overrideFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mt-3 border-gold/60 bg-gold/5 dark:border-amber-700/60 dark:bg-amber-950/10">
      <h3 className="text-sm font-semibold text-charcoal dark:text-gray-100">
        {t('applicationHeading', { id: item.application_id })}
      </h3>
      <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
        {t('blockerDetails', {
          details: item.blocker_details ? JSON.stringify(item.blocker_details) : t('blockerDetailsNone'),
        })}
      </p>
      {item.resolution ? (
        <p className="mt-1 text-sm text-charcoal dark:text-gray-100">
          {t('resolvedVia', {
            resolution:
              item.resolution === 'reassigned' || item.resolution === 'override_publish_with_gap'
                ? t(`resolution.${item.resolution}`)
                : item.resolution,
          })}
          {item.resolution === 'reassigned' && item.reassigned_session_id
            ? t('resolvedNewSession', { sessionId: item.reassigned_session_id })
            : ''}
          {item.resolution === 'override_publish_with_gap' && item.override_reason
            ? t('resolvedOverrideReason', { reason: item.override_reason })
            : ''}
        </p>
      ) : (
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('notResolved')}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
        <label className="flex flex-1 flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('reassign.label')}
          <input
            type="text"
            value={newSessionId}
            onChange={(e) => setNewSessionId(e.target.value)}
            disabled={!editable || submitting}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <Button type="button" variant="secondary" size="sm" onClick={handleReassign} disabled={!editable || submitting}>
          {submitting ? t('reassign.submitting') : t('reassign.submit')}
        </Button>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
        <label className="flex flex-1 flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('override.label')}
          <textarea
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            disabled={!editable || submitting}
            className="min-h-16 rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <Button type="button" variant="destructive" size="sm" onClick={handleOverride} disabled={!editable || submitting}>
          {submitting ? t('override.submitting') : t('override.submit')}
        </Button>
      </div>
    </Card>
  );
}
