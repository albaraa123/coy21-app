// src/lib/attendance/admission-management.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { requireProgramAttendanceStaffCaller } from '@/lib/program-attendance/server-helpers';
import { writeAuditLog } from '@/lib/agenda/server-helpers';
import { computeTimeSlotGroupKeyForSession } from './time-slot-lookup';

type ServiceClient = SupabaseClient<Database>;

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') throw new Error('A reason is required');
  return trimmed;
}

export async function admitOverrideForCaller(
  params: { applicationId: string; sessionId: string; deviceIdentifier: string | null; reason: string },
  caller: { userId: string; service: ServiceClient }
) {
  const { service, userId } = caller;
  const reason = requireReason(params.reason);
  const timeSlotGroupKey = await computeTimeSlotGroupKeyForSession(service, params.sessionId);

  // Unlike scanAttemptConfirmForCaller, this deliberately skips a
  // scanner_assignments scope check: requireProgramAttendanceStaffCaller is
  // the only gate, since a manager overriding admission is not limited to a
  // scanner's assigned room/session the way a scanner_device caller is.
  const { data, error } = await service.rpc('scan_attempt_transactional', {
    p_application_id: params.applicationId,
    p_session_id: params.sessionId,
    p_scanned_by: userId,
    // Supabase's generated RPC Args types don't mark this param nullable
    // even though the SQL function's own signature accepts null for it
    // (device_identifier has no `not null` in scan_attempts/the function
    // signature) — a known gap in the CLI's type generation for PL/pgSQL
    // parameters, not a real type error. Same pattern as
    // src/lib/attendance/scan-attempt.ts.
    p_device_identifier: params.deviceIdentifier as string,
    p_time_slot_group_key: timeSlotGroupKey,
    // This is the one call site in the whole system permitted to set this
    // flag true — it is never derived from caller input.
    p_is_override_caller: true,
  });
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'attendance_record',
    entityId: data.resulting_attendance_id ?? data.id,
    action: 'admission_override',
    actorId: userId,
    metadata: {
      applicationId: params.applicationId,
      sessionId: params.sessionId,
      reason,
      result: data.result,
    },
  });

  return data;
}

export async function correctAttendanceForCaller(
  params: { attendanceId: string; reason: string },
  caller: { userId: string; service: ServiceClient }
) {
  const { service, userId } = caller;
  const reason = requireReason(params.reason);

  const { data: before } = await service
    .from('attendance_records')
    .select('status, correction_reason')
    .eq('id', params.attendanceId)
    .single();

  const { data, error } = await service.rpc('correct_attendance_transactional', {
    p_attendance_id: params.attendanceId,
    p_corrected_by: userId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'attendance_record',
    entityId: data.id,
    action: 'admission_corrected',
    actorId: userId,
    oldValues: before ? { status: before.status, correctionReason: before.correction_reason } : null,
    newValues: { status: data.status, correctionReason: data.correction_reason },
    metadata: {
      applicationId: data.application_id,
      sessionId: data.session_id,
      reason,
    },
  });

  return data;
}

export async function transferAttendanceForCaller(
  params: { attendanceId: string; newSessionId: string; reason: string },
  caller: { userId: string; service: ServiceClient }
) {
  const { service, userId } = caller;
  const reason = requireReason(params.reason);
  const newTimeSlotGroupKey = await computeTimeSlotGroupKeyForSession(service, params.newSessionId);

  const { data: before } = await service
    .from('attendance_records')
    .select('session_id, entry_type')
    .eq('id', params.attendanceId)
    .single();

  const { data, error } = await service.rpc('transfer_attendance_transactional', {
    p_attendance_id: params.attendanceId,
    p_new_session_id: params.newSessionId,
    p_new_time_slot_group_key: newTimeSlotGroupKey,
    p_transferred_by: userId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'attendance_record',
    entityId: data.id,
    action: 'admission_transferred',
    actorId: userId,
    oldValues: before ? { sessionId: before.session_id, entryType: before.entry_type } : null,
    newValues: { sessionId: data.session_id, entryType: data.entry_type },
    metadata: {
      applicationId: data.application_id,
      previousAttendanceId: params.attendanceId,
      newSessionId: params.newSessionId,
      reason,
    },
  });

  return data;
}

export async function admitOverride(applicationId: string, sessionId: string, deviceIdentifier: string | null, reason: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return admitOverrideForCaller({ applicationId, sessionId, deviceIdentifier, reason }, caller);
}

export async function correctAttendance(attendanceId: string, reason: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return correctAttendanceForCaller({ attendanceId, reason }, caller);
}

export async function transferAttendance(attendanceId: string, newSessionId: string, reason: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return transferAttendanceForCaller({ attendanceId, newSessionId, reason }, caller);
}
