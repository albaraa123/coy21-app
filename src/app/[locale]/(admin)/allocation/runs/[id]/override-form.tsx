'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { overrideAssignment } from './actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function OverrideForm({ assignmentId }: { assignmentId: string }) {
  const t = useTranslations('allocation.runs.detail.override');
  const router = useRouter();
  const [sessionId, setSessionId] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!sessionId.trim()) {
        throw new Error(t('errors.sessionRequired'));
      }
      if (!overrideReason.trim()) {
        throw new Error(t('errors.reasonRequired'));
      }
      await overrideAssignment(assignmentId, { sessionId: sessionId.trim(), overrideReason });
      setSessionId('');
      setOverrideReason('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mt-3 border-gold/60 bg-gold/5 dark:border-amber-700/60 dark:bg-amber-950/10">
      <p className="mb-3 text-sm text-charcoal/70 dark:text-gray-400">{t('description')}</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('newSessionId')}
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            required
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('reasonLabel')}
          <textarea
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            required
            placeholder={t('reasonPlaceholder')}
            className="min-h-20 rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <div>
          <Button type="submit" variant="destructive" disabled={submitting}>
            {submitting ? t('submitting') : t('submit')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
