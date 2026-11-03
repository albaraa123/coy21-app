'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

/**
 * Marks the signed-in participant as having completed the first-login
 * walkthrough. Same shape as change-password/actions.ts's
 * completePasswordChange(): server-side getUser() check, then a
 * service-role update of the one gate column (shell)/layout.tsx reads to
 * decide whether to redirect here in the first place.
 */
export async function completeOnboarding(): Promise<{ success: true } | { success: false; errorMessage: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, errorMessage: 'Not authenticated' };
  }

  const service = createServiceRoleClient();
  const { error } = await service.from('profiles').update({ has_completed_onboarding: true }).eq('id', user.id);
  if (error) {
    return { success: false, errorMessage: 'Failed to update account state' };
  }

  return { success: true };
}
