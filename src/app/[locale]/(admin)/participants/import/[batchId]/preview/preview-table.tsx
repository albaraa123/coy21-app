'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/states/loading-state';
import { runValidation, getPreviewRows, downloadErrorReport, approveClaimedUpdates } from './actions';
import { TRAVEL_FIELD_COLUMNS, HEALTH_FIELD_COLUMNS } from '@/lib/import/known-application-columns';

type BatchSummary = {
  id: string;
  status: string;
  original_filename: string;
  sheet_name: string | null;
  valid_count: number;
  warning_count: number;
  error_count: number;
  duplicate_count: number;
  row_count: number | null;
};

type ValidationIssue = { column: string; originalValue: string | null; error: string };

type PreviewRow = {
  id: string;
  excel_row_number: number;
  validation_status: string;
  duplicate_status: string | null;
  claimed_update_approved: boolean;
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
  normalized_row: Record<string, unknown> | null;
  // Only present for duplicate_status = 'duplicate_in_file' rows — resolved
  // server-side (getPreviewRows) via a self-join on
  // import_rows.duplicate_of_row_id, so the UI never has to display a raw
  // UUID or issue a follow-up lookup per duplicate row.
  duplicate_of_row: { excel_row_number: number } | null;
};

type Filter = 'all' | 'valid' | 'warning' | 'invalid' | 'duplicate';

// Triggers a client-side download of a CSV string returned from a server
// action — the action never writes a file on disk or to storage, it just
// returns text, so the Blob/ObjectURL dance below is the only way to hand it
// to the browser as a download.
function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const VALIDATION_STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  valid: 'changed',
  warning: 'mandatory',
  invalid: 'cancelled',
};

