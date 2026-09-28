// src/app/[locale]/(admin)/allocation/runs/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { runAllocation } from '@/lib/allocation/run-allocation';
import { triggerAllocationRunSchema } from '@/lib/validation/allocation';

export async function triggerAllocationRun(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = triggerAllocationRunSchema.parse(input);
  const result = await runAllocation(service, userId, parsed.featureExtractionRunId);
  await writeAuditLog(service, { entityType: 'allocation_run', entityId: result.id, action: 'run', actorId: userId });
  return result;
}
