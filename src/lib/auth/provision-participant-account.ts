// src/lib/auth/provision-participant-account.ts
//
// Phase C core (design doc section 14.3): admin-controlled participant
// account provisioning. This is a DIFFERENT, separate path from the
// pre-existing per-user email-invite flow (src/lib/import/invitation.ts,
// claim_imported_application_transactional) — that flow is completely
// untouched by this module. This one uses a single shared approved
// temporary password instead of a per-user emailed magic link, and is
// always explicitly triggered by an admin selecting specific applications,
// never automatically from import.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { findExistingAuthUserByEmail } from './find-user-by-email';
import { normalizeEmail } from '@/lib/import/normalization';

type ServiceClient = SupabaseClient<Database>;
type ProvisioningAccountStatus = Database['public']['Enums']['provisioning_account_status'];

// The approved initial temporary password. A code-level constant only —
// NEVER written to any table, log line, or audit record. See design doc
// section 14.2: the admin table's displayed "password@123" text is always
// derived from account_status/must_change_password, never read back from
// storage.
export const APPROVED_TEMP_PASSWORD = 'password@123';

export type ProvisionOutcome =
  | { kind: 'not_eligible'; reason: 'already_claimed' }
  | { kind: 'account_created'; authUserId: string }
  | { kind: 'existing_account_linked'; authUserId: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'error'; errorCode: string; errorMessage: string };

async function upsertProvisioningRow(
  service: ServiceClient,
  applicationId: string,
  normalizedEmail: string,
  patch: {
    authUserId?: string | null;
    accountStatus: ProvisioningAccountStatus;
    mustChangePassword?: boolean;
    accountCreatedAt?: string | null;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
  },
  actorId: string
) {
  // Read the current attempt count first so it can be incremented in the
  // same upsert call — `upsert` has no "increment the existing value"
  // expression, so this is an explicit read-then-write rather than a
  // single atomic SQL increment. Acceptable here: provisioning is always
  // driven by one admin's bulk action processed as a bounded sequence (see
  // design doc section 14.8), never a high-concurrency hot path where a
  // lost increment would matter — worst case under a genuine race is an
  // undercounted (never overcounted-into-error) attempt tally, which is
  // purely informational and never gates any behavior.
  const { data: existing } = await service
    .from('participant_account_provisioning')
    .select('provisioning_attempt_count')
    .eq('application_id', applicationId)
    .maybeSingle();

  const { error } = await service.from('participant_account_provisioning').upsert(
    {
      application_id: applicationId,
      normalized_email: normalizedEmail,
      auth_user_id: patch.authUserId ?? null,
      account_status: patch.accountStatus,
      must_change_password: patch.mustChangePassword ?? false,
      account_created_at: patch.accountCreatedAt ?? null,
      last_error_code: patch.lastErrorCode ?? null,
      last_error_message: patch.lastErrorMessage ?? null,
      last_attempt_at: new Date().toISOString(),
      provisioning_attempt_count: (existing?.provisioning_attempt_count ?? 0) + 1,
      created_by: actorId,
      updated_by: actorId,
    },
    { onConflict: 'application_id' }
  );
  if (error) throw new Error(`Failed to record provisioning state: ${error.message}`);
}

/**
 * Creates or links a Supabase Auth account for one accepted-participant
 * application, per design doc section 14.3's decision tree. Idempotent:
 * calling this twice for the same applicationId after the first call
 * succeeded is a safe no-op (see section 14.3.1) — the function re-reads
 * applications.applicant_id itself rather than trusting any caller-side
 * cache, so this property holds even under concurrent/duplicate calls.
 *
 * Never touches an application whose applicant_id is already set — this is
 * the same "never overwrite a non-null applicant_id" guarantee
 * claim_imported_application_transactional enforces for the pre-existing
 * claim flow, reused here at the application-code layer since this path
 * runs under a service-role client (no RLS/RPC-level backstop applies the
 * way it does for the session-scoped claim RPC).
 */
