'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { rollbackImportBatch } from '../rollback-action';

export default function RollbackTrigger({ batchId }: { batchId: string }) {
  const t = useTranslations('participants.import.rollback');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleRollback() {
    // This is the single most destructive action in the application — undoing
    // an entire completed import batch, touching every application row it
    // touched. The native confirm() below is preserved exactly as it existed
    // pre-restyle (same call site, same guard-before-mutate shape, same
    // early-return-on-cancel) — this task is presentation-only and must not
    // add, remove, or alter any confirmation gate. The prompt's text is now
    // routed through t('confirmPrompt') instead of a hardcoded English
    // literal so it reads correctly in both locales — the message itself is
    // an unchanged, direct translation of the original English string, not a
    // reworded warning.
    const confirmed = window.confirm(t('confirmPrompt'));
    if (!confirmed) return;

    setError(null);
    setSubmitting(true);
    try {
      await rollbackImportBatch(batchId);
      router.refresh();
    } catch (err) {
      // The RPC's raise-exception messages name the specific blocking
      // dependency (e.g. a sent invitation, a feature-extraction run) —
      // surfaced verbatim so the admin knows what to retract first.
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {/* Destructive variant: this is the most consequential action in the
          entire application (irreversibly undoes a completed import batch),
          so it must never read as less serious than any other button on the
          page — per the visual-weight-matches-consequence principle
          established in Groups A/B (see button.tsx's `destructive` variant
          and applications/[id]/review-controls.tsx's TRANSITION_VARIANT). */}
      <div>
        <Button type="button" variant="destructive" onClick={() => void handleRollback()} disabled={submitting}>
          {submitting ? t('rollingBack') : t('trigger')}
        </Button>
      </div>
    </div>
  );
}
