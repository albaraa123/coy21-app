// src/lib/admission/server-helpers.ts
//
// Phase C (design doc section 14.1/14.10): shared requireAdmissionStaffCaller,
// mirroring src/lib/agenda/server-helpers.ts's requireAgendaStaffCaller exact
// shape but checking isAdmissionStaffRole instead. Prior to this, every
// registration_admission_manager-gated action (applications/[id]/actions.ts)
// redefined an equivalent check locally rather than sharing one — this file
// is the first shared helper for that role, added here since Phase C's new
// actions live in their own directory with no natural "local" file to inline
// into.
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { UpstreamUnavailableError, isTransportShapedError } from '@/lib/supabase/upstream-error';
import type { Database } from '@/types/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write made by callers of
// this helper. Every exported Phase C server action must call this before
// any service-role read/write or Auth Admin/email operation, and must not
// contain an early return that skips it.
//
// `session` is the caller's own authenticated client — use it only when an
// RPC needs a real `auth.uid()` (e.g. issueStaffQrCredential/
// reissueStaffQrCredential's reservation step, which is SECURITY DEFINER
// and derives the caller from auth.uid() internally). For every ordinary
// privileged read/write, use `service`, not `session`.
export async function requireAdmissionStaffCaller(): Promise<{ userId: string; session: SupabaseClient<Database>; service: ServiceClient }> {
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
  // Use the SAME shared classification table as everywhere else in this
  // sub-project, not a narrower ad hoc check -- treating every non-
  // PGRST116 error code as transient and retryable forever would wrongly
  // make a genuine 42501 permission-denied (which this project has hit
  // for real before) retry forever instead of correctly surfacing it as a
  // real, non-retryable problem.
  if (error && isTransportShapedError(error)) {
    throw new UpstreamUnavailableError('profiles lookup failed transiently');
  }
  if (!profile) throw new Error('Profile not found');
  // Single source of truth for this check is isStaffRole
  // (src/lib/auth/is-staff-role.ts) — update that helper, not this call
  // site, if the allowed role set changes. This helper is exclusively used
  // by the /participants/accounts feature (never by /applications, which
  // has its own separate inline role check), so widening it here does not
  // affect application-review authorization.
  if (!isStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, session: supabase, service };
}
