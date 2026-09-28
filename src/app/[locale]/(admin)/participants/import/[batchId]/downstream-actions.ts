// src/app/[locale]/(admin)/participants/import/[batchId]/downstream-actions.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { idSchema } from '@/lib/validation/import';
import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { runFeatureExtraction } from '@/lib/allocation/run-extraction';
import { runClustering } from '@/lib/allocation/run-clustering';
import { runAllocation } from '@/lib/allocation/run-allocation';
import { deriveSeedFromBatchId } from '@/lib/import/seed-derivation';

type ServiceClient = SupabaseClient<Database>;

// Reuses requireAgendaStaffCaller from src/lib/agenda/server-helpers, same
// precedent Tasks 12-16 established, rather than a local role check.
//
// This function is the SAME code path for both triggers described in the
// plan: (a) automatic, called from import-progress.tsx right after Task 15's
// chunk loop reports isComplete, but ONLY when the admin opted in at import
// time via import_batches.auto_process_downstream; and (b) manual, via an
// explicit "Run analysis and allocation" button an admin can click later
// (e.g. if they didn't enable auto-process, or want to re-run with a
// different k). Neither path auto-confirms an allocation, auto-publishes a
// schedule, auto-sends invitations, or auto-issues QR codes — this function's
// scope stops at inserting a 'draft' allocation_runs row (runAllocation's own
// behavior); everything after that remains a separate, explicit admin action
// on the existing allocation UI.

export interface DownstreamProcessingResult {
  downstreamStatus: 'completed' | 'failed';
  featureExtractionRunId?: string;
  clusteringRunId?: string;
  allocationRunId?: string;
}

/**
 * clusterKInput: required for the manual path (the admin picks k on the
 * trigger button/form for a batch that never set auto_process_cluster_k).
 * For the automatic path, pass undefined — the batch's own
 * auto_process_cluster_k is used. If neither is available, this throws
 * before anything is written.
 */
