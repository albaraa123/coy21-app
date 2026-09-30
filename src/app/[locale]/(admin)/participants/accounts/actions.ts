// src/app/[locale]/(admin)/participants/accounts/actions.ts
//
// Phase C (design doc section 14.5-14.8): admin-controlled account
// provisioning bulk actions. Every action takes an explicit
// applicationIds: string[] — never "all matching current filter" — so
// unselected participants are structurally impossible to touch from here.
'use server';

import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';
import { writeAuditLog } from '@/lib/agenda/server-helpers';
import { provisionParticipantAccount, resetToTemporaryPassword, APPROVED_TEMP_PASSWORD } from '@/lib/auth/provision-participant-account';
import { sendLoginDetailsEmail } from '@/lib/email/resend';
import { reclassifyApplication } from '@/lib/participants/reclassify';
import { CHUNK_SIZE } from '@/lib/validation/import';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export interface ProvisioningItemResult {
  applicationId: string;
  outcome: 'account_created' | 'existing_account_linked' | 'conflict' | 'not_eligible' | 'email_sent' | 'email_skipped' | 'email_failed' | 'password_reset' | 'error';
  errorMessage?: string;
}

// Bounded concurrency within each chunk, matching the import pipeline's
// established ROW_CONCURRENCY shape (confirm/actions.ts) — each item is
// fully independent and idempotent (see provisionParticipantAccount's own
// idempotency guarantee), so concurrent processing within a chunk is safe
// for the same reason the import chunk loop's concurrency is safe.
const ITEM_CONCURRENCY = 10;

async function processInChunks<T>(
  items: T[],
  handler: (item: T) => Promise<ProvisioningItemResult>
): Promise<ProvisioningItemResult[]> {
  const results: ProvisioningItemResult[] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    for (let j = 0; j < chunk.length; j += ITEM_CONCURRENCY) {
      const slice = chunk.slice(j, j + ITEM_CONCURRENCY);
      const sliceResults = await Promise.all(slice.map(handler));
      results.push(...sliceResults);
    }
  }
  return results;
}

// Exported *ForCaller variants throughout this file follow this codebase's
// established live-test pattern (confirm/actions.ts, rollback-action.ts,
// etc.): 'use server' functions reach next/headers' cookies() via
// requireAdmissionStaffCaller, which throws outside a real Next.js
// request — live tests call these variants with a service-role caller
// substituted directly instead. Every DB-touching line is still exercised.
export async function createAccountsForSelectedForCaller(
  applicationIds: string[],
  caller: { userId: string; service: ServiceClient }
): Promise<ProvisioningItemResult[]> {
  const { userId, service } = caller;
  return processInChunks(applicationIds, async (applicationId) => {
    const outcome = await provisionParticipantAccount(service, applicationId, userId);
    if (outcome.kind === 'account_created') {
      await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: 'account_created', actorId: userId });
      return { applicationId, outcome: 'account_created' };
    }
    if (outcome.kind === 'existing_account_linked') {
      await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: 'account_linked', actorId: userId });
      return { applicationId, outcome: 'existing_account_linked' };
    }
    if (outcome.kind === 'conflict') {
      await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: 'account_conflict', actorId: userId, metadata: { reason: outcome.reason } });
      return { applicationId, outcome: 'conflict', errorMessage: outcome.reason };
    }
    if (outcome.kind === 'not_eligible') {
      return { applicationId, outcome: 'not_eligible' };
    }
    await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: 'provisioning_failed', actorId: userId, metadata: { errorCode: outcome.errorCode } });
    return { applicationId, outcome: 'error', errorMessage: outcome.errorMessage };
  });
}

export async function createAccountsForSelected(applicationIds: string[]): Promise<ProvisioningItemResult[]> {
  const caller = await requireAdmissionStaffCaller();
  return createAccountsForSelectedForCaller(applicationIds, caller);
}

