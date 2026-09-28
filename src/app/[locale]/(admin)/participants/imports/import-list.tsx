// src/app/[locale]/(admin)/participants/imports/import-list.tsx
//
// Server component — this is a pure read-only render of data the parent page
// already fetched. Nothing here needs client-side interactivity (no
// filtering/sorting state, no mutation), so there is no reason to pay for a
// 'use client' boundary here, unlike preview-table.tsx (which manages
// validation/filter/download state) or import-progress.tsx (which drives a
// multi-step chunk loop). Matches the plan's own suggestion ("probably a
// server component is fine"). Restyled to use getTranslations (the
// server-component counterpart of useTranslations) for the same reason.

import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';

type BatchRow = {
  id: string;
  status: string;
  downstream_status: string | null;
  original_filename: string;
  sheet_name: string | null;
  row_count: number | null;
  valid_count: number;
  warning_count: number;
  error_count: number;
  duplicate_count: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  uploaded_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
};

const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  uploaded: 'neutral',
  validating: 'pending',
  ready_to_import: 'pending',
  importing: 'pending',
  imported: 'changed',
  processing_features: 'pending',
  clustering: 'pending',
  allocating: 'pending',
  completed: 'changed',
  completed_with_warnings: 'mandatory',
  failed: 'cancelled',
  rolled_back: 'neutral',
};

export default async function ImportList({ batches }: { batches: BatchRow[] }) {
  const t = await getTranslations('imports.history');

  if (batches.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
  }

  return (
    <>
      {/* Mobile: card-per-batch list. Desktop (md+): table. Both trees render
          the same `batches` data and must be kept in sync — any column added
          to one must be added to the other. */}
      <div className="flex flex-col gap-2 md:hidden">
        {batches.map((batch) => (
          <div key={batch.id} className="rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Absolute path (not relative) — sidesteps the relative-URL
                  resolution bug this used to hit (a bare href={batch.id}
                  resolved to /{locale}/participants/{id}, missing "imports"
                  entirely, since the browser treats the current page's final
                  segment as a filename, not a directory). Link from
                  @/i18n/routing prefixes the current locale automatically, so
                  an absolute /participants/imports/{id} path is both correct
                  and gets client-side navigation, matching the pattern used
                  throughout this restyle (e.g. confirm/page.tsx's back link). */}
              <Link href={`/participants/imports/${batch.id}`} className="text-sm font-medium text-turquoise hover:underline">
                {batch.original_filename}
                {batch.sheet_name ? ` — ${batch.sheet_name}` : ''}
              </Link>
              <Badge variant={STATUS_BADGE_VARIANT[batch.status] ?? 'neutral'}>{batch.status}</Badge>
            </div>
            <p className="mt-1 text-xs text-charcoal/60 dark:text-gray-400">
              {t('uploaded')}: {new Date(batch.uploaded_at).toLocaleString()}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-charcoal/70 dark:text-gray-400">
              <span>{t('downstream')}: {batch.downstream_status ?? t('downstreamNotStarted')}</span>
              <span>{t('rows')}: {batch.row_count ?? 0}</span>
              <span>{t('inserted')}: {batch.inserted_count}</span>
              <span>{t('updated')}: {batch.updated_count}</span>
              <span>{t('skipped')}: {batch.skipped_count}</span>
              <span>{t('errors')}: {batch.error_count}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
        <table className="w-full text-start text-sm">
          <thead>
            <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('uploaded')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('file')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('downstream')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('rows')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('inserted')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('updated')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('skipped')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('errors')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium"><span className="sr-only">{t('view')}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{new Date(batch.uploaded_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-charcoal dark:text-gray-100">
                  {batch.original_filename}
                  {batch.sheet_name ? ` — ${batch.sheet_name}` : ''}
                </td>
                <td className="px-4 py-2">
                  <Badge variant={STATUS_BADGE_VARIANT[batch.status] ?? 'neutral'}>{batch.status}</Badge>
                </td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{batch.downstream_status ?? t('downstreamNotStarted')}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{batch.row_count ?? 0}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{batch.inserted_count}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{batch.updated_count}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{batch.skipped_count}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{batch.error_count}</td>
                <td className="px-4 py-2">
                  {/* Absolute path (not relative) — sidesteps the relative-URL
                      resolution bug this used to hit (a bare href={batch.id}
                      resolved to /{locale}/participants/{id}, missing "imports"
                      entirely, since the browser treats the current page's
                      final segment as a filename, not a directory). Link from
                      @/i18n/routing prefixes the current locale automatically,
                      so an absolute /participants/imports/{id} path is both
                      correct and gets client-side navigation, matching the
                      pattern used throughout this restyle (e.g.
                      confirm/page.tsx's back link). */}
                  <Link href={`/participants/imports/${batch.id}`} className="text-sm font-medium text-turquoise hover:underline">
                    {t('view')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
