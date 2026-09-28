// src/lib/attendance/participant-summary.ts
//
// The ONLY function anywhere in the scan flow permitted to read
// participant-identifying data for scanner display. Deliberately an
// allow-list, not `select *` — see design spec's "Participant Summary
// Shown to the Operator" section. No photo field: no photo-approval
// mechanism exists anywhere in this codebase for participants (only
// `people`, the speakers/staff directory, has photo_path) — per the
// spec's Risks section, photos are omitted entirely in this phase rather
// than sourced from an unapproved place.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export interface ScannerParticipantSummary {
  fullName: string;
  country: string | null;
  nationality: string | null;
}

export async function getScannerParticipantSummary(service: ServiceClient, applicationId: string): Promise<ScannerParticipantSummary | null> {
  const { data, error } = await service
    .from('applications')
    .select('full_name, country, nationality')
    .eq('id', applicationId)
    .single();
  if (error || !data) return null;
  return { fullName: data.full_name ?? '', country: data.country, nationality: data.nationality };
}
