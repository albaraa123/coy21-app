'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { triggerStagePublication, confirmDraftPublication } from './actions';
import BlockerResolution from './blocker-resolution';
import { PublishConfirmationDialog } from './publish-confirmation-dialog';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export type Draft = {
  id: string;
  status: string;
  staged_at: string;
  staged_by: string | null;
  source_fingerprint: string;
};

export type DraftItem = {
  id: string;
  application_id: string;
  verdict: string;
  blocker_details: unknown;
  resolution: string | null;
  override_reason: string | null;
  reassigned_session_id: string | null;
};

export type LowConfidenceIssue = {
  id: string;
  issue_type: string;
  application_id: string | null;
  session_id: string | null;
  details: unknown;
};

export default function DraftReview({
  allocationRunId,
  draft,
  draftItems,
  lowConfidenceIssues,
}: {
  allocationRunId?: string;
  draft: Draft | null;
  draftItems: DraftItem[];
  lowConfidenceIssues: LowConfidenceIssue[];
}) {
  const t = useTranslations('allocation.schedulePublication.review');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lowConfidenceAcknowledged, setLowConfidenceAcknowledged] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const publishTriggerRef = useRef<HTMLButtonElement | null>(null);

  const publishable = useMemo(() => draftItems.filter((i) => i.verdict === 'publishable'), [draftItems]);
  const blockedMandatory = useMemo(() => draftItems.filter((i) => i.verdict === 'blocked_mandatory'), [draftItems]);
  const noChange = useMemo(() => draftItems.filter((i) => i.verdict === 'no_change'), [draftItems]);

  const allBlockersResolved = blockedMandatory.every((i) => i.resolution != null);
  const canConfirm =
    draft != null &&
    draft.status === 'staged' &&
    allBlockersResolved &&
    (lowConfidenceIssues.length === 0 || lowConfidenceAcknowledged);

  async function handleStage() {
    if (!allocationRunId) return;
    setError(null);
    setStaging(true);
    try {
      await triggerStagePublication(allocationRunId);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('confirm.errors.stageFailed'));
    } finally {
      setStaging(false);
    }
  }

  async function handleConfirm() {
    if (!draft) return;
    setError(null);
    setConfirming(true);
    try {
      await confirmDraftPublication(draft.id);
      setConfirmDialogOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('confirm.errors.confirmFailed'));
      // Keep the dialog open on failure so the admin can see the error
      // banner and retry without re-typing the confirmation phrase from
      // scratch in a fresh dialog instance.
    } finally {
      setConfirming(false);
    }
  }

  const errorBanner = error && (
    <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
      {error}
    </p>
  );

  if (!draft) {
    return (
      <div className="flex flex-col gap-4">
        {errorBanner}
        <EmptyState
          title={t('noDraftTitle')}
          description={t('noDraftDescription')}
          action={
            allocationRunId
              ? { label: staging ? t('staging') : t('stage'), onClick: handleStage }
              : undefined
          }
        />
      </div>
    );
  }

  const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
    staged: 'pending',
    confirmed: 'changed',
    discarded: 'cancelled',
  };

  return (
    <div className="flex flex-col gap-6">
      {errorBanner}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-charcoal dark:text-gray-100">{t('draftTitle', { id: draft.id })}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-charcoal/70 dark:text-gray-400">
              <Badge variant={STATUS_BADGE_VARIANT[draft.status] ?? 'neutral'}>{draft.status}</Badge>
              <span>{t('stagedAt', { stagedAt: new Date(draft.staged_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' }) })}</span>
            </div>
            {draft.status !== 'staged' && (
              <p className="mt-2 text-sm text-charcoal/70 dark:text-gray-400">{t('notActionable', { status: draft.status })}</p>
            )}
          </div>
          {allocationRunId && (
            <Button type="button" variant="secondary" size="sm" onClick={handleStage} disabled={staging}>
              {staging ? t('staging') : t('restage')}
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('summary.title')}</h2>
        <ul className="flex flex-wrap gap-2">
          <li><Badge variant="changed">{t('summary.publishable')}: {publishable.length}</Badge></li>
          <li><Badge variant="mandatory">{t('summary.blockedMandatory')}: {blockedMandatory.length}</Badge></li>
          <li><Badge variant="neutral">{t('summary.noChange')}: {noChange.length}</Badge></li>
        </ul>
      </Card>

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('lowConfidence.title')}</h2>
        {lowConfidenceIssues.length === 0 ? (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('lowConfidence.empty')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Mobile: card list. Desktop: table. Keep both trees in sync. */}
            <ul className="flex flex-col gap-2 md:hidden">
              {lowConfidenceIssues.map((issue) => (
                <li key={issue.id} className="rounded-md border border-charcoal/10 p-3 text-sm dark:border-gray-700">
                  <div className="flex justify-between gap-2">
                    <span className="text-charcoal/70 dark:text-gray-400">{t('lowConfidence.applicationId')}</span>
                    <span className="text-charcoal dark:text-gray-100">{issue.application_id ?? '—'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-charcoal/70 dark:text-gray-400">{t('lowConfidence.sessionId')}</span>
                    <span className="text-charcoal dark:text-gray-100">{issue.session_id ?? '—'}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-charcoal/10 dark:border-gray-700">
                    <th scope="col" className="px-2 py-1.5 text-start font-medium text-charcoal/70 dark:text-gray-400">{t('lowConfidence.applicationId')}</th>
                    <th scope="col" className="px-2 py-1.5 text-start font-medium text-charcoal/70 dark:text-gray-400">{t('lowConfidence.sessionId')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lowConfidenceIssues.map((issue) => (
                    <tr key={issue.id} className="border-b border-charcoal/5 dark:border-gray-800">
                      <td className="px-2 py-1.5 text-charcoal dark:text-gray-100">{issue.application_id ?? '—'}</td>
                      <td className="px-2 py-1.5 text-charcoal dark:text-gray-100">{issue.session_id ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
              <input
                type="checkbox"
                checked={lowConfidenceAcknowledged}
                onChange={(e) => setLowConfidenceAcknowledged(e.target.checked)}
                disabled={draft.status !== 'staged'}
                className="h-4 w-4 rounded border-charcoal/30 text-turquoise focus:ring-turquoise dark:border-gray-600"
              />
              {t('lowConfidence.acknowledge')}
            </label>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('publishableSection.title')}</h2>
        {publishable.length === 0 ? (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('publishableSection.empty')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {publishable.map((item) => (
              <li key={item.id}><Badge variant="changed">{item.application_id}</Badge></li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('noChangeSection.title')}</h2>
        {noChange.length === 0 ? (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noChangeSection.empty')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {noChange.map((item) => (
              <li key={item.id}><Badge variant="neutral">{item.application_id}</Badge></li>
            ))}
          </ul>
        )}
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('blockedSection.title')}</h2>
        {blockedMandatory.length === 0 ? (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('blockedSection.empty')}</p>
        ) : (
          blockedMandatory.map((item) => (
            <BlockerResolution
              key={item.id}
              item={item}
              draftStatus={draft.status}
              onResolved={() => router.refresh()}
            />
          ))
        )}
      </div>

      {/*
        Publish confirmation: the pre-existing safety gate for this
        irreversible action is `canConfirm` (all blocked_mandatory items
        resolved, plus the low-confidence acknowledgment checkbox above when
        applicable) — preserved byte-for-byte from the pre-restyle logic.
        This section keeps the strongest visual treatment in the
        schedule-publication surface: a red-bordered card, an explicit
        irreversibility warning, and the `destructive` button variant,
        because confirming here permanently supersedes each participant's
        previously published schedule with no undo path
        (confirm_publication_transactional only ever moves publications
        active -> superseded).

        Task 15 adds a final typed-confirmation dialog (see
        publish-confirmation-dialog.tsx) as an ADDITIONAL gate layered on
        top of this card, not a replacement for it: this button now opens
        the dialog instead of calling handleConfirm directly; the dialog's
        own confirm button is the only thing that calls handleConfirm
        (unchanged), which in turn calls the existing, unchanged
        confirmDraftPublication server action. No publication logic lives
        in the dialog component.
      */}
      <Card className="border-red-700/60 bg-red-50/60 dark:border-red-400/60 dark:bg-red-950/20">
        <h2 className="text-sm font-semibold text-red-700 dark:text-red-300">{t('confirm.title')}</h2>
        <p className="mt-1 text-sm text-red-700/90 dark:text-red-300/90">{t('confirm.warning')}</p>
        {!allBlockersResolved && (
          <p className="mt-2 text-sm text-charcoal/70 dark:text-gray-400">{t('confirm.blockersRemaining')}</p>
        )}
        {lowConfidenceIssues.length > 0 && !lowConfidenceAcknowledged && (
          <p className="mt-2 text-sm text-charcoal/70 dark:text-gray-400">{t('confirm.acknowledgeRequired')}</p>
        )}
        <div className="mt-3">
          <Button
            type="button"
            variant="destructive"
            ref={publishTriggerRef}
            onClick={() => setConfirmDialogOpen(true)}
            disabled={!canConfirm || confirming}
            aria-haspopup="dialog"
          >
            {confirming ? t('confirm.submitting') : t('confirm.submit')}
          </Button>
        </div>
      </Card>

      <PublishConfirmationDialog
        open={confirmDialogOpen}
        onClose={() => setConfirmDialogOpen(false)}
        onConfirm={handleConfirm}
        triggerRef={publishTriggerRef}
        canConfirm={canConfirm}
        submitting={confirming}
        affectedParticipantCount={publishable.length}
        draftReference={draft.source_fingerprint}
      />
    </div>
  );
}