export async function provisionParticipantAccount(
  service: ServiceClient,
  applicationId: string,
  actorId: string
): Promise<ProvisionOutcome> {
  const { data: application, error: appError } = await service
    .from('applications')
    .select('id, imported_email, applicant_id, full_name')
    .eq('id', applicationId)
    .single();
  if (appError || !application) {
    return { kind: 'error', errorCode: 'application_not_found', errorMessage: 'Application not found' };
  }

  if (application.applicant_id !== null) {
    return { kind: 'not_eligible', reason: 'already_claimed' };
  }

  if (!application.imported_email) {
    return { kind: 'error', errorCode: 'no_email', errorMessage: 'This application has no email to provision an account for' };
  }

  const normalizedEmail = normalizeEmail(application.imported_email);

  let existingUser;
  try {
    existingUser = await findExistingAuthUserByEmail(service, normalizedEmail);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to look up existing account';
    await upsertProvisioningRow(service, applicationId, normalizedEmail, { accountStatus: 'creation_failed', lastErrorCode: 'lookup_failed', lastErrorMessage: 'Could not check for an existing account' }, actorId);
    return { kind: 'error', errorCode: 'lookup_failed', errorMessage: message };
  }

  if (existingUser) {
    // Is this Auth user already linked to a DIFFERENT application? If so,
    // this is a conflict — never silently attach, never overwrite.
    const { data: linkedElsewhere } = await service
      .from('applications')
      .select('id')
      .eq('applicant_id', existingUser.id)
      .neq('id', applicationId)
      .maybeSingle();

    if (linkedElsewhere) {
      const message = 'This email is already linked to a different application';
      await upsertProvisioningRow(
        service,
        applicationId,
        normalizedEmail,
        { authUserId: existingUser.id, accountStatus: 'conflict', lastErrorCode: 'email_linked_elsewhere', lastErrorMessage: message },
        actorId
      );
      return { kind: 'conflict', reason: message };
    }

    // Safe to link: guarded on applicant_id still being null, closing the
    // same race window a second concurrent call could otherwise hit.
    const { error: linkError } = await service
      .from('applications')
      .update({ applicant_id: existingUser.id })
      .eq('id', applicationId)
      .is('applicant_id', null);
    if (linkError) {
      return { kind: 'error', errorCode: 'link_failed', errorMessage: 'Failed to link the existing account' };
    }

    await upsertProvisioningRow(
      service,
      applicationId,
      normalizedEmail,
      { authUserId: existingUser.id, accountStatus: 'existing_account', mustChangePassword: false },
      actorId
    );
    return { kind: 'existing_account_linked', authUserId: existingUser.id };
  }

  // No existing Auth user — create one with the approved temporary
  // password. email_confirm: true so the account can log in immediately
  // without a confirmation-email round trip (matches the design's explicit
  // "so they can log in" requirement).
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: normalizedEmail,
    password: APPROVED_TEMP_PASSWORD,
    email_confirm: true,
  });
  if (createError || !created.user) {
    const message = createError?.message ?? 'Failed to create account';
    await upsertProvisioningRow(service, applicationId, normalizedEmail, { accountStatus: 'creation_failed', lastErrorCode: 'create_failed', lastErrorMessage: 'Failed to create the account' }, actorId);
    return { kind: 'error', errorCode: 'create_failed', errorMessage: message };
  }

  const newUserId = created.user.id;

  const { error: linkError } = await service
    .from('applications')
    .update({ applicant_id: newUserId })
    .eq('id', applicationId)
    .is('applicant_id', null);
  if (linkError) {
    return { kind: 'error', errorCode: 'link_failed', errorMessage: 'Account created but failed to link to the application' };
  }

  // handle_new_user's trigger already inserted a profiles row for newUserId
  // (full_name defaults to '' since createUser is called with no
  // raw_user_meta_data). Update it with the application's real name and set
  // must_change_password — a plain UPDATE, not an upsert, since the row is
  // guaranteed to already exist by the trigger that fires synchronously on
  // auth.users insert.
  await service
    .from('profiles')
    .update({ full_name: application.full_name || normalizedEmail, must_change_password: true })
    .eq('id', newUserId);

  await upsertProvisioningRow(
    service,
    applicationId,
    normalizedEmail,
    { authUserId: newUserId, accountStatus: 'password_change_required', mustChangePassword: true, accountCreatedAt: new Date().toISOString() },
    actorId
  );

  return { kind: 'account_created', authUserId: newUserId };
}

/**
 * Resets an already-linked account's password back to the approved
 * temporary value. A SEPARATE, explicitly-invoked action — never called
 * from provisionParticipantAccount, and the only code path in this
 * codebase that changes an existing account's password (design doc
 * section 14.3.2, satisfying the explicit "resetting an existing account
 * password must be a separate explicit action" requirement).
 */
export async function resetToTemporaryPassword(
  service: ServiceClient,
  applicationId: string,
  actorId: string
): Promise<{ success: true } | { success: false; errorMessage: string }> {
  const { data: row, error: rowError } = await service
    .from('participant_account_provisioning')
    .select('auth_user_id, normalized_email')
    .eq('application_id', applicationId)
    .maybeSingle();
  if (rowError || !row || !row.auth_user_id) {
    return { success: false, errorMessage: 'No linked account exists for this application' };
  }

  const { error: updateError } = await service.auth.admin.updateUserById(row.auth_user_id, {
    password: APPROVED_TEMP_PASSWORD,
  });
  if (updateError) {
    return { success: false, errorMessage: 'Failed to reset the password' };
  }

  await service.from('profiles').update({ must_change_password: true }).eq('id', row.auth_user_id);
  await upsertProvisioningRow(
    service,
    applicationId,
    row.normalized_email,
    { authUserId: row.auth_user_id, accountStatus: 'password_change_required', mustChangePassword: true },
    actorId
  );

  return { success: true };
}

/**
 * Pure derivation of the admin table's temp-password-column display text
 * (design doc section 14.4) — a function of (account_status,
 * must_change_password) only, never a stored or retrieved password value.
 * Exported standalone so it's directly unit-testable without any live
 * dependency.
 */
export function temporaryPasswordDisplay(
  accountStatus: ProvisioningAccountStatus,
  mustChangePassword: boolean
): string {
  if (accountStatus === 'no_account') return 'No account';
  if (accountStatus === 'existing_account') return 'Existing password';
  if (mustChangePassword) return APPROVED_TEMP_PASSWORD;
  return 'Password changed';
}
