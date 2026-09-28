// src/lib/travel-ops/travel-info-management.ts
//
// Read/search/update logic for application_travel_info, backing the Phase
// 8.6 optional/lightweight Travel Operations screen. Split into
// *ForCaller functions taking a pre-resolved { userId, service } caller,
// same convention as health-info-management.ts/admission-lookup.ts — the
// real logic lives here and is what live tests exercise directly; the
// route's actions.ts is a thin 'use server' wrapper that resolves the real
// caller via requireTravelOpsStaffCaller() and is not itself tested.
//
// Deliberately never touches application_health_info or any other
// sensitive table — this module's only writes/reads are applications (for
// search/display) and application_travel_info (the one table this role's
// RLS policy grants access to).
//
// Scope, per Phase 8 explicit instructions: basic find/view/edit of
// CURRENTLY SUPPORTED travel fields only. No flight-management workflow,
// no visa workflow, no passport verification workflow, no Google
// Drive -> Supabase Storage migration (passport_copy_url/
// passport_photo_url continue to hold raw Drive URL text, rendered as a
// plain link — see docs/superpowers/specs/2026-07-30-controlled-account-
// provisioning-design.md section 13.8 for why that migration is
// explicitly out of scope), no notifications/coordination workflows.
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

// Identical search shape to admission-lookup.ts/health-info-management.ts
// — matches application_number, applications.full_name,
// applications.imported_email, and the joined profiles.full_name/email.
export async function searchParticipantsForTravelForCaller(caller: Caller, term: string): Promise<ParticipantSearchResult[]> {
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

export type TravelInfo = {
  application_id: string;
  support_level_requested: string | null;
  can_attend_without_full_support: boolean | null;
  departure_airport: string | null;
  visa_required: boolean | null;
  invitation_letter_required: boolean | null;
  passport_full_name: string | null;
  passport_full_name_ar: string | null;
  passport_issue_date: string | null;
  passport_expiry_date: string | null;
  passport_place_of_issue: string | null;
  passport_birth_date: string | null;
  passport_copy_url: string | null;
  passport_photo_url: string | null;
  updated_at: string;
};

// Returns null (not an error) when no row exists yet for this application
// — same reasoning as fetchHealthInfoForCaller: application_travel_info
// rows are only created by the import pipeline or a prior save here.
export async function fetchTravelInfoForCaller(caller: Caller, applicationId: string): Promise<TravelInfo | null> {
  const { service } = caller;
  const { data, error } = await service.from('application_travel_info').select('*').eq('application_id', applicationId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export type TravelInfoUpdateInput = {
  support_level_requested: string | null;
  can_attend_without_full_support: boolean | null;
  departure_airport: string | null;
  visa_required: boolean | null;
  invitation_letter_required: boolean | null;
  passport_full_name: string | null;
  passport_full_name_ar: string | null;
  passport_issue_date: string | null;
  passport_expiry_date: string | null;
  passport_place_of_issue: string | null;
  passport_birth_date: string | null;
};

// Upsert on application_id (the table's own primary key), same reasoning
// as updateHealthInfoForCaller. Deliberately does NOT accept
// passport_copy_url/passport_photo_url as writable fields here — editing
// those raw Drive-link strings is exactly the "passport/document
// verification workflow" the Phase 8 plan explicitly defers; this screen
// only DISPLAYS them (read-only, via fetchTravelInfoForCaller), never
// writes them.
export async function updateTravelInfoForCaller(caller: Caller, applicationId: string, input: TravelInfoUpdateInput): Promise<TravelInfo> {
  const { service, userId } = caller;
  const { data: before } = await service.from('application_travel_info').select('*').eq('application_id', applicationId).maybeSingle();

  const { data, error } = await service
    .from('application_travel_info')
    .upsert({ application_id: applicationId, ...input }, { onConflict: 'application_id' })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'application_travel_info',
    entityId: applicationId,
    action: 'travel_ops_update',
    actorId: userId,
    oldValues: before,
    newValues: data,
  });

  return data;
}