export async function sendLoginDetailsForCaller(
  applicationIds: string[],
  caller: { userId: string; service: ServiceClient },
  opts: { isResend: boolean }
): Promise<ProvisioningItemResult[]> {
  const { userId, service } = caller;
  return processInChunks(applicationIds, async (applicationId) => {
    const { data: row, error } = await service
      .from('participant_account_provisioning')
      .select('normalized_email, account_status, email_status, must_change_password, auth_user_id')
      .eq('application_id', applicationId)
      .maybeSingle();
    if (error || !row) {
      return { applicationId, outcome: 'email_skipped', errorMessage: 'No provisioning record found' };
    }

    // Eligibility (design doc section 14/15, §4): a valid linked Auth
    // account, still on the approved temporary password, with
    // must_change_password true. Design doc section 14.5/§8: never email
    // password@123 for an existing_account row whose real password was
    // never reset — that value would not actually let them log in and
    // would be actively misleading.
    if (!row.auth_user_id) {
      return { applicationId, outcome: 'email_skipped', errorMessage: 'No linked account' };
    }
    if (row.account_status !== 'account_created' && row.account_status !== 'password_change_required') {
      return { applicationId, outcome: 'email_skipped', errorMessage: 'Account is not using the temporary password — an explicit password-reset action is required first' };
    }
    if (!row.must_change_password) {
      return { applicationId, outcome: 'email_skipped', errorMessage: 'Account is not using the temporary password' };
    }

    // Avoid re-sending unless this is explicitly a resend action — the
    // create-and-send / send-login-details actions only ever touch rows
    // that haven't been sent yet (any status other than not_sent/failed
    // means a send was already attempted).
    if (!opts.isResend && (row.email_status === 'sent' || row.email_status === 'delivered')) {
      return { applicationId, outcome: 'email_skipped', errorMessage: 'Already sent' };
    }

    const { data: application } = await service.from('applications').select('full_name').eq('id', applicationId).maybeSingle();

    // Mark 'sending' before the API call so a crash mid-send (process
    // killed, network partition) leaves a visibly in-flight state rather
    // than a stale 'not_sent' that looks like nothing was ever attempted.
    await service
      .from('participant_account_provisioning')
      .update({ email_status: 'sending', last_send_attempt_at: new Date().toISOString(), updated_by: userId })
      .eq('application_id', applicationId);

    const { id: resendEmailId, error: sendError } = await sendLoginDetailsEmail({
      to: row.normalized_email,
      fullName: application?.full_name || row.normalized_email,
      temporaryPassword: APPROVED_TEMP_PASSWORD,
    });

    if (sendError) {
      await service
        .from('participant_account_provisioning')
        .update({ email_status: 'failed', last_error_code: 'email_send_failed', last_error_message: 'Failed to send the login-details email', updated_by: userId })
        .eq('application_id', applicationId);
      await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: 'provisioning_failed', actorId: userId, metadata: { stage: 'email' } });
      return { applicationId, outcome: 'email_failed', errorMessage: 'Failed to send email' };
    }

    const { data: current } = await service
      .from('participant_account_provisioning')
      .select('login_email_send_count')
      .eq('application_id', applicationId)
      .maybeSingle();
    await service
      .from('participant_account_provisioning')
      .update({
        email_status: 'sent',
        resend_email_id: resendEmailId,
        last_login_email_sent_at: new Date().toISOString(),
        login_email_send_count: (current?.login_email_send_count ?? 0) + 1,
        updated_by: userId,
      })
      .eq('application_id', applicationId);

    await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: opts.isResend ? 'login_email_resent' : 'login_email_sent', actorId: userId, metadata: { resendEmailId } });
    return { applicationId, outcome: 'email_sent' };
  });
}

export async function createAccountsAndSendLoginDetails(applicationIds: string[]): Promise<ProvisioningItemResult[]> {
  const caller = await requireAdmissionStaffCaller();
  const creationResults = await createAccountsForSelectedForCaller(applicationIds, caller);
  const eligibleForEmail = creationResults
    .filter((r) => r.outcome === 'account_created' || r.outcome === 'existing_account_linked')
    .map((r) => r.applicationId);
  // existing_account_linked rows are excluded from the email step here too
  // (sendLoginDetailsForCaller's own account_status check already filters
  // them, since a linked pre-existing account never transitions to
  // account_created/password_change_required) — filtering the id list
  // first just avoids the extra provisioning-row lookup for ids that will
  // always be skipped anyway.
  const emailResults = await sendLoginDetailsForCaller(
    eligibleForEmail.filter((id) => creationResults.find((r) => r.applicationId === id)?.outcome === 'account_created'),
    caller,
    { isResend: false }
  );
  const merged = new Map(creationResults.map((r) => [r.applicationId, r] as const));
  for (const emailResult of emailResults) merged.set(emailResult.applicationId, emailResult);
  return [...merged.values()];
}

export async function sendLoginDetailsForSelected(applicationIds: string[]): Promise<ProvisioningItemResult[]> {
  const caller = await requireAdmissionStaffCaller();
  return sendLoginDetailsForCaller(applicationIds, caller, { isResend: false });
}

export async function resendLoginDetails(applicationIds: string[]): Promise<ProvisioningItemResult[]> {
  const caller = await requireAdmissionStaffCaller();
  return sendLoginDetailsForCaller(applicationIds, caller, { isResend: true });
}

