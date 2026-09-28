// src/lib/allocation/run-clustering.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/types/database';
import { runKMeans, type FeatureVector } from './clustering';

type ServiceClient = SupabaseClient<Database>;

export async function runClustering(
  service: ServiceClient,
  runBy: string,
  featureExtractionRunId: string,
  k: number,
  randomSeed: number
): Promise<{ id: string }> {
  const { data: snapshots, error } = await service
    .from('participant_feature_snapshots')
    .select('application_id, tag_id, weight')
    .eq('feature_extraction_run_id', featureExtractionRunId)
    .order('application_id', { ascending: true });
  if (error) throw new Error(`Failed to load feature snapshots: ${error.message}`);

  const byApplication = new Map<string, Record<string, number>>();
  for (const row of snapshots ?? []) {
    if (!byApplication.has(row.application_id)) byApplication.set(row.application_id, {});
    byApplication.get(row.application_id)![row.tag_id] = row.weight;
  }
  // Map iteration order follows insertion order, which now follows the
  // explicit application_id ordering above — required for reproducibility,
  // since this array's order determines runKMeans's seeded initial-centroid
  // selection (flagged by whole-branch code review: without a deterministic
  // order here, "identical seed+k+input -> identical output" only held
  // incidentally, relying on Postgres's typical-but-unguaranteed row order).
  const vectors: FeatureVector[] = Array.from(byApplication.entries()).map(([applicationId, weights]) => ({ applicationId, weights }));

  if (vectors.length < k) {
    const { data: failedRun, error: failError } = await service
      .from('clustering_runs')
      .insert({ feature_extraction_run_id: featureExtractionRunId, k, random_seed: randomSeed, status: 'failed', run_by: runBy })
      .select('id')
      .single();
    if (failError || !failedRun) throw new Error(`Failed to record failed clustering run: ${failError?.message}`);
    return { id: failedRun.id };
  }

  const result = runKMeans(vectors, k, randomSeed);

  const { data: run, error: runError } = await service
    .from('clustering_runs')
    .insert({ feature_extraction_run_id: featureExtractionRunId, k, random_seed: randomSeed, status: 'completed', run_by: runBy })
    .select('id')
    .single();
  if (runError || !run) throw new Error(`Failed to create clustering_runs row: ${runError?.message}`);

  const clusterIdByIndex = new Map<number, string>();
  for (const cluster of result.clusters) {
    const { data: clusterRow, error: clusterError } = await service
      .from('clusters')
      // `centroid` is a sparse Record<string, number>, but the generated
      // Insert type for this jsonb column is `Json`, which `unknown`/plain
      // object literals aren't structurally assignable to. Cast, matching
      // the same pattern used for metadata/old_values/new_values in
      // writeAuditLog (src/lib/agenda/server-helpers.ts) — the value is
      // always JSON-serializable at runtime.
      .insert({ clustering_run_id: run.id, centroid: cluster.centroid as Json, member_count: cluster.memberCount })
      .select('id')
      .single();
    if (clusterError || !clusterRow) throw new Error(`Failed to create cluster row: ${clusterError?.message}`);
    clusterIdByIndex.set(cluster.index, clusterRow.id);
  }

  const membershipRows = result.memberships.map((m) => ({
    cluster_id: clusterIdByIndex.get(m.clusterIndex)!,
    application_id: m.applicationId,
    distance_to_centroid: m.distanceToCentroid,
  }));
  if (membershipRows.length > 0) {
    const { error: membershipError } = await service.from('cluster_memberships').insert(membershipRows);
    if (membershipError) throw new Error(`Failed to write cluster memberships: ${membershipError.message}`);
  }

  return { id: run.id };
}
