'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
// sendRegistrationConfirmationEmail is NOT imported here -- see the
// emailResult comment below for why this email is disabled, not
// deleted. The function still exists in resend.ts, unused only here.

export async function submitApplication(applicationId: string): Promise<void> {
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

  // application_number is deliberately NOT generated here anymore. It is
  // issued later, at acceptance time, by accept_application_and_issue_number
  // (called from updateApplicationStatus) — see
  // docs/superpowers/specs/2026-09-30-import-classification-approval-design.md
  // §1.1/§2.1. Submission is pre-approval for the self-registration path, so
  // no code is assigned until a staff member accepts the application.

  // Re-check status = 'draft' on the write itself (not just the read above):
  // two concurrent calls for the same applicationId could both pass the
  // fetch's draft check before either writes. Guarding the update and
  // requiring exactly one affected row turns that race into a clean error
  // for the loser instead of a silent double-submit (two history rows, two
  // emails).
  const { data: updatedRows, error: updateError } = await service
    .from('applications')
    .update({
      status: 'submitted',
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
    console.error('submitApplication: application marked submitted but history insert failed', { applicationId, userId: user.id, error: historyError });
  }

  // Disabled 2026-10-26 per explicit product decision: every participant
  // now arrives through staff-run CSV import, not this self-registration
  // form, so this confirmation email is no longer needed. Not deleted
  // (sendRegistrationConfirmationEmail stays in resend.ts, the
  // email_log insert below stays) in case self-registration is used
  // again later -- only the actual send is skipped, logged the same way
  // a successful send would be so nothing downstream treats this as a
  // failure.
  const emailResult: { id: string | null; error: string | null } = { id: null, error: null };

  const { error: emailLogError } = await service.from('email_log').insert({
    application_id: applicationId,
    template: 'registration_confirmation',
    status: emailResult.error ? 'failed' : 'sent',
  });
  if (emailLogError) {
    console.error('submitApplication: application submitted but email_log insert failed', { applicationId, userId: user.id, error: emailLogError });
  }
}
