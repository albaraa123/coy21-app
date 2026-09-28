// src/lib/attendance/admission-lookup.ts
//
// Read-only lookups backing the Admission Management Console (Phase 8.1).
// Split into *ForCaller functions taking a pre-resolved
// { userId, service } caller, same convention as
// scanner-assignment-management.ts and admission-management.ts — the real
// logic lives here and is what live tests exercise directly with a
// synthetic caller; src/app/.../attendance/admissions/actions.ts is a thin
// 'use server' wrapper that resolves the real caller via
// requireProgramAttendanceStaffCaller() and is not itself tested.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { buildIlikeOrFilter } from '@/lib/validation/postgrest-search';

type ServiceClient = SupabaseClient<Database>;
type Caller = { userId: string; service: ServiceClient };

export type ApplicationSearchResult = {
  id: string;
  application_number: string | null;
  status: string;
  full_name: string | null;
  email: string | null;
};

// Searches both self-registered applications (name/email live on the
// joined profiles row) and imported applications (full_name/imported_email
// live directly on applications — see
// supabase/migrations/20260731100000_phase_b_import_field_extensions.sql
// and 20260726100000_applications_import_columns.sql). A single free-text
// term is matched against application_number, applications.full_name,
// applications.imported_email, profiles.full_name, and profiles.email so
// staff can search by whichever identifier they have on hand, regardless
// of which pipeline created the application.
export async function searchApplicationsForAdmissionForCaller(caller: Caller, term: string): Promise<ApplicationSearchResult[]> {
  const { service } = caller;
  const orFilter = buildIlikeOrFilter(term, ['application_number', 'full_name', 'imported_email']);
  if (!orFilter) return [];

  const { data, error } = await service
    .from('applications')
    .select('id, application_number, status, full_name, imported_email, profiles!applications_applicant_id_fkey(full_name, email)')
    .or(orFilter)
    .order('application_number', { ascending: true })
    .limit(25);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    application_number: row.application_number,
    status: row.status,
    full_name: row.full_name ?? row.profiles?.full_name ?? null,
    email: row.imported_email ?? row.profiles?.email ?? null,
  }));
}

export type AttendanceStateRow = {
  id: string;
  session_id: string;
  status: string;
  entry_type: string;
  admitted_at: string;
  correction_reason: string | null;
  superseded_attendance_id: string | null;
  sessions: { id: string; title_ar: string; title_en: string } | null;
};

// Current attendance state for one application: every attendance_records
// row (not just active ones) so staff can see history — a
// transferred_out/corrected row is exactly what a correction/transfer
// leaves behind, and hiding it would make the console's "current state"
// view contradict the audit trail shown alongside it.
export async function fetchAttendanceStateForApplicationForCaller(caller: Caller, applicationId: string): Promise<AttendanceStateRow[]> {
  const { service } = caller;
  const { data, error } = await service
    .from('attendance_records')
    .select('id, session_id, status, entry_type, admitted_at, correction_reason, superseded_attendance_id, sessions(id, title_ar, title_en)')
    .eq('application_id', applicationId)
    .order('admitted_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export type AuditLogRow = {
  id: string;
  action: string;
  actor_id: string | null;
  metadata: unknown;
  created_at: string;
};

// Same query shape as participants/imports/[batchId]/batch-detail.tsx's
// existing audit-log read: filter audit_logs by entity_type + entity_id,
// newest first. Scoped here to entity_type='attendance_record' since
// admission-management.ts's writeAuditLog calls all use that entity type.
export async function fetchAttendanceAuditLogForCaller(caller: Caller, attendanceRecordIds: string[]): Promise<AuditLogRow[]> {
  const { service } = caller;
  if (attendanceRecordIds.length === 0) return [];
  const { data, error } = await service
    .from('audit_logs')
    .select('id, action, actor_id, metadata, created_at')
    .eq('entity_type', 'attendance_record')
    .in('entity_id', attendanceRecordIds)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}
