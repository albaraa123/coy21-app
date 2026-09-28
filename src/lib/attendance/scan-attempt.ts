// src/lib/attendance/scan-attempt.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';
import { computeTimeSlotGroupKeyForSession } from './time-slot-lookup';
import { getScannerParticipantSummary } from './participant-summary';
import { resolveAdmissionDecision, type SessionForAdmission, type SessionCounts } from './resolve-admission-decision';

type ServiceClient = SupabaseClient<Database>;

async function verifyScannerScope(service: ServiceClient, userId: string, sessionId: string): Promise<void> {
  const { data: session } = await service.from('sessions').select('id, room_id').eq('id', sessionId).single();
  if (!session) throw new Error('Session not found');
  const { count } = await service
    .from('scanner_assignments')
    .select('*', { count: 'exact', head: true })
    .eq('scanner_user_id', userId)
    .eq('is_active', true)
    .or(`session_id.eq.${sessionId},room_id.eq.${session.room_id}`);
  if (!count || count === 0) throw new Error('Not authorized for this session/room');
}

async function loadSessionForAdmission(service: ServiceClient, sessionId: string): Promise<SessionForAdmission> {
  const { data, error } = await service
    .from('sessions')
    .select('status, admission_policy, capacity, priority_seats, priority_release_at, priority_release_minutes_before, late_entry_cutoff_minutes, flexible_entry_manual_override, start_time')
    .eq('id', sessionId)
    .single();
  if (error || !data) throw new Error('Session not found');
  return {
    status: data.status,
    admissionPolicy: data.admission_policy as SessionForAdmission['admissionPolicy'],
    capacity: data.capacity,
    prioritySeats: data.priority_seats,
    priorityReleaseAt: data.priority_release_at,
    priorityReleaseMinutesBefore: data.priority_release_minutes_before,
    lateEntryCutoffMinutes: data.late_entry_cutoff_minutes,
    flexibleEntryManualOverride: data.flexible_entry_manual_override,
    startTime: data.start_time,
  };
}

async function loadSessionCounts(service: ServiceClient, sessionId: string): Promise<SessionCounts> {
  const { data } = await service.from('attendance_records').select('entry_type').eq('session_id', sessionId).eq('status', 'admitted');
  const rows = data ?? [];
  return {
    totalAdmitted: rows.length,
    admittedPriorityCount: rows.filter((r) => r.entry_type === 'priority').length,
    admittedFlexibleCount: rows.filter((r) => r.entry_type === 'flexible').length,
  };
}

export async function scanAttemptPreviewForCaller(
  params: { applicationId: string; sessionId: string },
  caller: { userId: string; service: ServiceClient }
) {
  const { service, userId } = caller;
  await verifyScannerScope(service, userId, params.sessionId);

  // The reads below are mutually independent (each depends only on
  // params.applicationId/params.sessionId, known upfront), except the
  // conflict-count query which needs timeSlotGroupKey first — so that one
  // is issued as its own follow-up read rather than joining this batch.
  // Preview is explicitly stale-tolerant (design spec: "the pre-check was
  // only a preview and can be stale by the time of confirmation"), so
  // parallelizing these introduces no new correctness risk; it only cuts
  // the sequential round-trip count that otherwise adds up on a
  // live-scanning UI's per-badge latency.
  const [session, sessionCounts, timeSlotGroupKey, hasThisSessionResult, isRecommendedCountResult] = await Promise.all([
    loadSessionForAdmission(service, params.sessionId),
    loadSessionCounts(service, params.sessionId),
    computeTimeSlotGroupKeyForSession(service, params.sessionId),
    service
      .from('attendance_records')
      .select('*', { count: 'exact', head: true })
      .eq('application_id', params.applicationId)
      .eq('session_id', params.sessionId)
      .eq('status', 'admitted'),
    service
      .from('allocation_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('application_id', params.applicationId)
      .eq('session_id', params.sessionId)
      .in('status', ['proposed', 'confirmed']),
  ]);
  const hasThisSession = hasThisSessionResult.count;
  const isRecommendedCount = isRecommendedCountResult.count;

  const { count: hasConflicting } = await service
    .from('attendance_records')
    .select('*', { count: 'exact', head: true })
    .eq('application_id', params.applicationId)
    .eq('time_slot_group_key', timeSlotGroupKey)
    .neq('session_id', params.sessionId)
    .eq('status', 'admitted');

  const decision = resolveAdmissionDecision({
    now: new Date(),
    session,
    isRecommended: (isRecommendedCount ?? 0) > 0,
    hasActiveAttendanceForThisSession: (hasThisSession ?? 0) > 0,
    hasActiveAttendanceForConflictingSession: (hasConflicting ?? 0) > 0,
    sessionCounts,
    isOverrideCaller: false,
  });

  const summary = await getScannerParticipantSummary(service, params.applicationId);
  return { decision, summary };
}

export async function scanAttemptConfirmForCaller(
  params: { applicationId: string; sessionId: string; deviceIdentifier: string | null },
  caller: { userId: string; service: ServiceClient }
) {
  const { service, userId } = caller;
  await verifyScannerScope(service, userId, params.sessionId);
  const timeSlotGroupKey = await computeTimeSlotGroupKeyForSession(service, params.sessionId);

  const { data, error } = await service.rpc('scan_attempt_transactional', {
    p_application_id: params.applicationId,
    p_session_id: params.sessionId,
    p_scanned_by: userId,
    // Supabase's generated RPC Args types don't mark this param nullable
    // even though the SQL function's own signature accepts null for it
    // (device_identifier has no `not null` in scan_attempts/the function
    // signature) — a known gap in the CLI's type generation for PL/pgSQL
    // parameters, not a real type error. Same pattern as
    // src/lib/schedule/run-stage-publication.ts.
    p_device_identifier: params.deviceIdentifier as string,
    p_time_slot_group_key: timeSlotGroupKey,
    p_is_override_caller: false,
    // The verifyScannerScope call above is a fast pre-check (fails fast,
    // before paying for the RPC's advisory-lock acquisition), but it and
    // the RPC are separate round-trips — a scanner's assignment can be
    // deactivated in between. Passing the caller's id here makes the RPC
    // re-verify scope itself, inside its own transaction, after its lock
    // is held, closing that window instead of trusting the pre-check alone.
    p_scanner_user_id: userId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function scanAttemptPreview(applicationId: string, sessionId: string) {
  const caller = await requireScannerDeviceCaller();
  return scanAttemptPreviewForCaller({ applicationId, sessionId }, caller);
}

export async function scanAttemptConfirm(applicationId: string, sessionId: string, deviceIdentifier: string | null) {
  const caller = await requireScannerDeviceCaller();
  return scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier }, caller);
}
