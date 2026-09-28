'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { sendRegistrationConfirmationEmail } from '@/lib/email/resend';

export async function submitApplication(applicationId: string): Promise<{ applicationNumber: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();

  // Scoped to applicant_id + status = 'draft' so a caller can't submit someone
  // else's application or re-submit an already-submitted one.
  const { data: application, error: fetchError } = await service
    .from('applications')
    .select('*')
    .eq('id', applicationId)
    .eq('applicant_id', user.id)
    .eq('status', 'draft')
    .single();
  if (fetchError || !application) throw new Error('Application not found or not editable');

  // applications deliberately has no email/full_name columns (point-in-time
  // capture vs. account identity — see Data Model note in the spec), so the
  // confirmation email's recipient and display name come from profiles.
  const { data: profile, error: profileError } = await service
    .from('profiles')
    .select('full_name, email')
    .eq('id', user.id)
    .single();
  if (profileError || !profile) throw new Error('Profile not found');

  // Sequence values are never reused if a later step fails, so a burned
  // number just leaves a permanent, benign gap in the RCOY-2026-NNNNN
  // series — it can never collide with a number issued to another applicant.
  const { data: numberResult, error: numberError } = await service.rpc('next_application_number');
  if (numberError) throw numberError;
  const applicationNumber = numberResult as string;

  // Re-check status = 'draft' on the write itself (not just the read above):
  // two concurrent calls for the same applicationId could both pass the
  // fetch's draft check before either writes. Guarding the update and
  // requiring exactly one affected row turns that race into a clean error
  // for the loser instead of a silent double-submit (two history rows, two
  // emails, one overwritten application_number).
  const { data: updatedRows, error: updateError } = await service
    .from('applications')
    .update({
      status: 'submitted',
      application_number: applicationNumber,
      submitted_at: new Date().toISOString(),
    })
    .eq('id', applicationId)
    .eq('status', 'draft')
    .select('id');
  if (updateError) {
    console.error('submitApplication: failed to update application', { applicationId, userId: user.id, error: updateError });
    throw updateError;
  }
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error('Application was already submitted');
  }

  const { error: historyError } = await service.from('application_status_history').insert({
    application_id: applicationId,
    old_status: 'draft',
    new_status: 'submitted',
    changed_by: null,
    note: 'Applicant-initiated submission',
  });
  if (historyError) {
    console.error('submitApplication: application marked submitted but history insert failed', { applicationId, userId: user.id, applicationNumber, error: historyError });
  }

  const emailResult = await sendRegistrationConfirmationEmail({
    to: profile.email,
    fullName: profile.full_name,
    applicationNumber,
    locale: (application.preferred_language as 'ar' | 'en') ?? 'en',
  });

  const { error: emailLogError } = await service.from('email_log').insert({
    application_id: applicationId,
    template: 'registration_confirmation',
    status: emailResult.error ? 'failed' : 'sent',
  });
  if (emailLogError) {
    console.error('submitApplication: application submitted but email_log insert failed', { applicationId, userId: user.id, applicationNumber, error: emailLogError });
  }

  return { applicationNumber };
}
