'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import {
  statusTransitionSchema,
  noteBodySchema,
  type ApplicationStatus,
} from '@/lib/validation/admission-review';
import { isStaffRole } from '@/lib/auth/is-staff-role';

// The service-role client bypasses RLS entirely, so this role check — not
// RLS — is the actual authorization gate for every write in this file. Every
// exported action must call this before any service-role read/write, and
// must not contain an early return that skips it.
async function requireStaffCaller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (error || !profile) throw new Error('Profile not found');
  // Single source of truth for this check is isStaffRole in
  // src/lib/auth/is-staff-role.ts (replaces isAdmissionStaffRole as of the
  // 2026-09-29 staff role consolidation), also used by page.tsx's
  // page-level gate and mirrored by
  // tests/server-actions/admission-review-authorization.test.ts — update
  // the helper, not this call site, if the allowed role set changes.
  if (!isStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}

// *ForCaller split follows this codebase's established live-test pattern
// (see participants/accounts/actions.ts's createAccountsForSelectedForCaller):
// requireStaffCaller() reaches next/headers' cookies() via createClient(),
// which throws outside a real Next.js request — live tests call this
// variant with a service-role caller substituted directly instead, while
// every DB-touching line is still exercised.
export async function updateApplicationStatusForCaller(
  applicationId: string,
  newStatus: ApplicationStatus,
  caller: { userId: string; service: ReturnType<typeof createServiceRoleClient> }
) {
  const { userId, service } = caller;

  const { data: application, error: fetchError } = await service
    .from('applications')
    .select('status')
    .eq('id', applicationId)
    .single();
  if (fetchError || !application) throw new Error('Application not found');

  const oldStatus = application.status as ApplicationStatus;
  const transitionCheck = statusTransitionSchema.safeParse({ from: oldStatus, to: newStatus });
  if (!transitionCheck.success) {
    throw new Error(`Cannot transition from ${oldStatus} to ${newStatus}`);
  }

  // Re-check the fetched status on the write itself and require exactly one
  // affected row — closes the read-then-write race between two staff members
  // concurrently transitioning the same application (same pattern as
  // submitApplication's draft->submitted guard).
  const { data: updatedRows, error: updateError } = await service
    .from('applications')
    .update({ status: newStatus })
    .eq('id', applicationId)
    .eq('status', oldStatus)
    .select('id');
  if (updateError) {
    console.error('updateApplicationStatus: failed to update application', { applicationId, userId, error: updateError });
    throw updateError;
  }
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error('Application status changed by someone else, please refresh');
  }

  // Issues application_number on acceptance for applications that don't
  // already have one (self-registration path — see
  // docs/superpowers/specs/2026-09-30-import-classification-approval-design.md
  // §2.1). Imported applications already have a number from insert time and
  // are left untouched by the function's coalesce(); a waitlisted/rejected
  // application re-entering accepted keeps its original number too.
  if (newStatus === 'accepted') {
    // accept_application_and_issue_number (supabase/migrations/20260930040000_
    // accept_application_and_issue_number.sql) is not yet present in the
    // generated Supabase types (src/types/database.ts is a snapshot that can
    // only be regenerated after this migration is applied to a live project) —
    // the `as never` cast on the function name is required until that
    // regeneration happens, matching this repo's established pattern for a
    // migration-defined RPC that predates the next types regeneration (see
    // tests/participants/speaker-linking-live.test.ts's identical note for
    // people.linked_application_id).
    const { error: numberError } = await service.rpc('accept_application_and_issue_number' as never, {
      p_application_id: applicationId,
    } as never);
    if (numberError) {
      console.error('updateApplicationStatus: failed to issue application_number', { applicationId, userId, error: numberError });
      throw numberError;
    }
  }

  const { error: historyError } = await service.from('application_status_history').insert({
    application_id: applicationId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: userId,
    note: 'Status changed by reviewer',
  });
  if (historyError) {
    console.error('updateApplicationStatus: status updated but history insert failed', { applicationId, userId, error: historyError });
  }

  return { status: newStatus };
}

export async function updateApplicationStatus(applicationId: string, newStatus: ApplicationStatus) {
  const caller = await requireStaffCaller();
  return updateApplicationStatusForCaller(applicationId, newStatus, caller);
}

export async function assignReviewer(applicationId: string, reviewerId: string | null) {
  const { service } = await requireStaffCaller();

  if (reviewerId !== null) {
    const { data: reviewerProfile, error: reviewerError } = await service
      .from('profiles')
      .select('role')
      .eq('id', reviewerId)
      .single();
    if (reviewerError || !reviewerProfile) throw new Error('Reviewer not found');
    if (!isStaffRole(reviewerProfile.role)) {
      throw new Error('Target user is not an authorized reviewer');
    }
  }

  const { data: updatedRows, error } = await service
    .from('applications')
    .update({ assigned_reviewer_id: reviewerId })
    .eq('id', applicationId)
    .select('id');
  if (error) {
    console.error('assignReviewer: failed to update assignment', { applicationId, reviewerId, error });
    throw error;
  }
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error('Application not found');
  }

  return { assignedReviewerId: reviewerId };
}

export async function addNote(applicationId: string, body: string) {
  const { userId, service } = await requireStaffCaller();

  const parsed = noteBodySchema.safeParse({ body });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid note');

  const { error } = await service.from('application_notes').insert({
    application_id: applicationId,
    author_id: userId,
    body: parsed.data.body,
  });
  if (error) {
    console.error('addNote: failed to insert note', { applicationId, userId, error });
    throw error;
  }

  return { success: true };
}
