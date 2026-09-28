// src/lib/travel-ops/server-helpers.ts
//
// Mirrors src/lib/participant-care/server-helpers.ts's
// requireParticipantCareStaffCaller exact shape, checking
// isTravelOpsStaffRole instead. New for Phase 8.6 — no equivalent existed
// for this role before this file.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isTravelOpsStaffRole } from '@/lib/validation/travel-ops';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write made by callers of
// this helper. It is also the only client with UPDATE privilege on
// application_travel_info at all: the `authenticated` Postgres role only
// has SELECT granted (see supabase/migrations/20260816130000_correct_
// travel_and_health_info_authenticated_select_grant.sql), so a plain
// session client would fail with a grant-denied error even for a
// correctly-authorized travel_operations_staff caller (same GRANT-layer
// shape already documented and tested for participant_care_staff in Phase
// 8.2 — see src/lib/participant-care/server-helpers.ts). Every server
// action reachable by this role must call this before any service-role
// read/write, and must not contain an early return that skips it.
export async function requireTravelOpsStaffCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  // Single source of truth for this check is isTravelOpsStaffRole in
  // src/lib/validation/travel-ops.ts — update that helper, not this call
  // site, if the allowed role set changes.
  if (!isTravelOpsStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}
