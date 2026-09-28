'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/states/loading-state';
import RollbackTrigger from '../../import/[batchId]/rollback/rollback-trigger';
import { runDownstreamProcessing } from '../../import/[batchId]/downstream-actions';
import { getPreviewRows } from '../../import/[batchId]/preview/actions';

type Batch = {
  id: string;
  status: string;
  downstream_status: string | null;
  original_filename: string;
  sheet_name: string | null;
  storage_path: string;
  row_count: number | null;
  valid_count: number;
  warning_count: number;
  error_count: number;
  duplicate_count: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  next_chunk_offset: number;
  auto_process_downstream: boolean;
  auto_process_cluster_k: number | null;
  failure_reason: string | null;
  uploaded_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
  uploaded_by: string | null;
};

type AuditLogRow = {
  id: string;
  action: string;
  actor_id: string | null;
  metadata: unknown;
  created_at: string;
};

type ApplicationAuditLogRow = AuditLogRow & { entity_id: string };

type ValidationIssue = { column: string; originalValue: string | null; error: string };

type PreviewRow = {
  id: string;
  excel_row_number: number;
  validation_status: string;
  duplicate_status: string | null;
  action_taken: string | null;
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
  normalized_row: Record<string, unknown> | null;
};

// Statuses that mean the batch has actually written something to
// applications/application_answers, i.e. everything from 'importing' onward
// in import_batches_status_valid's ordering — 'ready_to_import' and earlier
// are pre-write states with nothing to roll back. A batch already
// 'rolled_back' is excluded separately so the button never re-offers an
// already-completed rollback. This mirrors rollback/page.tsx's own
// status === 'rolled_back' check, generalized to the full set of states that
// come after writes could have happened.
const ROLLBACK_ELIGIBLE_STATUSES = new Set([
  'importing',
  'imported',
  'processing_features',
  'clustering',
  'allocating',
  'completed',
  'completed_with_warnings',
  'failed',
]);

const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
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

const VALIDATION_STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  valid: 'changed',
  warning: 'mandatory',
  invalid: 'cancelled',
};

