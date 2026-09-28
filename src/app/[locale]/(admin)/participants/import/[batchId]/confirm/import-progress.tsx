'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/states/loading-state';
import { startImport, resumeImportBatch, processImportChunk } from './actions';
import { runDownstreamProcessing } from '../downstream-actions';

type BatchSummary = {
  id: string;
  status: string;
  original_filename: string;
  sheet_name: string | null;
  row_count: number | null;
  valid_count: number;
  warning_count: number;
  error_count: number;
  duplicate_count: number;
  next_chunk_offset: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  auto_process_downstream: boolean;
  auto_process_cluster_k: number | null;
  downstream_status: string | null;
};

type Counts = { inserted: number; updated: number; skipped: number };

export default function ImportProgress({ batchId, initialBatch }: { batchId: string; initialBatch: BatchSummary }) {
  const t = useTranslations('participants.import.confirm');
  const [status, setStatus] = useState(initialBatch.status);
  const [processed, setProcessed] = useState(initialBatch.next_chunk_offset);
  const [counts, setCounts] = useState<Counts>({
    inserted: initialBatch.inserted_count,
    updated: initialBatch.updated_count,
    skipped: initialBatch.skipped_count,
  });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downstreamStatus, setDownstreamStatus] = useState(initialBatch.downstream_status);
  const [downstreamRunning, setDownstreamRunning] = useState(false);
  const [downstreamError, setDownstreamError] = useState<string | null>(null);
  const [manualK, setManualK] = useState('');
  const totalRows = initialBatch.row_count ?? 0;

  // Runs the same downstream pipeline (feature extraction -> clustering ->
  // allocation) that the manual button below triggers. Only ever invoked
  // here when initialBatch.auto_process_downstream is true — an admin who
  // did not opt in at import time sees only the manual button, never an
  // automatic run. Stops at a 'draft' allocation_runs row; nothing here
  // confirms an allocation, publishes a schedule, or sends anything.
  const runDownstream = useCallback(
    async (clusterK?: number) => {
      setDownstreamRunning(true);
      setDownstreamError(null);
      try {
        const result = await runDownstreamProcessing(batchId, clusterK);
        setDownstreamStatus(result.downstreamStatus);
      } catch (err) {
        setDownstreamError(err instanceof Error ? err.message : t('downstreamGenericError'));
        setDownstreamStatus('failed');
      } finally {
        setDownstreamRunning(false);
      }
    },
    // `t` intentionally omitted: this callback feeds the chunk-import loop's
    // dependency graph (see runChunks below), and widening the array risks
    // re-creating — and thus re-triggering effects that depend on —
    // this callback on every locale-provider re-render. Presentation-only
    // restyle; the import/rollback control flow must not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batchId]
  );

  // Guards against React 18 StrictMode's double-invoked effects (and any
  // stray re-render) kicking off two concurrent chunk loops for the same
  // batch. The server-side lock token would reject the second loop anyway —
  // this just avoids surfacing a spurious "superseded lock" error to the
  // admin for something the UI caused itself.
  const loopStarted = useRef(false);

  // Drives the chunk loop to completion with an already-acquired lock token.
  const runChunks = useCallback(
    async (lockToken: string) => {
      setRunning(true);
      setError(null);
      try {
        let done = false;
        while (!done) {
          const result = await processImportChunk({ batchId, lockToken });
          setProcessed(result.nextOffset);
          setCounts(result.counts);
          done = result.isComplete;
          if (done) setStatus('imported');
        }
        // Automatic downstream trigger — ONLY when the admin explicitly
        // enabled it at import time (auto_process_downstream). This is the
        // sole automatic call site; the manual button below is the only
        // other way runDownstream ever runs.
        if (done && initialBatch.auto_process_downstream) {
          await runDownstream();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('genericError'));
      } finally {
        setRunning(false);
      }
    },
    // `t` intentionally omitted: runChunks drives the resumable chunk-import
    // loop (see the mid-import-reload useEffect below, guarded by
    // loopStarted.current). Adding `t` here risks re-creating this callback
    // on locale re-renders, which could re-run the resume effect and
    // re-acquire the import lock mid-loop. Presentation-only restyle; this
    // control flow must not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batchId, initialBatch.auto_process_downstream, runDownstream]
  );

  // The explicit admin-triggered confirm. This is the ONLY thing that starts
  // real writes to applications/application_answers — nothing on this page
  // imports automatically.
  async function handleConfirm() {
    if (running) return;
    loopStarted.current = true;
    setRunning(true);
    setError(null);
    try {
      const { lockToken } = await startImport(batchId);
      setStatus('importing');
      await runChunks(lockToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('startError'));
      setRunning(false);
    }
  }

  // Mid-import page reload: the batch is already 'importing' but this browser
  // session holds no lock token. Take over the (expired) lock via
  // resumeImportBatch and continue from the batch's own next_chunk_offset —
  // never restart from zero, which would re-apply already-imported rows.
  // (The RPC's action_taken guard would make that a no-op anyway; resuming
  // from the stored offset is simply the correct behaviour.)
  useEffect(() => {
    if (initialBatch.status !== 'importing' || loopStarted.current) return;
    loopStarted.current = true;
    let cancelled = false;
    (async () => {
      try {
        const { lockToken } = await resumeImportBatch(batchId);
        if (cancelled) return;
        await runChunks(lockToken);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('resumeError'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` intentionally omitted: this effect performs the mid-import-reload
    // lock takeover and resume (resumeImportBatch + runChunks), guarded by
    // loopStarted.current to run exactly once. Adding `t` risks re-running
    // this effect on locale re-renders and double-acquiring the lock.
    // Presentation-only restyle; this control flow must not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, initialBatch.status, runChunks]);

  const percent = totalRows > 0 ? Math.min(100, Math.round((processed / totalRows) * 100)) : 0;
  const isComplete = status === 'imported';

  return (
    <div className="flex flex-col gap-4">
      {status === 'ready_to_import' && !running && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('warningText', { count: totalRows })}</p>
          <div>
            <Button type="button" onClick={handleConfirm} disabled={running}>
              {t('confirmAndImport')}
            </Button>
          </div>
        </div>
      )}

      {(running || isComplete || status === 'importing') && (
        <div className="flex flex-col gap-2">
          <progress value={processed} max={totalRows || 1} className="h-2 w-full accent-turquoise" />
          <p className="text-sm text-charcoal/70 dark:text-gray-400">
            {t('rowsProgress', { processed, total: totalRows, percent })}
          </p>
          <p className="text-sm text-charcoal/70 dark:text-gray-400">
            {t('countsLine', { inserted: counts.inserted, updated: counts.updated, skipped: counts.skipped })}
          </p>
        </div>
      )}

      {isComplete && <p className="text-sm font-medium text-charcoal dark:text-gray-100">{t('complete')}</p>}

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {/* Manual downstream trigger. Works identically to the automatic path
          (same runDownstreamProcessing call) — the only difference is an
          admin who did not enable auto_process_downstream at import time can
          still kick off analysis + allocation later from here, supplying k
          themselves. If auto-process ran automatically above, this section
          just reflects that outcome; it never runs a second time on its own.
          For a batch with auto-process disabled and no k on file, this is
          purely additive — the existing clustering page's own form remains
          available and unchanged regardless. */}
      {isComplete && !initialBatch.auto_process_downstream && (
        <div className="flex flex-col gap-2 border-t border-charcoal/10 pt-4 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('downstreamTitle')}</h2>
          {downstreamStatus === 'completed' ? (
            <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('downstreamCompleted')}</p>
          ) : (
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
              <Button
                type="button"
                size="sm"
                disabled={downstreamRunning || !manualK}
                onClick={() => runDownstream(Number(manualK))}
              >
                {t('runAnalysis')}
              </Button>
            </div>
          )}
          {downstreamRunning && (
            <div className="flex items-center gap-2 text-sm text-charcoal/70 dark:text-gray-400">
              <LoadingState variant="inline" />
              <span>{t('downstreamRunning')}</span>
            </div>
          )}
          {downstreamStatus === 'failed' && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {t('downstreamFailed')}
            </p>
          )}
          {downstreamError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {downstreamError}
            </p>
          )}
        </div>
      )}

      {isComplete && initialBatch.auto_process_downstream && (
        <div className="flex flex-col gap-2 border-t border-charcoal/10 pt-4 dark:border-gray-700">
          {downstreamRunning && (
            <div className="flex items-center gap-2 text-sm text-charcoal/70 dark:text-gray-400">
              <LoadingState variant="inline" />
              <span>{t('downstreamRunning')}</span>
            </div>
          )}
          {downstreamStatus === 'completed' && (
            <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('downstreamCompletedAuto')}</p>
          )}
          {downstreamStatus === 'failed' && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {t('downstreamFailedAuto', { error: downstreamError ?? '' })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
