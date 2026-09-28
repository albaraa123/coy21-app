'use server';

// src/app/[locale]/(participant)/(shell)/my-application/actions.ts
//
// Server actions for the participant's My Application page.
// Uses service_role (bypasses RLS) because:
//   - RLS only permits participants to UPDATE applications with status='draft'
//   - Attendance confirmation applies to accepted applications
// Authorization is enforced here: caller must own the application and the
// application must be in 'accepted' status before any update is performed.

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export type ConfirmationStatus = 'confirmed' | 'declined';

export async function updateAttendanceConfirmation(
  status: ConfirmationStatus
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const service = createServiceRoleClient();

  // Verify the caller owns an accepted application before updating.
  // The .eq('status', 'accepted') guard means a withdrawn or rejected
  // application can never have its confirmation changed via this action.
  const { data: app } = await service
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .eq('status', 'accepted')
    .maybeSingle();

  if (!app) return { error: 'No accepted application found for your account.' };

  const { error } = await service
    .from('applications')
    .update({ attendance_confirmation: status })
    .eq('id', app.id);

  if (error) return { error: error.message };
  return {};
}
