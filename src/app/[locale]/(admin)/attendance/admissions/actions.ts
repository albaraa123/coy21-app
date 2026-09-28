// src/app/[locale]/(admin)/attendance/admissions/actions.ts
//
// Thin 'use server' wrapper: requireProgramAttendanceStaffCaller() — this
// file's own real authorization gate, since the service-role client it
// hands back bypasses RLS entirely — plus a direct pass-through into the
// *ForCaller functions in admission-management.ts / admission-lookup.ts,
// which hold all the actual logic and are what live tests exercise
// directly (same split as attendance/scanners/actions.ts).
'use server';

import { requireProgramAttendanceStaffCaller } from '@/lib/program-attendance/server-helpers';
import { admitOverrideForCaller, correctAttendanceForCaller, transferAttendanceForCaller } from '@/lib/attendance/admission-management';
import {
  searchApplicationsForAdmissionForCaller,
  fetchAttendanceStateForApplicationForCaller,
  fetchAttendanceAuditLogForCaller,
} from '@/lib/attendance/admission-lookup';

export async function performAdmitOverride(params: { applicationId: string; sessionId: string; deviceIdentifier: string | null; reason: string }) {
  const caller = await requireProgramAttendanceStaffCaller();
  return admitOverrideForCaller(params, caller);
}

export async function performCorrectAttendance(params: { attendanceId: string; reason: string }) {
  const caller = await requireProgramAttendanceStaffCaller();
  return correctAttendanceForCaller(params, caller);
}

export async function performTransferAttendance(params: { attendanceId: string; newSessionId: string; reason: string }) {
  const caller = await requireProgramAttendanceStaffCaller();
  return transferAttendanceForCaller(params, caller);
}

export async function searchApplicationsForAdmission(term: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return searchApplicationsForAdmissionForCaller(caller, term);
}

export async function fetchAttendanceStateForApplication(applicationId: string) {
  const caller = await requireProgramAttendanceStaffCaller();
  return fetchAttendanceStateForApplicationForCaller(caller, applicationId);
}

export async function fetchAttendanceAuditLog(attendanceRecordIds: string[]) {
  const caller = await requireProgramAttendanceStaffCaller();
  return fetchAttendanceAuditLogForCaller(caller, attendanceRecordIds);
}

export type { ApplicationSearchResult, AttendanceStateRow, AuditLogRow } from '@/lib/attendance/admission-lookup';
