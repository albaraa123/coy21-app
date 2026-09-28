// src/app/[locale]/(admin)/allocation/schedules/changed/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { processChangeEvents } from '@/lib/schedule/run-process-change-events';
import { stagePublication } from '@/lib/schedule/run-stage-publication';
import { idSchema } from '@/lib/validation/allocation';
import { z } from 'zod';

export async function triggerProcessChangeEvents() {
  const { userId, service } = await requireAgendaStaffCaller();
  const result = await processChangeEvents(service);
  await writeAuditLog(service, { entityType: 'schedule_change_event', entityId: userId, action: 'process_change_event', actorId: userId, metadata: { processedCount: result.processedCount } });
  return result;
}

const changeEventIdsSchema = z.array(idSchema).min(1);

export async function triggerStageFromChangeEvents(changeEventIds: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = changeEventIdsSchema.parse(changeEventIds);
  const result = await stagePublication(service, userId, { changeEventIds: parsed });
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: result.id, action: 'stage', actorId: userId, metadata: { changeEventIds: parsed } });
  return result;
}
