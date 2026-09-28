// src/lib/auth/provision-staff-account.ts
//
// Idempotent staff (non-participant) Auth account provisioning. Distinct
// from provision-participant-account.ts: staff accounts have no
// `applications` row to link, use a caller-supplied password rather than
// the fixed participant temporary password, and never set
// must_change_password (no staff role has ever used that gate — see
// docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md
// section 16's investigation note on this being staff-account behavior
// throughout this codebase, not something newly introduced here).
//
// Never logs or returns the plaintext password — callers must already have
// it in scope (e.g. from a constant at the call site) and are responsible
// for not logging it themselves either.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { findExistingAuthUserByEmail } from './find-user-by-email';

type ServiceClient = SupabaseClient<Database>;

export type ProvisionStaffAccountResult =
  | { outcome: 'created'; userId: string }
  | { outcome: 'already_exists_role_confirmed'; userId: string }
  | { outcome: 'already_exists_role_corrected'; userId: string; previousRole: string | null };

/**
 * Look up the Auth user by email first; create only when absent
 * (prevents duplicate Auth accounts — GoTrue itself also enforces email
 * uniqueness at the createUser layer as a second line of defense). If the
 * user already exists, the profile row's role is checked and corrected to
 * `role` if it drifted, rather than silently trusting whatever role is
 * already there — this function is the single source of truth for "this
 * email should have this role."
 */
export async function provisionStaffAccount(
  service: ServiceClient,
  params: { email: string; password: string; role: string; fullName: string }
): Promise<ProvisionStaffAccountResult> {
  const normalizedEmail = params.email.trim().toLowerCase();

  const existing = await findExistingAuthUserByEmail(service, normalizedEmail);
  if (existing) {
    const { data: profile } = await service.from('profiles').select('role').eq('id', existing.id).maybeSingle();
    if (profile?.role === params.role) {
      return { outcome: 'already_exists_role_confirmed', userId: existing.id };
    }
    const { error: updateError } = await service
      .from('profiles')
      .update({ role: params.role as Database['public']['Enums']['user_role'], full_name: params.fullName })
      .eq('id', existing.id);
    if (updateError) throw new Error(`Failed to correct role for existing user ${normalizedEmail}: ${updateError.message}`);
    return { outcome: 'already_exists_role_corrected', userId: existing.id, previousRole: profile?.role ?? null };
  }

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: normalizedEmail,
    password: params.password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(`Failed to create staff account ${normalizedEmail}: ${createError?.message ?? 'unknown error'}`);
  }

  // handle_new_user() trigger (20260721200747_roles_and_profiles.sql) creates
  // the initial profiles row with the enum's implicit default role; this
  // update sets the actual intended role and display name. must_change_password
  // is deliberately left at its column default (false) — no staff account
  // creation path in this codebase has ever set it (see design doc §16).
  const { error: roleError } = await service
    .from('profiles')
    .update({ role: params.role as Database['public']['Enums']['user_role'], full_name: params.fullName })
    .eq('id', created.user.id);
  if (roleError) throw new Error(`Account created but failed to set role for ${normalizedEmail}: ${roleError.message}`);

  return { outcome: 'created', userId: created.user.id };
}