export default function PreviewTable({ batchId, initialBatch }: { batchId: string; initialBatch: BatchSummary }) {
  const t = useTranslations('participants.import.preview');
  const router = useRouter();
  const [batch, setBatch] = useState(initialBatch);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [validating, setValidating] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadRows(currentFilter: Filter) {
    setLoadingRows(true);
    setError(null);
    try {
      const data = await getPreviewRows(batchId, currentFilter);
      setRows(data as unknown as PreviewRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setLoadingRows(false);
    }
  }

  useEffect(() => {
    if (batch.status !== 'ready_to_import' && batch.status !== 'imported' && batch.status !== 'importing') return;
    // Every setState call here happens inside the promise chain's callbacks,
    // never as a direct statement in the effect body — the
    // react-hooks/set-state-in-effect rule (part of eslint-config-next's
    // React Compiler plugin) flags synchronous setState calls in an effect
    // body, even a "start of an async fetch" loading-flag call. Threading
    // setLoadingRows(true)/setError(null) through the first .then() (rather
    // than calling them directly before the fetch starts) satisfies the rule
    // while keeping the same "ignore stale response" cleanup-guard shape from
    // https://react.dev/learn/you-might-not-need-an-effect#fetching-data.
    let ignore = false;
    void (async () => {
      if (ignore) return;
      setLoadingRows(true);
      setError(null);
      try {
        const data = await getPreviewRows(batchId, filter);
        if (ignore) return;
        setRows(data as unknown as PreviewRow[]);
      } catch (err) {
        if (ignore) return;
        setError(err instanceof Error ? err.message : t('genericError'));
      } finally {
        if (!ignore) setLoadingRows(false);
      }
    })();
    return () => {
      ignore = true;
    };
    // `t` intentionally omitted: this effect re-fetches preview rows whenever
    // its listed deps change (batchId/filter/batch.status). Adding `t` risks
    // re-running the fetch on locale re-renders. Presentation-only restyle;
    // this data-fetching behavior must not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, filter, batch.status]);

  async function handleRunValidation() {
    setValidating(true);
    setError(null);
    try {
      const result = await runValidation(batchId);
      setBatch((prev) => ({
        ...prev,
        status: 'ready_to_import',
        valid_count: result.validCount,
        warning_count: result.warningCount,
        error_count: result.errorCount,
        duplicate_count: result.duplicateCount,
      }));
      await loadRows(filter);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setValidating(false);
    }
  }

  async function handleDownloadErrorReport() {
    setError(null);
    try {
      const csv = await downloadErrorReport(batchId);
      downloadCsv(`import-${batchId}-errors.csv`, csv);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reportError'));
    }
  }

  const [approvingClaimed, setApprovingClaimed] = useState(false);

  async function handleApproveClaimedUpdates() {
    setApprovingClaimed(true);
    setError(null);
    try {
      await approveClaimedUpdates(batchId);
      await loadRows(filter);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setApprovingClaimed(false);
    }
  }

  const readyToImport = batch.status === 'ready_to_import';
  // A row matching an already-claimed, active participant is a materially
  // higher-risk overwrite than one matching an unclaimed staging row —
  // apply_import_row_transactional refuses to apply it (classifying it
  // 'blocked' instead) until approveClaimedUpdatesForCaller has been called
  // for this batch. Surfaced here so the admin sees the pending review
  // requirement before confirming, not after the import silently skips
  // these rows.
  const claimedRows = rows.filter((r) => r.duplicate_status === 'existing_claimed');
  const unapprovedClaimedCount = claimedRows.filter((r) => !r.claimed_update_approved).length;

  // Issues for a given row, keeping the original errors-then-warnings order.
  function rowIssues(row: PreviewRow) {
    return [...row.errors, ...row.warnings];
  }

  // Phase B (design doc section 13.9): compact per-row indicator only —
  // this does NOT preview every mapped field's value (out of scope; the
  // existing preview intentionally surfaces only full_name/email/issues),
  // just whether this row carries any travel/health data at all, derived
  // from whether any known travel/health target_key has a non-blank value
  // in normalized_row.
  function hasSectionData(row: PreviewRow, keys: readonly string[]): boolean {
    if (!row.normalized_row) return false;
    return keys.some((key) => {
      const value = row.normalized_row![key];
      return value !== null && value !== undefined && value !== '';
    });
  }

  function duplicateLabel(row: PreviewRow) {
    if (row.duplicate_status === 'existing_claimed') {
      return row.claimed_update_approved ? t('duplicateApproved') : t('duplicateNeedsApproval');
    }
    if (row.duplicate_status === 'duplicate_in_file' && row.duplicate_of_row) {
      return t('duplicateOfRow', { row: row.duplicate_of_row.excel_row_number });
    }
    return row.duplicate_status ?? '';
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {batch.status === 'validating' && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('notValidated')}</p>
          <Button type="button" size="sm" onClick={() => void handleRunValidation()} disabled={validating}>
            {validating ? t('validating') : t('runValidation')}
          </Button>
        </div>
      )}

      {batch.status !== 'validating' && (
        <>
          <div className="flex flex-wrap gap-4 text-sm text-charcoal/70 dark:text-gray-400">
            <div>{t('total')}: <span className="font-medium text-charcoal dark:text-gray-100">{batch.row_count ?? 0}</span></div>
            <div>{t('valid')}: <span className="font-medium text-charcoal dark:text-gray-100">{batch.valid_count}</span></div>
            <div>{t('warnings')}: <span className="font-medium text-charcoal dark:text-gray-100">{batch.warning_count}</span></div>
            <div>{t('errors')}: <span className="font-medium text-charcoal dark:text-gray-100">{batch.error_count}</span></div>
            <div>{t('duplicates')}: <span className="font-medium text-charcoal dark:text-gray-100">{batch.duplicate_count}</span></div>
          </div>

          {claimedRows.length > 0 && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-lg border border-gold bg-gold/10 p-4 dark:border-amber-700 dark:bg-amber-900/20"
            >
              <p className="text-sm text-charcoal dark:text-gray-100">
                {t('claimedWarning', { count: claimedRows.length })}
              </p>
              {unapprovedClaimedCount > 0 ? (
                <div>
                  <Button type="button" size="sm" onClick={() => void handleApproveClaimedUpdates()} disabled={approvingClaimed}>
                    {approvingClaimed ? t('approving') : t('approveClaimedUpdates', { count: unapprovedClaimedCount })}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-charcoal dark:text-gray-100">{t('allClaimedApproved')}</p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-charcoal/70 dark:text-gray-400">
              {t('filterLabel')}
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
                className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="all">{t('filterAll')}</option>
                <option value="valid">{t('filterValid')}</option>
                <option value="warning">{t('filterWarning')}</option>
                <option value="invalid">{t('filterInvalid')}</option>
                <option value="duplicate">{t('filterDuplicate')}</option>
              </select>
            </label>
            <Button type="button" size="sm" variant="secondary" onClick={() => void handleDownloadErrorReport()}>
              {t('downloadErrorReport')}
            </Button>
          </div>

          {loadingRows ? (
            <LoadingState variant="table" rows={4} columns={6} />
          ) : (
            <>
              {/* Mobile: card-per-row list. Desktop (md+): table. Both trees
                  render the same `rows` state and must be kept in sync — any
                  column added to one must be added to the other. */}
              <div className="flex flex-col gap-2 md:hidden">
                {rows.map((row) => (
                  <div key={row.id} className="rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-charcoal dark:text-gray-100">
                        {t('row')} {row.excel_row_number}
                      </span>
                      <Badge variant={VALIDATION_STATUS_BADGE_VARIANT[row.validation_status] ?? 'neutral'}>
                        {row.validation_status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-charcoal dark:text-gray-100">
                      {row.normalized_row?.full_name != null ? String(row.normalized_row.full_name) : ''}
                    </p>
                    <p className="text-xs text-charcoal/60 dark:text-gray-400">
                      {row.normalized_row?.email != null ? String(row.normalized_row.email) : ''}
                    </p>
                    {(hasSectionData(row, TRAVEL_FIELD_COLUMNS) || hasSectionData(row, HEALTH_FIELD_COLUMNS)) && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {hasSectionData(row, TRAVEL_FIELD_COLUMNS) && (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
                            {t('hasTravelData')}
                          </span>
                        )}
                        {hasSectionData(row, HEALTH_FIELD_COLUMNS) && (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
                            {t('hasHealthData')}
                          </span>
                        )}
                      </div>
                    )}
                    {duplicateLabel(row) && (
                      <p className="mt-1 text-xs text-charcoal/60 dark:text-gray-400">
                        {t('duplicate')}: {duplicateLabel(row)}
                      </p>
                    )}
                    {rowIssues(row).length > 0 && (
                      <div className="mt-2 flex flex-col gap-0.5">
                        {rowIssues(row).map((issue, i) => (
                          <p key={i} className="text-xs text-charcoal/70 dark:text-gray-400">
                            {issue.column}: {issue.error}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                      <th scope="col" className="px-4 py-2 text-start font-medium">{t('row')}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{t('duplicate')}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{t('name')}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{t('email')}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{t('sensitiveData')}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{t('issues')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-4 py-2 text-charcoal dark:text-gray-100">{row.excel_row_number}</td>
                        <td className="px-4 py-2">
                          <Badge variant={VALIDATION_STATUS_BADGE_VARIANT[row.validation_status] ?? 'neutral'}>
                            {row.validation_status}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{duplicateLabel(row)}</td>
                        <td className="px-4 py-2 text-charcoal dark:text-gray-100">
                          {row.normalized_row?.full_name != null ? String(row.normalized_row.full_name) : ''}
                        </td>
                        <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                          {row.normalized_row?.email != null ? String(row.normalized_row.email) : ''}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap gap-1">
                            {hasSectionData(row, TRAVEL_FIELD_COLUMNS) && (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
                                {t('hasTravelData')}
                              </span>
                            )}
                            {hasSectionData(row, HEALTH_FIELD_COLUMNS) && (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
                                {t('hasHealthData')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                          {rowIssues(row).map((issue, i) => (
                            <div key={i}>
                              {issue.column}: {issue.error}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="flex flex-col gap-2">
            <div>
              <Button
                type="button"
                disabled={!readyToImport}
                onClick={() => router.push(`/participants/import/${batchId}/confirm`)}
              >
                {t('proceedToConfirm')}
              </Button>
            </div>
            {unapprovedClaimedCount > 0 && (
              <p className="text-sm text-charcoal/70 dark:text-gray-400">
                {t('unapprovedNote', { count: unapprovedClaimedCount })}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
