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
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
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
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
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
