'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import { triggerStagePublication } from './stage/[allocationRunId]/actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type AllocationRun = {
  id: string;
  status: string;
  run_at: string;
  confirmed_at: string | null;
};

export default function RunList({ runs }: { runs: AllocationRun[] }) {
  const t = useTranslations('allocation.schedulePublication.overview');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [stagingRunId, setStagingRunId] = useState<string | null>(null);

  async function handleStage(runId: string) {
    setError(null);
    setStagingRunId(runId);
    try {
      await triggerStagePublication(runId);
      router.push(`/allocation/schedules/stage/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.stageFailed'));
    } finally {
      setStagingRunId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

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
                <Card key={run.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-charcoal dark:text-gray-100">{run.id}</p>
                    <span className="text-sm text-charcoal/70 dark:text-gray-400">{run.status}</span>
                  </div>
                  <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                    {t('runAt')}: {new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' })}
                  </p>
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">
                    {t('confirmedAt')}:{' '}
                    {run.confirmed_at
                      ? new Date(run.confirmed_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' })
                      : '—'}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      size="sm"
                      disabled={stagingRunId === run.id}
                      onClick={() => handleStage(run.id)}
                    >
                      {stagingRunId === run.id ? t('staging') : t('stage')}
                    </Button>
                    <Link href={`/allocation/schedules/stage/${run.id}`} className="text-sm text-turquoise hover:underline">
                      {t('reviewDraft')}
                    </Link>
                  </div>
                </Card>
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
                    <th scope="col" className="px-4 py-2 text-start font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td className="px-4 py-2 text-charcoal dark:text-gray-100">{run.id}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{run.status}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                        {new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' })}
                      </td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                        {run.confirmed_at
                          ? new Date(run.confirmed_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' })
                          : '—'}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <Button
                            type="button"
                            size="sm"
                            disabled={stagingRunId === run.id}
                            onClick={() => handleStage(run.id)}
                          >
                            {stagingRunId === run.id ? t('staging') : t('stage')}
                          </Button>
                          <Link href={`/allocation/schedules/stage/${run.id}`} className="text-turquoise hover:underline">
                            {t('reviewDraft')}
                          </Link>
                        </div>
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
