// src/lib/participants/reclassify.ts
//
// Shared logic for all 3 classification-edit paths (spec §3.1 individual,
// §3.2 bulk, both funnel through here; §3.3 import-preview does NOT — it
// edits import_rows before apply_import_row_transactional ever runs, so
// there is no application/QR state to reconcile yet). See
// docs/superpowers/specs/2026-09-30-import-classification-approval-design.md
// §3.4 for the full 3-branch design this implements.
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { reissueStaffQrCredential } from '@/lib/attendance/qr-credential-issuance';
import { sendClassificationChangeNotificationEmail } from '@/lib/email/resend';

type ServiceClient = SupabaseClient<Database>;
type ParticipantType = Database['public']['Enums']['participant_type'];

export interface ReclassifyResult {
  applicationId: string;
  outcome: 'updated_only' | 'number_regenerated' | 'reissued' | 'error';
  newApplicationNumber?: string;
  errorMessage?: string;
}

// requester (the caller's own authenticated session client) is required
// only for the QR-reissue branch — reissueStaffQrCredential's reservation
// RPC is SECURITY DEFINER and asserts requester_id = auth.uid() internally,
// which only resolves over the caller's own session (see
// qr-credential-issuance.ts's module doc comment). Callers in Task 6's
// bulk-edit path that already have a *ForCaller-testable shape must thread
// this through the same way participants/accounts/actions.ts's existing
// bulk actions do.
export async function reclassifyApplication(
  requester: SupabaseClient<Database>,
  service: ServiceClient,
  params: { applicationId: string; newParticipantType: ParticipantType; actorId: string }
): Promise<ReclassifyResult> {
  const { applicationId, newParticipantType, actorId } = params;

  const { data: application, error: fetchError } = await service
    .from('applications')
    .select('status, applicant_id, full_name, profiles!applications_applicant_id_fkey(full_name, email)')
    .eq('id', applicationId)
    .single();
  if (fetchError || !application) {
    return { applicationId, outcome: 'error', errorMessage: fetchError?.message ?? 'Application not found' };
  }

  const { error: updateError } = await service
    .from('applications')
    .update({ participant_type: newParticipantType })
    .eq('id', applicationId);
  if (updateError) {
    return { applicationId, outcome: 'error', errorMessage: updateError.message };
  }

  if (application.status !== 'accepted') {
    return { applicationId, outcome: 'updated_only' };
  }

  const { data: activeCredential } = await service
    .from('qr_credentials')
    .select('id')
    .eq('application_id', applicationId)
    .eq('status', 'active')
    .maybeSingle();

  // regenerate_application_number (Task 3's migration), NOT
  // accept_application_and_issue_number — that function's coalesce() only
  // issues a number when one is absent, which would silently no-op here
  // since an accepted application always already has one. This call must
  // unconditionally replace it, per spec §3.4's "old code becomes invalid"
  // requirement.
  //
  // `as never` on the function name/args: regenerate_application_number
  // (supabase/migrations/20260930040000_accept_application_and_issue_number.sql)
  // is not yet reflected in the generated src/types/database.ts snapshot —
  // same established workaround as applications/[id]/actions.ts's own
  // accept_application_and_issue_number call.
  const { data: numberResult, error: numberError } = await service.rpc('regenerate_application_number' as never, {
    p_application_id: applicationId,
  } as never);
  if (numberError || !numberResult) {
    return { applicationId, outcome: 'error', errorMessage: numberError?.message ?? 'Failed to regenerate application_number' };
  }
  const newApplicationNumber = numberResult as unknown as string;

  if (!activeCredential) {
    return { applicationId, outcome: 'number_regenerated', newApplicationNumber };
  }

  const reissueOutcome = await reissueStaffQrCredential(requester, service, {
    requestKey: randomUUID(),
    applicationId,
    expectedCurrentCredentialId: activeCredential.id,
    reissueReasonCode: 'administrative_correction',
    reissueNote: `Classification changed to ${newParticipantType}`,
  });
  if (reissueOutcome.outcome !== 'reissued' && reissueOutcome.outcome !== 'already_finalized') {
    console.error('reclassifyApplication: unexpected reissue outcome', { applicationId, outcome: reissueOutcome.outcome });
  }

  if (application.applicant_id) {
    const profile = Array.isArray(application.profiles) ? application.profiles[0] : application.profiles;
    if (profile?.email && profile?.full_name) {
      const emailResult = await sendClassificationChangeNotificationEmail({
        to: profile.email,
        fullName: profile.full_name,
        newApplicationNumber,
        locale: 'en',
      });
      if (emailResult.error) {
        console.error('reclassifyApplication: notification email failed', { applicationId, error: emailResult.error });
      }
    }
  }

  return { applicationId, outcome: 'reissued', newApplicationNumber };
}
