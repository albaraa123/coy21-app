// src/lib/content/public-speakers.ts
//
// Phase 9.2 — read-only, server-only source for the public Speakers page.
// Uses the service-role client (bypasses RLS, which on `people` is
// staff-only — people_staff_all) with an EXPLICIT narrow field allowlist,
// same convention as getScannerParticipantSummary/getOwnDisplaySummary
// elsewhere in this codebase: never select('*'), never forward email/
// phone/linked_profile_id to a public caller. This was the explicit,
// approved alternative to adding a new RLS policy + anon Postgres grant on
// `people` — see the Phase 9.0 investigation and Phase 9.2 design
// decision (smallest, most contained public-data surface, not a new
// anon-grant precedent on a table that also holds staff PII for
// non-speaker people).
//
// A person appears here only if ALL THREE are true:
//   - people.is_public = true (staff-curated opt-in, defaults false)
//   - people.is_active = true (a deactivated person is never shown,
//     regardless of is_public)
//   - at least one session_people row with role = 'speaker' links them to
//     a session (people with only moderator/facilitator/etc. roles are
//     not "speakers" for this page's purpose)
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export type PublicSpeaker = {
  id: string;
  fullNameAr: string;
  fullNameEn: string;
  titleAr: string | null;
  titleEn: string | null;
  organizationAr: string | null;
  organizationEn: string | null;
  bioAr: string | null;
  bioEn: string | null;
  photoPath: string | null;
};

/**
 * Every public-eligible speaker, ordered by English full name. Returns an
 * empty array (never throws) if the query fails — the public page treats
 * that identically to "no speakers configured yet" rather than surfacing
 * an error to visitors, matching the stub page's prior EmptyState
 * behavior for the zero-data case.
 */
export async function getPublicSpeakers(service: ServiceClient): Promise<PublicSpeaker[]> {
  const { data, error } = await service
    .from('people')
    .select(
      'id, full_name_ar, full_name_en, title_ar, title_en, organization_ar, organization_en, bio_ar, bio_en, photo_path, session_people!inner(role)'
    )
    .eq('is_public', true)
    .eq('is_active', true)
    .eq('session_people.role', 'speaker')
    .order('full_name_en', { ascending: true });

  if (error) {
    console.error('getPublicSpeakers: query failed', { message: error.message });
    return [];
  }

  // The !inner join can return the same person once per matching
  // session_people row (a speaker of 3 sessions would otherwise appear 3
  // times) — de-duplicate by id, keeping the first (order-preserving)
  // occurrence.
  const seen = new Set<string>();
  const speakers: PublicSpeaker[] = [];
  for (const row of data ?? []) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    speakers.push({
      id: row.id,
      fullNameAr: row.full_name_ar,
      fullNameEn: row.full_name_en,
      titleAr: row.title_ar,
      titleEn: row.title_en,
      organizationAr: row.organization_ar,
      organizationEn: row.organization_en,
      bioAr: row.bio_ar,
      bioEn: row.bio_en,
      photoPath: row.photo_path,
    });
  }
  return speakers;
}