export default function BatchDetail({
  batch,
  batchAuditLogs,
  applicationAuditLogs,
}: {
  batch: Batch;
  batchAuditLogs: AuditLogRow[];
  applicationAuditLogs: ApplicationAuditLogRow[];
}) {
  const t = useTranslations('imports.detail');
  const [downstreamStatus, setDownstreamStatus] = useState(batch.downstream_status);
  const [downstreamRunning, setDownstreamRunning] = useState(false);
  const [downstreamError, setDownstreamError] = useState<string | null>(null);
  const [manualK, setManualK] = useState(batch.auto_process_cluster_k ? String(batch.auto_process_cluster_k) : '');

  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [rowsLoaded, setRowsLoaded] = useState(false);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const totalRows = batch.row_count ?? 0;

  const canRollback = ROLLBACK_ELIGIBLE_STATUSES.has(batch.status);
  // Plan text says "status = 'completed'", but downstream-actions.ts's
  // finishWithFailure ALWAYS sets status to 'completed_with_warnings' (not
  // 'completed') on any downstream failure, regardless of error_count — see
  // its unconditional `.update({ downstream_status: 'failed', status:
  // 'completed_with_warnings' })`. A batch whose downstream run failed
  // therefore always lands on 'completed_with_warnings', never 'completed'.
  // Gating strictly on status === 'completed' would permanently hide the
  // retry button for every failed downstream run — the one case it exists
  // to cover. Including 'completed_with_warnings' here is a deliberate
  // deviation from the plan's literal wording to match its actual intent
  // (retry is available after a failure).
  const canRunDownstream =
    (downstreamStatus === null || downstreamStatus === 'failed') && (batch.status === 'completed' || batch.status === 'completed_with_warnings');

  async function handleRunDownstream() {
    setDownstreamRunning(true);
    setDownstreamError(null);
    try {
      const k = manualK ? Number(manualK) : undefined;
      const result = await runDownstreamProcessing(batch.id, k);
      setDownstreamStatus(result.downstreamStatus);
    } catch (err) {
      setDownstreamError(err instanceof Error ? err.message : t('downstreamGenericError'));
      setDownstreamStatus('failed');
    } finally {
      setDownstreamRunning(false);
    }
  }

  async function handleLoadRows() {
    setRowsLoading(true);
    setRowsError(null);
    try {
      const data = await getPreviewRows(batch.id, 'all');
      setRows(data as unknown as PreviewRow[]);
      setRowsLoaded(true);
    } catch (err) {
      setRowsError(err instanceof Error ? err.message : t('rowsError'));
    } finally {
      setRowsLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('statusTitle')}</h2>
        <div className="flex flex-col gap-2 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <p className="text-sm text-charcoal dark:text-gray-100">
            {batch.original_filename}
            {batch.sheet_name ? ` — ${batch.sheet_name}` : ''}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_BADGE_VARIANT[batch.status] ?? 'neutral'}>{batch.status}</Badge>
            <span className="text-sm text-charcoal/70 dark:text-gray-400">
              {t('downstream')}: {downstreamStatus ?? t('downstreamNotStarted')}
            </span>
          </div>
          {batch.failure_reason && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {t('failureReason')}: {batch.failure_reason}
            </p>
          )}
          <p className="text-sm text-charcoal/70 dark:text-gray-400">
            {t('uploaded')}: {new Date(batch.uploaded_at).toLocaleString()}
            {batch.confirmed_at ? ` — ${t('confirmed')}: ${new Date(batch.confirmed_at).toLocaleString()}` : ''}
            {batch.completed_at ? ` — ${t('completed')}: ${new Date(batch.completed_at).toLocaleString()}` : ''}
          </p>
          <p className="text-sm text-charcoal/70 dark:text-gray-400">
            {t('progress', { processed: batch.next_chunk_offset, total: totalRows })}
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('countsTitle')}</h2>
        <div className="overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700">
          <table className="w-full text-start text-sm">
            <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
              {[
                [t('totalRows'), totalRows],
                [t('valid'), batch.valid_count],
                [t('warnings'), batch.warning_count],
                [t('errors'), batch.error_count],
                [t('duplicates'), batch.duplicate_count],
                [t('inserted'), batch.inserted_count],
                [t('updated'), batch.updated_count],
                [t('skipped'), batch.skipped_count],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{label}</td>
                  <td className="px-4 py-2 font-medium text-charcoal dark:text-gray-100">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('actionsTitle')}</h2>
        <div className="flex flex-col gap-4">
          {canRollback ? (
            <RollbackTrigger batchId={batch.id} />
          ) : (
            <p className="text-sm text-charcoal/70 dark:text-gray-400">
              {batch.status === 'rolled_back' ? t('rollbackAlreadyDone') : t('rollbackNotAvailable')}
            </p>
          )}

          {canRunDownstream && (
            <div className="flex flex-col gap-2 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h3 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('downstreamProcessingTitle')}</h3>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-charcoal/70 dark:text-gray-400">
                  {t('clusterCountLabel')}
                  <input
                    type="number"
                    min={1}
                    value={manualK}
                    onChange={(e) => setManualK(e.target.value)}
                    disabled={downstreamRunning}
                    className="w-24 rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
                <Button type="button" size="sm" disabled={downstreamRunning || !manualK} onClick={() => void handleRunDownstream()}>
                  {downstreamRunning ? t('running') : t('runAnalysis')}
                </Button>
              </div>
              {downstreamError && (
                <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                  {downstreamError}
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('rowsTitle')}</h2>
        {!rowsLoaded ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => void handleLoadRows()} disabled={rowsLoading}>
            {rowsLoading ? t('loading') : t('loadRows')}
          </Button>
        ) : rowsLoading ? (
          <LoadingState variant="table" rows={4} columns={7} />
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
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-charcoal/60 dark:text-gray-400">
                    <span>{t('duplicate')}: {row.duplicate_status ?? ''}</span>
                    <span>{t('actionTaken')}: {row.action_taken ?? ''}</span>
                  </div>
                  {[...row.errors, ...row.warnings].length > 0 && (
                    <div className="mt-2 flex flex-col gap-0.5">
                      {[...row.errors, ...row.warnings].map((issue, i) => (
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
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('status_')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('duplicate')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('actionTaken')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('name')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('email')}</th>
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
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.duplicate_status ?? ''}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.action_taken ?? ''}</td>
                      <td className="px-4 py-2 text-charcoal dark:text-gray-100">
                        {row.normalized_row?.full_name != null ? String(row.normalized_row.full_name) : ''}
                      </td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                        {row.normalized_row?.email != null ? String(row.normalized_row.email) : ''}
                      </td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                        {[...row.errors, ...row.warnings].map((issue, i) => (
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
        {rowsError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {rowsError}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('auditTrailTitle')}</h2>
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="mb-2 text-sm font-medium text-charcoal dark:text-gray-100">{t('batchEventsTitle')}</h3>
            {batchAuditLogs.length === 0 ? (
              <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noBatchEvents')}</p>
            ) : (
              <>
                {/* Mobile: card-per-log list. Desktop (md+): table. Both
                    trees render the same `batchAuditLogs` data and must be
                    kept in sync — any column added to one must be added to
                    the other. */}
                <div className="flex flex-col gap-2 md:hidden">
                  {batchAuditLogs.map((log) => (
                    <div key={log.id} className="rounded-lg border border-charcoal/10 bg-warm-white p-3 dark:border-gray-700 dark:bg-gray-900">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-charcoal dark:text-gray-100">{log.action}</span>
                        <span className="text-xs text-charcoal/60 dark:text-gray-400">{new Date(log.created_at).toLocaleString()}</span>
                      </div>
                      <p className="mt-1 text-xs text-charcoal/60 dark:text-gray-400">{log.actor_id ?? t('unknownActor')}</p>
                      {log.metadata != null && (
                        <code className="mt-1 block break-all text-xs text-charcoal/70 dark:text-gray-400">
                          {JSON.stringify(log.metadata)}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
                  <table className="w-full text-start text-sm">
                    <thead>
                      <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('when')}</th>
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('action')}</th>
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('actor')}</th>
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('metadata')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                      {batchAuditLogs.map((log) => (
                        <tr key={log.id}>
                          <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{new Date(log.created_at).toLocaleString()}</td>
                          <td className="px-4 py-2 text-charcoal dark:text-gray-100">{log.action}</td>
                          <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{log.actor_id ?? t('unknownActor')}</td>
                          <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                            <code>{log.metadata ? JSON.stringify(log.metadata) : ''}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-charcoal dark:text-gray-100">{t('perRowEventsTitle')}</h3>
            {applicationAuditLogs.length === 0 ? (
              <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noPerRowEvents')}</p>
            ) : (
              <>
                {/* Mobile: card-per-log list. Desktop (md+): table. Both
                    trees render the same `applicationAuditLogs` data and must
                    be kept in sync — any column added to one must be added to
                    the other. */}
                <div className="flex flex-col gap-2 md:hidden">
                  {applicationAuditLogs.map((log) => (
                    <div key={log.id} className="rounded-lg border border-charcoal/10 bg-warm-white p-3 dark:border-gray-700 dark:bg-gray-900">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-charcoal dark:text-gray-100">{log.action}</span>
                        <span className="text-xs text-charcoal/60 dark:text-gray-400">{new Date(log.created_at).toLocaleString()}</span>
                      </div>
                      <p className="mt-1 text-xs text-charcoal/60 dark:text-gray-400">
                        {t('application')}: {log.entity_id}
                      </p>
                      <p className="text-xs text-charcoal/60 dark:text-gray-400">{log.actor_id ?? t('unknownActor')}</p>
                      {log.metadata != null && (
                        <code className="mt-1 block break-all text-xs text-charcoal/70 dark:text-gray-400">
                          {JSON.stringify(log.metadata)}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
                  <table className="w-full text-start text-sm">
                    <thead>
                      <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('when')}</th>
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('action')}</th>
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('application')}</th>
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('actor')}</th>
                        <th scope="col" className="px-4 py-2 text-start font-medium">{t('metadata')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                      {applicationAuditLogs.map((log) => (
                        <tr key={log.id}>
                          <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{new Date(log.created_at).toLocaleString()}</td>
                          <td className="px-4 py-2 text-charcoal dark:text-gray-100">{log.action}</td>
                          <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{log.entity_id}</td>
                          <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{log.actor_id ?? t('unknownActor')}</td>
                          <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                            <code>{log.metadata ? JSON.stringify(log.metadata) : ''}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
