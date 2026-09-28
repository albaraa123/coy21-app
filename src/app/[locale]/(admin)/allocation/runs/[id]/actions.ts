// src/app/[locale]/(admin)/allocation/runs/[id]/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { checkStaticHardConstraints, type ParticipantForConstraints, type SessionForConstraints } from '@/lib/allocation/hard-constraints';
import { idSchema, overrideAssignmentSchema } from '@/lib/validation/allocation';

export async function confirmAllocationRun(runId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsedRunId = idSchema.parse(runId);
  const { data, error } = await service.rpc('confirm_allocation_run_transactional', { p_run_id: parsedRunId, p_confirmed_by: userId });
  if (error) throw new Error(`Failed to confirm allocation run: ${error.message}`);
  await writeAuditLog(service, { entityType: 'allocation_run', entityId: parsedRunId, action: 'confirm', actorId: userId });
  return data;
}

export async function discardAllocationRun(runId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsedRunId = idSchema.parse(runId);
  const { data, error } = await service.rpc('discard_allocation_run_transactional', { p_run_id: parsedRunId });
  if (error) throw new Error(`Failed to discard allocation run: ${error.message}`);
  await writeAuditLog(service, { entityType: 'allocation_run', entityId: parsedRunId, action: 'discard', actorId: userId });
  return data;
}

export async function overrideAssignment(assignmentId: string, input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsedAssignmentId = idSchema.parse(assignmentId);
  const parsed = overrideAssignmentSchema.parse(input);

  // Re-validate hard constraints server-side before writing — hard reject,
  // never bypassed (spec: Manual Override Workflow failure behavior).
  const { data: assignment, error: assignmentErr } = await service
    .from('allocation_assignments')
    .select('id, application_id, allocation_run_id')
    .eq('id', parsedAssignmentId)
    .single();
  if (assignmentErr || !assignment) throw new Error('Assignment not found');

  const { data: application, error: appErr } = await service
    .from('applications')
    .select('preferred_language, experience_level')
    .eq('id', assignment.application_id)
    .single();
  if (appErr || !application) throw new Error('Application not found');

  const { data: session, error: sessionErr } = await service
    .from('sessions')
    .select('id, status, include_in_allocation, language, difficulty_level, is_mandatory, capacity')
    .eq('id', parsed.sessionId)
    .single();
  if (sessionErr || !session) throw new Error('Target session not found');

  const participant: ParticipantForConstraints = {
    applicationId: assignment.application_id,
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
    throw new Error(`Cannot assign: ${failed?.detail ?? 'hard constraint failed'}`);
  }

  // Fast-fail capacity pre-check for a quick, specific error message — NOT
  // the authoritative guard. This read-then-later-write has a TOCTOU gap
  // (two concurrent overrides could both read count < capacity and both
  // pass), so the real, atomic enforcement lives inside
  // override_allocation_assignment_transactional itself (it re-counts this
  // run's assignments for the target session in the same transaction as the
  // write). Flagged by migration/RPC review; fixed by moving the
  // authoritative check into the RPC rather than relying on this pre-check.
  const { count, error: countErr } = await service
    .from('allocation_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('allocation_run_id', assignment.allocation_run_id)
    .eq('session_id', parsed.sessionId);
  if (countErr) throw new Error(`Failed to check capacity: ${countErr.message}`);
  if ((count ?? 0) >= session.capacity) {
    throw new Error('Cannot assign: session is at capacity for this allocation run');
  }

  const { data, error } = await service.rpc('override_allocation_assignment_transactional', {
    p_assignment_id: parsedAssignmentId,
    p_new_session_id: parsed.sessionId,
    p_overridden_by: userId,
    p_override_reason: parsed.overrideReason,
  });
  if (error) throw new Error(`Failed to override assignment: ${error.message}`);

  await writeAuditLog(service, {
    entityType: 'allocation_assignment',
    entityId: parsedAssignmentId,
    action: 'override',
    actorId: userId,
    metadata: { newSessionId: parsed.sessionId, reason: parsed.overrideReason },
  });
  return data;
}