export async function runDownstreamProcessingForCaller(
  batchIdInput: unknown,
  caller: { userId: string; service: ServiceClient },
  clusterKInput?: number
): Promise<DownstreamProcessingResult> {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = caller;

  const { data: batch, error: batchError } = await service
    .from('import_batches')
    .select('status, auto_process_cluster_k, error_count, downstream_status')
    .eq('id', batchId)
    .single();
  if (batchError || !batch) throw new Error('Batch not found');

  // Re-entrancy guard: two concurrent calls (a double-click past the
  // client-side `disabled` guard, a second tab, a replayed request) would
  // otherwise each independently call runFeatureExtraction/runClustering/
  // runAllocation with no lock between them, producing duplicate runs — there
  // is no processing_lock_token-style mechanism here the way Task 15's chunk
  // loop has one. A full lock isn't warranted for a single non-chunked call,
  // but a cheap conditional claim on downstream_status closes most of the
  // gap: only a batch not already mid-run (or previously completed) can
  // proceed, and the update's own row-count check is what makes two
  // concurrent callers race safely — only one can win the transition.
  if (batch.downstream_status === 'processing_features' || batch.downstream_status === 'clustering' || batch.downstream_status === 'allocating') {
    throw new Error(`Downstream processing is already running for this batch (status: ${batch.downstream_status})`);
  }
  // `.not('downstream_status', 'in', '(...)')` compiles to
  // `NOT (downstream_status IN (...))`, which is SQL NULL — not TRUE — for a
  // row whose downstream_status IS NULL (three-valued logic), so it would
  // silently exclude every batch that has never run downstream processing
  // yet, i.e. every real first-time caller. `.or(...)` explicitly admits the
  // null case alongside the "not currently mid-run" case.
  const { data: claimed, error: claimError } = await service
    .from('import_batches')
    .update({ downstream_status: 'processing_features' })
    .eq('id', batchId)
    .or('downstream_status.is.null,downstream_status.not.in.(processing_features,clustering,allocating)')
    .select('id')
    .maybeSingle();
  if (claimError) throw new Error(`Failed to claim downstream processing: ${claimError.message}`);
  if (!claimed) throw new Error('Downstream processing is already running for this batch (lost the claim race)');

  const k = clusterKInput ?? batch.auto_process_cluster_k ?? undefined;
  if (k === undefined) {
    throw new Error('No cluster k available — pass one explicitly, or set auto_process_cluster_k on the batch');
  }
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error('Cluster k must be a positive integer');
  }

  let featureExtractionRunId: string | undefined;
  let clusteringRunId: string | undefined;
  let allocationRunId: string | undefined;

  const markDownstreamStatus = async (status: string) => {
    const { error } = await service.from('import_batches').update({ downstream_status: status }).eq('id', batchId);
    if (error) throw new Error(`Failed to update downstream_status: ${error.message}`);
  };

  const finishWithFailure = async (stage: string, err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await service
      .from('import_batches')
      .update({ downstream_status: 'failed', status: 'completed_with_warnings' })
      .eq('id', batchId);
    await writeAuditLog(service, {
      entityType: 'import_batch',
      entityId: batchId,
      action: 'downstream_processing_failed',
      actorId: userId,
      metadata: { stage, message, featureExtractionRunId, clusteringRunId, allocationRunId },
    });
    throw err;
  };

  try {
    // downstream_status is already 'processing_features' from the claim
    // above — no separate markDownstreamStatus call needed for this stage.
    const extraction = await runFeatureExtraction(service, userId);
    featureExtractionRunId = extraction.id;
    await writeAuditLog(service, {
      entityType: 'feature_extraction_run',
      entityId: extraction.id,
      action: 'run',
      actorId: userId,
      metadata: { applicationCount: extraction.applicationCount, importBatchId: batchId },
    });
  } catch (err) {
    await finishWithFailure('processing_features', err);
  }

  try {
    await markDownstreamStatus('clustering');
    const clustering = await runClustering(service, userId, featureExtractionRunId!, k, deriveSeedFromBatchId(batchId));
    clusteringRunId = clustering.id;
    await writeAuditLog(service, {
      entityType: 'clustering_run',
      entityId: clustering.id,
      action: 'run',
      actorId: userId,
      metadata: { featureExtractionRunId, k, importBatchId: batchId },
    });

    // runClustering doesn't throw when there aren't enough feature vectors
    // for k — it records a clustering_runs row with status: 'failed' and
    // returns normally. Treat that the same as a thrown error: stop the
    // pipeline before allocation, but keep the already-completed
    // feature_extraction_runs row (don't roll it back).
    const { data: clusteringRow, error: clusteringFetchError } = await service
      .from('clustering_runs')
      .select('status')
      .eq('id', clustering.id)
      .single();
    if (clusteringFetchError || !clusteringRow) throw new Error('Failed to read back clustering run status');
    if (clusteringRow.status === 'failed') {
      throw new Error(`Clustering run ${clustering.id} completed with status 'failed' (k=${k} likely exceeds available feature vectors)`);
    }
  } catch (err) {
    await finishWithFailure('clustering', err);
  }

  try {
    await markDownstreamStatus('allocating');
    const allocation = await runAllocation(service, userId, featureExtractionRunId!);
    allocationRunId = allocation.id;
    await writeAuditLog(service, {
      entityType: 'allocation_run',
      entityId: allocation.id,
      action: 'run',
      actorId: userId,
      metadata: { featureExtractionRunId, importBatchId: batchId },
    });
  } catch (err) {
    await finishWithFailure('allocation', err);
  }

  const finalBatchStatus = (batch.error_count ?? 0) > 0 ? 'completed_with_warnings' : 'completed';
  const { error: finalUpdateError } = await service
    .from('import_batches')
    .update({ downstream_status: 'completed', status: finalBatchStatus })
    .eq('id', batchId);
  if (finalUpdateError) {
    // All three pipeline stages already succeeded — only the final status
    // write failed. Route through the same failure path as a mid-stage
    // error so this isn't left stuck at downstream_status='allocating' with
    // no audit trail: an admin re-running would otherwise see a batch that
    // looks perpetually in-progress despite already having real
    // feature-extraction/clustering/allocation rows.
    await finishWithFailure('finalize', new Error(`Failed to finalize batch status: ${finalUpdateError.message}`));
  }

  await writeAuditLog(service, {
    entityType: 'import_batch',
    entityId: batchId,
    action: 'downstream_processing_completed',
    actorId: userId,
    metadata: { featureExtractionRunId, clusteringRunId, allocationRunId },
  });

  return { downstreamStatus: 'completed', featureExtractionRunId, clusteringRunId, allocationRunId };
}

/**
 * clusterK: required on the manual path when the batch has no
 * auto_process_cluster_k set (e.g. auto-process was never enabled). Omit it
 * for the automatic post-import trigger, or when re-running a batch that
 * already has auto_process_cluster_k stored.
 */
export async function runDownstreamProcessing(batchIdInput: unknown, clusterK?: number): Promise<DownstreamProcessingResult> {
  const caller = await requireAgendaStaffCaller();
  return runDownstreamProcessingForCaller(batchIdInput, caller, clusterK);
}
