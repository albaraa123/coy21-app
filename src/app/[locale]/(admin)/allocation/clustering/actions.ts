// src/app/[locale]/(admin)/allocation/clustering/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { runClustering } from '@/lib/allocation/run-clustering';
import { triggerClusteringSchema } from '@/lib/validation/allocation';

export async function triggerClusteringRun(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = triggerClusteringSchema.parse(input);
  const result = await runClustering(service, userId, parsed.featureExtractionRunId, parsed.k, parsed.randomSeed);
  await writeAuditLog(service, { entityType: 'clustering_run', entityId: result.id, action: 'run', actorId: userId, metadata: parsed });
  return result;
}
