// src/lib/import/invitation.ts
//
// Shared invitation orchestration logic, called both from a single-
// application server action (Task 20) and (per the plan) a future bulk
// action. Every write here happens through a service-role client, so the
// caller is fully responsible for having already run requireAgendaStaffCaller
// (or the equivalent test-only ForCaller substitution).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
// Phase C (design doc section 14.1/14.3): findExistingAuthUserByEmail moved
// to src/lib/auth/find-user-by-email.ts so the admin-controlled account-
// provisioning flow can reuse it instead of duplicating this exact
// pagination logic. Re-imported here — no behavior change to this file.
import { findExistingAuthUserByEmail } from '@/lib/auth/find-user-by-email';
// Task 9 (design doc): participant registration invitations go through
// Supabase Auth's own inviteUserByEmail, a channel this codebase does not
// control the email body of — it cannot be redirected/prefixed to the
// sandbox recipient like the other 5 send paths (Task 2). Per the approved
// design, invitations are blocked outright while sandbox mode is enabled,
// rather than partially routed.
import { fetchEmailSettings } from '@/lib/email/send-guarded';

type ServiceClient = SupabaseClient<Database>;

export async function sendInvitation(service: ServiceClient, applicationId: string, actorId: string) {
  // Guard runs before any DB write (including the participant_invitations
  // upsert below) so a blocked attempt leaves no trace and cannot race with
  // the orphaned-Auth-user concern documented on that upsert's error check.
  const settings = await fetchEmailSettings();
  if (settings.sandboxEnabled) {
    throw new Error('Invitations are disabled while sandbox mode is enabled.');
  }

  const { data: application, error: appError } = await service
    .from('applications')
    .select('id, imported_email, applicant_id')
    .eq('id', applicationId)
    .single();
  if (appError || !application) throw new Error('Application not found');
  if (application.applicant_id !== null) throw new Error('This application already has a claimed account');
  if (!application.imported_email) throw new Error('This application has no imported_email to invite');

  const { error: upsertError } = await service.from('participant_invitations').upsert(
    { application_id: applicationId, imported_email: application.imported_email, status: 'sending', sent_by: actorId },
    { onConflict: 'application_id' }
  );
  // Must not proceed to inviteUserByEmail on a failed upsert: doing so would
  // create a real Auth user with no participant_invitations row to record
  // it, since the later status update below matches on application_id and
  // would silently affect zero rows — an orphaned Auth account, invisible to
  // the UI and unrevocable (revokeInvitation requires the row to exist).
  if (upsertError) throw new Error(`Failed to record invitation: ${upsertError.message}`);

  // Check for an existing Auth user with this email — rule 1's "secure
  // verified linking flow" requirement: never blindly attach. See the
  // findExistingAuthUserByEmail doc comment above for why this paginates
  // instead of trusting a single unparameterized listUsers() call.
  //
  // TOCTOU note (code-quality review, Task 20): this check-then-invite
  // sequence is not atomic. Two concurrent sendInvitation calls for the SAME
  // application could both pass this check before either calls
  // inviteUserByEmail below. This cannot produce two different Auth users
  // for the same email — GoTrue itself enforces email uniqueness, so the
  // loser's call either returns the SAME user id (pending-invite idempotence)
  // or errors. The only residual effect is a status-write race: whichever
  // call's final .update() lands last wins, so the row could read 'failed'
  // even though a valid invited Auth user actually exists. Recoverable via
  // resend (which no longer depends on this check — see resendInvitation).
  // The UI's disabled-during-flight button covers the common double-click
  // case; this note covers the residual server-side race for two genuinely
  // concurrent requests.
  const existingUser = await findExistingAuthUserByEmail(service, application.imported_email);

  if (existingUser) {
    await service
      .from('participant_invitations')
      .update({ status: 'failed', last_error: 'email_already_registered' })
      .eq('application_id', applicationId);
    throw new Error('An account with this email already exists — use the "Link to existing account" action instead');
  }

  const { data: inviteResult, error: inviteError } = await service.auth.admin.inviteUserByEmail(application.imported_email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/claim`,
  });
  if (inviteError || !inviteResult.user) {
    await service
      .from('participant_invitations')
      .update({ status: 'failed', last_error: inviteError?.message ?? 'unknown error' })
      .eq('application_id', applicationId);
    throw new Error(`Failed to send invitation: ${inviteError?.message}`);
  }

  await service
    .from('participant_invitations')
    .update({
      invited_user_id: inviteResult.user.id,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
    .eq('application_id', applicationId);

  return { invitedUserId: inviteResult.user.id };
}

/**
 * resendInvitation subtlety (Task 20 investigation point 2).
 *
 * The plan's illustrative resendInvitation calls sendInvitation again,
 * calling it "idempotent re-invoke per design spec step 20". Checked whether
 * that framing actually holds given sendInvitation's own logic:
 *
 *   - sendInvitation always re-checks for an existing Auth user by email
 *     (see findExistingAuthUserByEmail above) BEFORE calling
 *     inviteUserByEmail. If the first send already created an Auth user for
 *     this email, that user now exists, so a resend's existing-user check
 *     finds it and resendInvitation would throw "An account with this email
 *     already exists" — which is wrong for a legitimate resend (the pending
 *     invitee hasn't claimed anything yet; the existing Auth user in this
 *     case IS this invitation's own user, not a collision).
 *   - Supabase's inviteUserByEmail itself: per the GoTrueAdminApi JSDoc and
 *     Supabase's Auth API behavior, calling admin.inviteUserByEmail again for
 *     an email that already has a *pending* (unconfirmed) invite does NOT
 *     create a second Auth user — the Auth server treats the existing
 *     uncorroborated user record as still-inviteable and resends the email,
 *     returning the SAME user id. So inviteUserByEmail is itself idempotent
 *     for the pending case. But sendInvitation's own pre-check short-circuits
 *     before ever reaching that call, throwing instead.
 *
 * Deviation from the plan: resendInvitation does NOT call sendInvitation.
 * Instead it re-issues inviteUserByEmail directly against the invitation's
 * already-known imported_email, skipping the existing-Auth-user collision
 * check (that check's entire purpose is to catch a DIFFERENT pre-existing
 * account at first-send time; on a resend, this invitation is itself the
 * reason an Auth user with this email exists, so re-running the check would
 * always misfire as a false positive against its own prior invite).
 */
export async function resendInvitation(service: ServiceClient, applicationId: string) {
  // Same guard as sendInvitation — see its comment above. Checked before any
  // read/write here too, so behavior is consistent regardless of which
  // function a caller reaches first.
  const settings = await fetchEmailSettings();
  if (settings.sandboxEnabled) {
    throw new Error('Invitations are disabled while sandbox mode is enabled.');
  }

  const { data: existing, error } = await service
    .from('participant_invitations')
    .select('status, resend_count, imported_email, invited_user_id')
    .eq('application_id', applicationId)
    .single();
  if (error || !existing) throw new Error('No invitation exists for this application yet — use sendInvitation first');
  if (existing.status === 'accepted') throw new Error('This invitation has already been claimed');
  if (existing.status === 'revoked') throw new Error('This invitation has been revoked — send a new invitation instead');
  // A row with no invited_user_id was never actually sent to a real invitee
  // this invitation owns — most concretely, a 'failed' row from sendInvitation's
  // own collision check, where imported_email belongs to a PRE-EXISTING,
  // unrelated Auth user. Resending in that state would email a third party
  // who was never meant to be invited by this application and record their
  // pre-existing account against this invitation, exactly the state the
  // collision check exists to prevent. invited_user_id is only ever set once
  // this invitation's own send succeeded, so its presence is the correct,
  // cheap invariant to gate on.
  if (!existing.invited_user_id) {
    throw new Error('This invitation was never successfully sent — use sendInvitation instead of resend');
  }

  const { data: inviteResult, error: inviteError } = await service.auth.admin.inviteUserByEmail(existing.imported_email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/claim`,
  });
  if (inviteError || !inviteResult.user) {
    await service
      .from('participant_invitations')
      .update({ status: 'failed', last_error: inviteError?.message ?? 'unknown error' })
      .eq('application_id', applicationId);
    throw new Error(`Failed to resend invitation: ${inviteError?.message}`);
  }

  await service
    .from('participant_invitations')
    .update({
      invited_user_id: inviteResult.user.id,
      status: 'sent',
      sent_at: new Date().toISOString(),
      resend_count: existing.resend_count + 1,
    })
    .eq('application_id', applicationId);

  return { invitedUserId: inviteResult.user.id };
}

export async function revokeInvitation(service: ServiceClient, applicationId: string) {
  const { data: invitation, error } = await service
    .from('participant_invitations')
    .select('status, invited_user_id')
    .eq('application_id', applicationId)
    .single();
  if (error || !invitation) throw new Error('No invitation exists for this application');
  if (invitation.status === 'accepted') throw new Error('Cannot revoke an already-claimed invitation');

  await service
    .from('participant_invitations')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('application_id', applicationId);
  // Only delete the underlying Auth user if it was never claimed — never
  // touches a claimed, actively-used account (design spec step 20). This
  // deletes the INVITED user's Auth record, never the staff actor who
  // called this action, so it cannot trigger the audit_logs.actor_id-no-on-delete
  // problem discovered in Task 14 for the STAFF actor path; see
  // participant_invitations_fk_fix.sql for how invited_user_id itself
  // survives this delete (`on delete set null`).
  if (invitation.invited_user_id) {
    const { error: deleteError } = await service.auth.admin.deleteUser(invitation.invited_user_id);
    if (deleteError) throw new Error(`Failed to delete invited Auth user: ${deleteError.message}`);
  }
  return { success: true };
}
