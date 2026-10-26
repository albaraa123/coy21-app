// src/lib/walk-in/server-helpers.ts
//
// Split out of requireAdmissionStaffCaller (src/lib/admission/server-helpers.ts)
// during the 2026-10-25 staff-narrowing work. requireAdmissionStaffCaller
// had 3 call sites with conflicting in/out-of-scope status: the real
// admission-REVIEW workflow (participants/accounts/actions.ts, now
// out of scope for staff) vs. the walk-in admission RPC call and its
// health probe (admit-walk-in/route.ts, admission-staff-health/route.ts
// -- the actual implementation of the ONE scanning capability this
// redesign keeps). Patching the shared helper to reject staff would have
// silently broken walk-in admission. This helper is identical in body to
// requireAdmissionStaffCaller as it existed before that patch -- still
// admits staff -- and is now the sole gate for the 2 walk-in routes.
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { UpstreamUnavailableError, isTransportShapedError } from '@/lib/supabase/upstream-error';
import type { Database } from '@/types/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export async function requireWalkInStaffCaller(): Promise<{ userId: string; session: SupabaseClient<Database>; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError && isAuthRetryableFetchError(userError)) {
    throw new UpstreamUnavailableError('auth.getUser() failed transiently');
  }
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error && isTransportShapedError(error)) {
    throw new UpstreamUnavailableError('profiles lookup failed transiently');
  }
  if (!profile) throw new Error('Profile not found');
  // Deliberately still admits `staff` -- this is the kept walk-in
  // capability. Do not add the `&& profile.role !== 'staff'` narrowing
  // here; that goes on requireAdmissionStaffCaller only (Step 4.6).
  if (!isStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, session: supabase, service };
}