export async function retryFailedForSelectedForCaller(
  applicationIds: string[],
  caller: { userId: string; service: ServiceClient }
): Promise<ProvisioningItemResult[]> {
  const { service } = caller;

  // Server-side re-filter to only the actually-failed subset — satisfies
  // "retry failed only" without depending on the client having pre-filtered
  // correctly.
  const { data: rows } = await service
    .from('participant_account_provisioning')
    .select('application_id, account_status')
    .in('application_id', applicationIds)
    .in('account_status', ['creation_failed', 'conflict']);
  const failedIds = (rows ?? []).map((r) => r.application_id);

  return createAccountsForSelectedForCaller(failedIds, caller);
}

export async function retryFailedForSelected(applicationIds: string[]): Promise<ProvisioningItemResult[]> {
  const caller = await requireAdmissionStaffCaller();
  return retryFailedForSelectedForCaller(applicationIds, caller);
}

// Distinct from retryFailedForSelected (which re-attempts account
// creation): this re-attempts the EMAIL send specifically, for rows whose
// email_status is 'failed'. Not the same as resendLoginDetails, which
// forces a re-send even for an already-'sent' row — this only touches
// rows that never successfully sent, so no successful email is ever
// repeated by calling this.
export async function retryFailedEmailsForSelectedForCaller(
  applicationIds: string[],
  caller: { userId: string; service: ServiceClient }
): Promise<ProvisioningItemResult[]> {
  const { service } = caller;
  const { data: rows } = await service
    .from('participant_account_provisioning')
    .select('application_id')
    .in('application_id', applicationIds)
    .eq('email_status', 'failed');
  const failedIds = (rows ?? []).map((r) => r.application_id);

  return sendLoginDetailsForCaller(failedIds, caller, { isResend: false });
}

export async function retryFailedEmailsForSelected(applicationIds: string[]): Promise<ProvisioningItemResult[]> {
  const caller = await requireAdmissionStaffCaller();
  return retryFailedEmailsForSelectedForCaller(applicationIds, caller);
}

export async function resetSelectedToTemporaryPassword(applicationIds: string[]): Promise<ProvisioningItemResult[]> {
  const caller = await requireAdmissionStaffCaller();
  const { userId, service } = caller;
  return processInChunks(applicationIds, async (applicationId) => {
    const result = await resetToTemporaryPassword(service, applicationId, userId);
    if (result.success) {
      await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: 'password_reset', actorId: userId });
      return { applicationId, outcome: 'password_reset' };
    }
    await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: 'provisioning_failed', actorId: userId, metadata: { stage: 'password_reset' } });
    return { applicationId, outcome: 'error', errorMessage: result.errorMessage };
  });
}

export interface ClassificationChangeResult {
  applicationId: string;
  outcome: 'updated_only' | 'number_regenerated' | 'reissued' | 'error';
  errorMessage?: string;
}

// A separate, local chunking helper — deliberately NOT a reuse of
// processInChunks above. That function's handler return type is hardcoded
// to ProvisioningItemResult (a closed union that doesn't include the
// outcome values reclassifyApplication returns, e.g. 'number_regenerated'/
// 'reissued'), so forcing this action through it would not typecheck.
// Matches the same bounded-concurrency chunking SHAPE (CHUNK_SIZE outer /
// ITEM_CONCURRENCY inner), reusing both of those existing constants.
async function processClassificationChangesInChunks(
  applicationIds: string[],
  handler: (applicationId: string) => Promise<ClassificationChangeResult>
): Promise<ClassificationChangeResult[]> {
  const results: ClassificationChangeResult[] = [];
  for (let i = 0; i < applicationIds.length; i += CHUNK_SIZE) {
    const chunk = applicationIds.slice(i, i + CHUNK_SIZE);
    for (let j = 0; j < chunk.length; j += ITEM_CONCURRENCY) {
      const slice = chunk.slice(j, j + ITEM_CONCURRENCY);
      const sliceResults = await Promise.all(slice.map(handler));
      results.push(...sliceResults);
    }
  }
  return results;
}

export async function changeClassificationForSelectedForCaller(
  applicationIds: string[],
  newParticipantType: Database['public']['Enums']['participant_type'],
  caller: { userId: string; session: SupabaseClient<Database>; service: ServiceClient }
): Promise<ClassificationChangeResult[]> {
  return processClassificationChangesInChunks(applicationIds, async (applicationId) => {
    const result = await reclassifyApplication(caller.session, caller.service, {
      applicationId,
      newParticipantType,
      actorId: caller.userId,
    });
    return { applicationId: result.applicationId, outcome: result.outcome, errorMessage: result.errorMessage };
  });
}

export async function changeClassificationForSelected(
  applicationIds: string[],
  newParticipantType: Database['public']['Enums']['participant_type']
): Promise<ClassificationChangeResult[]> {
  const caller = await requireAdmissionStaffCaller();
  return changeClassificationForSelectedForCaller(applicationIds, newParticipantType, caller);
}
