// src/lib/participant-care/server-helpers.ts
//
// Mirrors src/lib/program-attendance/server-helpers.ts's
// requireProgramAttendanceStaffCaller exact shape, checking
// isParticipantCareStaffRole instead. New for Phase 8.2 — no equivalent
// existed for this role before this file.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isParticipantCareStaffRole } from '@/lib/validation/participant-care';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write made by callers of
// this helper. It is also the only client with UPDATE privilege on
// application_health_info at all: the `authenticated` Postgres role only has
// SELECT granted (see supabase/migrations/20260816130000_correct_travel_and_
// health_info_authenticated_select_grant.sql), so a plain session client
// would fail with a grant-denied error even for a correctly-authorized
// participant_care_staff caller. Every server action reachable by this role
// must call this before any service-role read/write, and must not contain
// an early return that skips it.
export async function requireParticipantCareStaffCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  // Single source of truth for this check is isParticipantCareStaffRole in
  // src/lib/validation/participant-care.ts — update that helper, not this
  // call site, if the allowed role set changes.
  if (!isParticipantCareStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}
