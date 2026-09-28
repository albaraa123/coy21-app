// src/lib/funding/funding-management.ts
//
// Read/search/update logic for applications.funding_type and
// applications.attendance_confirmation — both fields live on the same
// "Participant Status" page. Mirrors travel-info-management.ts's
// *ForCaller split exactly (real logic here, actions.ts is a thin
// 'use server' wrapper). Never touches application_travel_info or
// application_health_info.
//
// Two search functions exist because the page has two access levels (see
// src/lib/funding/server-helpers.ts): searchParticipantsForFundingForCaller
// returns both fields for full-access roles; searchParticipantsForCareForCaller
// returns attendance_confirmation ONLY (never funding_type) for
// participant_care_staff's read-only view.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { writeAuditLog } from '@/lib/agenda/server-helpers';
import { FUNDING_TYPE_VALUES, ATTENDANCE_CONFIRMATION_VALUES, type FundingType, type AttendanceConfirmation } from '@/lib/validation/funding-type';
import { buildIlikeOrFilter } from '@/lib/validation/postgrest-search';

type ServiceClient = SupabaseClient<Database>;
type Caller = { userId: string; service: ServiceClient };

export type ParticipantSearchResult = {
  id: string;
  application_number: string | null;
  status: string;
  full_name: string | null;
  email: string | null;
  funding_type: FundingType | null;
  attendance_confirmation: AttendanceConfirmation;
};

export type ParticipantCareSearchResult = {
  id: string;
  application_number: string | null;
  status: string;
  full_name: string | null;
  email: string | null;
  attendance_confirmation: AttendanceConfirmation;
};

function searchOrFilter(term: string): string | null {
  return buildIlikeOrFilter(term, ['application_number', 'full_name', 'imported_email']);
}

// Same search shape as searchParticipantsForTravelForCaller /
// searchParticipantsForCareForCaller: matches application_number,
// applications.full_name, applications.imported_email, and the joined
// profiles.full_name/email.
export async function searchParticipantsForFundingForCaller(caller: Caller, term: string): Promise<ParticipantSearchResult[]> {
  const { service } = caller;
  const orFilter = searchOrFilter(term);
  if (orFilter === null) return [];

  const { data, error } = await service
    .from('applications')
    .select('id, application_number, status, full_name, imported_email, funding_type, attendance_confirmation, profiles!applications_applicant_id_fkey(full_name, email)')
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
    funding_type: row.funding_type,
    attendance_confirmation: row.attendance_confirmation,
  }));
}

// participant_care_staff's read-only view — deliberately never selects
// funding_type, so a bug elsewhere in this page can't accidentally leak it
// to a caller with no funding_type authorization, even before the
// write-side role check would have blocked them.
export async function searchParticipantsForCareForCaller(caller: Caller, term: string): Promise<ParticipantCareSearchResult[]> {
  const { service } = caller;
  const orFilter = searchOrFilter(term);
  if (orFilter === null) return [];

  const { data, error } = await service
    .from('applications')
    .select('id, application_number, status, full_name, imported_email, attendance_confirmation, profiles!applications_applicant_id_fkey(full_name, email)')
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
    attendance_confirmation: row.attendance_confirmation,
  }));
}

export async function updateFundingTypeForCaller(caller: Caller, applicationId: string, fundingType: FundingType | null): Promise<{ id: string; funding_type: FundingType | null }> {
  const { service, userId } = caller;
  if (fundingType !== null && !(FUNDING_TYPE_VALUES as readonly string[]).includes(fundingType)) {
    throw new Error(`Invalid funding type "${fundingType}"`);
  }

  const { data: before } = await service.from('applications').select('funding_type').eq('id', applicationId).maybeSingle();
  if (!before) throw new Error('Application not found');

  const { data, error } = await service
    .from('applications')
    .update({ funding_type: fundingType })
    .eq('id', applicationId)
    .select('id, funding_type')
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'applications',
    entityId: applicationId,
    action: 'funding_type_update',
    actorId: userId,
    oldValues: before,
    newValues: data,
  });

  return data;
}

export async function updateAttendanceConfirmationForCaller(caller: Caller, applicationId: string, attendanceConfirmation: AttendanceConfirmation): Promise<{ id: string; attendance_confirmation: AttendanceConfirmation }> {
  const { service, userId } = caller;
  if (!(ATTENDANCE_CONFIRMATION_VALUES as readonly string[]).includes(attendanceConfirmation)) {
    throw new Error(`Invalid attendance confirmation "${attendanceConfirmation}"`);
  }

  const { data: before } = await service.from('applications').select('attendance_confirmation').eq('id', applicationId).maybeSingle();
  if (!before) throw new Error('Application not found');

  const { data, error } = await service
    .from('applications')
    .update({ attendance_confirmation: attendanceConfirmation })
    .eq('id', applicationId)
    .select('id, attendance_confirmation')
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'applications',
    entityId: applicationId,
    action: 'attendance_confirmation_update',
    actorId: userId,
    oldValues: before,
    newValues: data,
  });

  return data;
}

export type AttendanceConfirmationCounts = {
  confirmed: number;
  not_confirmed: number;
  declined: number;
};

// Powers the 3-number card above the participants list (confirmed / not
// confirmed / declined) — a real computed count, not a manually-tallied
// figure, per explicit user decision. Counts every non-draft application
// regardless of funding_type, since attendance headcount is independent of
// funding.
export async function fetchAttendanceConfirmationCountsForCaller(caller: Caller): Promise<AttendanceConfirmationCounts> {
  const { service } = caller;
  const counts: AttendanceConfirmationCounts = { confirmed: 0, not_confirmed: 0, declined: 0 };
  const { data, error } = await service.from('applications').select('attendance_confirmation').neq('status', 'draft');
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    if (row.attendance_confirmation in counts) counts[row.attendance_confirmation as AttendanceConfirmation]++;
  }
  return counts;
}
