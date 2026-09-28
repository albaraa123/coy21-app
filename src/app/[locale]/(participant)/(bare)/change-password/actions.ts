// src/app/[locale]/(participant)/(bare)/change-password/actions.ts
'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

/**
 * Completes a first-login (or admin-reset) password change. The password
 * itself was already changed client-side via
 * `supabase.auth.updateUser({ password })` (same pattern as
 * claim/page.tsx's existing password form) BEFORE this action is called —
 * this action only clears the gate flags. It never reads, stores, or logs
 * the new password (design doc section 14.9: "the new password is never
 * read back, logged, or stored anywhere by this codebase" — this function
 * has no parameter for it at all, structurally enforcing that).
 */
export async function completePasswordChange(): Promise<{ success: true } | { success: false; errorMessage: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, errorMessage: 'Not authenticated' };
  }

  const service = createServiceRoleClient();
  const { error: profileError } = await service.from('profiles').update({ must_change_password: false }).eq('id', user.id);
  if (profileError) {
    return { success: false, errorMessage: 'Failed to update account state' };
  }

  // Best-effort mirror update on the provisioning row (design doc section
  // 14.2: the two must_change_password copies are kept in sync by always
  // being written together) — looked up by auth_user_id since this action
  // has no application_id, only the caller's own session.
  await service
    .from('participant_account_provisioning')
    .update({ must_change_password: false, account_status: 'active' })
    .eq('auth_user_id', user.id);

  return { success: true };
}
