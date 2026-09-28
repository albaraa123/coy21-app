// src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { stagePublication } from '@/lib/schedule/run-stage-publication';
import { confirmPublication, reassignBlockedParticipant, overridePublishWithGap } from '@/lib/schedule/run-confirm-publication';
import { checkStaticHardConstraints, type ParticipantForConstraints, type SessionForConstraints } from '@/lib/allocation/hard-constraints';
import { idSchema } from '@/lib/validation/allocation';
import { reassignSchema, overridePublishWithGapSchema } from '@/lib/validation/schedule';

export async function triggerStagePublication(allocationRunId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsedRunId = idSchema.parse(allocationRunId);
  const result = await stagePublication(service, userId, { allocationRunId: parsedRunId });
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: result.id, action: 'stage', actorId: userId, metadata: { allocationRunId: parsedRunId } });
  return result;
}

export async function confirmDraftPublication(draftId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsedDraftId = idSchema.parse(draftId);
  const result = await confirmPublication(service, parsedDraftId, userId);
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: parsedDraftId, action: 'confirm', actorId: userId });
  return result;
}

// Hard-constraint re-validation (status/inclusion/language/difficulty)
// happens HERE, in TypeScript, before the RPC is ever called — Task 10's
// reassign_blocked_participant_transactional deliberately does not
// duplicate this logic in SQL (see that task's header comment). This
// mirrors Phase 4's overrideAssignment action doing its own
// checkStaticHardConstraints call before invoking
// override_allocation_assignment_transactional. A failing check here must
// throw before the RPC runs — the RPC's own capacity guard is not a
// substitute for this check.
export async function reassignDraftItem(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = reassignSchema.parse(input);

  const { data: draftItem, error: draftItemErr } = await service
    .from('schedule_publication_draft_items')
    .select('id, application_id')
    .eq('id', parsed.draftItemId)
    .single();
  if (draftItemErr || !draftItem) throw new Error('Draft item not found');

  const { data: application, error: appErr } = await service
    .from('applications')
    .select('preferred_language, experience_level')
    .eq('id', draftItem.application_id)
    .single();
  if (appErr || !application) throw new Error('Application not found');

  const { data: session, error: sessionErr } = await service
    .from('sessions')
    .select('id, status, include_in_allocation, language, difficulty_level, is_mandatory')
    .eq('id', parsed.newSessionId)
    .single();
  if (sessionErr || !session) throw new Error('Target session not found');

  const participant: ParticipantForConstraints = {
    applicationId: draftItem.application_id,
    preferredLanguage: application.preferred_language,
    experienceLevel: application.experience_level,
  };
  const sessionForConstraints: SessionForConstraints = {
    id: session.id,
    status: session.status,
    includeInAllocation: session.include_in_allocation,
    language: session.language,
    difficultyLevel: session.difficulty_level,
    isMandatory: session.is_mandatory,
  };
  const constraintResult = checkStaticHardConstraints(participant, sessionForConstraints);
  if (!constraintResult.eligible) {
    const failed = constraintResult.checks.find((c) => !c.passed);
    throw new Error(`Cannot reassign: ${failed?.detail ?? 'hard constraint failed'}`);
  }

  const result = await reassignBlockedParticipant(service, parsed.draftItemId, parsed.newSessionId, userId);
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: parsed.draftItemId, action: 'reassign', actorId: userId, metadata: { newSessionId: parsed.newSessionId } });
  return result;
}

export async function overrideDraftItemWithGap(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = overridePublishWithGapSchema.parse(input);
  await overridePublishWithGap(service, parsed.draftItemId, parsed.overrideReason);
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: parsed.draftItemId, action: 'override', actorId: userId, metadata: { reason: parsed.overrideReason } });
}
