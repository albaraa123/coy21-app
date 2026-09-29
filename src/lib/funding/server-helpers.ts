// src/lib/funding/server-helpers.ts
//
// Mirrors src/lib/travel-ops/server-helpers.ts's requireTravelOpsStaffCaller
// exact shape. Two callers here for historical reasons: this page
// ("Participant Status") used to have two distinct access levels — full
// (program_attendance_manager / travel_operations_staff / super_admin —
// read+write both fields) and care-read-only (participant_care_staff —
// read attendance_confirmation only, never funding_type, never write).
//
// As of the 2026-09-29 staff role consolidation (see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md),
// that distinction no longer exists: isFundingTypeStaffRole and
// canReadAttendanceConfirmation both collapse to the same isStaffRole
// check (see src/lib/validation/funding-type.ts's own doc comment), so
// every account that can reach requireAttendanceConfirmationReadCaller
// below can equally reach requireFundingStaffCaller and write both
// fields. Kept as two separate functions purely for call-site clarity
// (read-intent vs. write-intent), not because they enforce different
// access levels anymore.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isFundingTypeStaffRole, canReadAttendanceConfirmation } from '@/lib/validation/funding-type';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

async function resolveCallerRole(): Promise<{ userId: string; service: ServiceClient; role: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');

  return { userId: user.id, service, role: profile.role };
}

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write made by callers of
// this helper. Every server action reachable by this role must call this
// before any service-role read/write, and must not contain an early return
// that skips it. Full access: may read/write funding_type AND
// attendance_confirmation.
export async function requireFundingStaffCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const { userId, service, role } = await resolveCallerRole();
  // Single source of truth for this check is isFundingTypeStaffRole in
  // src/lib/validation/funding-type.ts — update that helper, not this call
  // site, if the allowed role set changes.
  if (!isFundingTypeStaffRole(role)) {
    throw new Error('Not authorized');
  }
  return { userId, service };
}

// Read-intent helper: still used by every read-only view of
// attendance_confirmation, but as of the 2026-09-29 consolidation any
// caller satisfying this check also satisfies requireFundingStaffCaller
// above (both delegate to the same isStaffRole check) — see this file's
// header comment. Kept separate for call-site clarity, not as an actual
// read-only boundary.
export async function requireAttendanceConfirmationReadCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const { userId, service, role } = await resolveCallerRole();
  if (!canReadAttendanceConfirmation(role)) {
    throw new Error('Not authorized');
  }
  return { userId, service };
}
