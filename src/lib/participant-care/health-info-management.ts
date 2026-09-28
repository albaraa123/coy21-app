// src/lib/participant-care/health-info-management.ts
//
// Read/search/update logic for application_health_info, backing the Phase
// 8.2 Participant Care Staff Screen. Split into *ForCaller functions taking
// a pre-resolved { userId, service } caller, same convention as
// admission-lookup.ts/admission-management.ts/scanner-assignment-management.ts
// — the real logic lives here and is what live tests exercise directly with
// a synthetic caller; the route's actions.ts is a thin 'use server' wrapper
// that resolves the real caller via requireParticipantCareStaffCaller() and
// is not itself tested.
//
// Deliberately never touches application_travel_info or any other sensitive
// table — this module's only writes/reads are applications (for search/
// display) and application_health_info (the one table this role's RLS
// policy grants access to).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { writeAuditLog } from '@/lib/agenda/server-helpers';
import { buildIlikeOrFilter } from '@/lib/validation/postgrest-search';

type ServiceClient = SupabaseClient<Database>;
type Caller = { userId: string; service: ServiceClient };

export type ParticipantSearchResult = {
  id: string;
  application_number: string | null;
  status: string;
  full_name: string | null;
  email: string | null;
};

// Same search shape as admission-lookup.ts's
// searchApplicationsForAdmissionForCaller: matches application_number,
// applications.full_name, applications.imported_email (import pipeline) and
// the joined profiles.full_name/email (self-registration pipeline), so
// staff can search by whichever identifier they have regardless of which
// pipeline created the application.
export async function searchParticipantsForCareForCaller(caller: Caller, term: string): Promise<ParticipantSearchResult[]> {
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

export type HealthInfo = {
  application_id: string;
  allergies: string | null;
  medical_conditions: string | null;
  emergency_medication: string | null;
  accessibility_requirements: string | null;
  dietary_requirements: string | null;
  accommodation_preference: string | null;
  cultural_or_religious_requirements: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  consent_given: boolean | null;
  updated_at: string;
};

// Returns null (not an error) when no row exists yet for this application —
// application_health_info rows are only created by the import pipeline or a
// prior save here, so a freshly self-registered/accepted applicant may not
// have one, and that's a normal, displayable "no data yet" state rather
// than a failure.
export async function fetchHealthInfoForCaller(caller: Caller, applicationId: string): Promise<HealthInfo | null> {
  const { service } = caller;
  const { data, error } = await service.from('application_health_info').select('*').eq('application_id', applicationId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export type HealthInfoUpdateInput = {
  allergies: string | null;
  medical_conditions: string | null;
  emergency_medication: string | null;
  accessibility_requirements: string | null;
  dietary_requirements: string | null;
  accommodation_preference: string | null;
  cultural_or_religious_requirements: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  consent_given: boolean | null;
};

// Upsert on application_id (the table's own primary key — see
// supabase/migrations/20260730110000_application_travel_and_health_info_tables.sql)
// rather than a plain update, since a participant with no existing row yet
// (see fetchHealthInfoForCaller's doc comment) must still be editable by
// care staff on first contact, not blocked until an import creates the row.
export async function updateHealthInfoForCaller(caller: Caller, applicationId: string, input: HealthInfoUpdateInput): Promise<HealthInfo> {
  const { service, userId } = caller;
  const { data: before } = await service.from('application_health_info').select('*').eq('application_id', applicationId).maybeSingle();

  const { data, error } = await service
    .from('application_health_info')
    .upsert({ application_id: applicationId, ...input }, { onConflict: 'application_id' })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'application_health_info',
    entityId: applicationId,
    action: 'participant_care_update',
    actorId: userId,
    oldValues: before,
    newValues: data,
  });

  return data;
}
