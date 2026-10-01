'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import { triggerAllocationRun } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type AllocationRun = {
  id: string;
  status: string;
  run_at: string;
  confirmed_at: string | null;
};

type ExtractionRun = {
  id: string;
  rules_version: number;
  application_count: number;
  run_at: string;
};

// allocation_runs.status is constrained at the DB level to
// ('draft', 'confirmed', 'discarded') — see
// supabase/migrations/20260723100000_allocation_tables.sql.
const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  draft: 'pending',
  confirmed: 'changed',
  discarded: 'cancelled',
};

const STATUS_LABEL_KEY: Record<string, 'draft' | 'confirmed' | 'discarded'> = {
  draft: 'draft',
  confirmed: 'confirmed',
  discarded: 'discarded',
};

export default function RunList({
  runs,
  extractionRuns,
}: {
  runs: AllocationRun[];
  extractionRuns: ExtractionRun[];
}) {
  const t = useTranslations('allocation.runs.list');
  const router = useRouter();
  const [featureExtractionRunId, setFeatureExtractionRunId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!featureExtractionRunId) {
        throw new Error(t('errors.extractionRunRequired'));
      }
      await triggerAllocationRun({ featureExtractionRunId });
      setFeatureExtractionRunId('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.runFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('newRunTitle')}</h2>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('extractionRun')}
          <select
            value={featureExtractionRunId}
            onChange={(e) => setFeatureExtractionRunId(e.target.value)}
            required
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('selectExtractionRun')}</option>
            {extractionRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {t('extractionRunOption', { id: run.id, version: run.rules_version, count: run.application_count })}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-2">
          <Button type="submit" disabled={submitting}>{t('runAllocation')}</Button>
        </div>
      </form>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-charcoal dark:text-gray-100">{t('runsTitle')}</h2>

        {runs.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <>
            {/* Mobile: card-per-run list. Desktop (md+): table. Both trees
                render the same `runs` data and must be kept in sync — any
                column added to one must be added to the other. */}
            <div className="flex flex-col gap-2 md:hidden">
              {runs.map((run) => (
                <Link key={run.id} href={`/allocation/runs/${run.id}`} className="block">
                  <Card className="transition-colors hover:border-turquoise/60">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-charcoal dark:text-gray-100">{run.id}</p>
                      <Badge variant={STATUS_BADGE_VARIANT[run.status] ?? 'neutral'}>
                        {run.status in STATUS_LABEL_KEY ? t(`statusValues.${STATUS_LABEL_KEY[run.status]}`) : run.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                      {t('runAt')}: {new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' })}
                    </p>
                    <p className="text-sm text-charcoal/70 dark:text-gray-400">
                      {t('confirmedAt')}:{' '}
                      {run.confirmed_at
                        ? new Date(run.confirmed_at).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' })
                        : '—'}
                    </p>
                  </Card>
                </Link>
              ))}
            </div>
            <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('runId')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('runAt')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('confirmedAt')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td className="px-4 py-2">
                        <Link href={`/allocation/runs/${run.id}`} className="text-turquoise hover:underline">
                          {run.id}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={STATUS_BADGE_VARIANT[run.status] ?? 'neutral'}>
                          {run.status in STATUS_LABEL_KEY ? t(`statusValues.${STATUS_LABEL_KEY[run.status]}`) : run.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                        {new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' })}
                      </td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                        {run.confirmed_at
                          ? new Date(run.confirmed_at).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' })
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
