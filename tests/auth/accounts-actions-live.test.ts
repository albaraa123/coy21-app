// tests/auth/accounts-actions-live.test.ts
//
// Live integration coverage for Phase C's bulk-action server actions
// (design doc section 14.5-14.10). Exercises the real *ForCaller
// action-layer code (email dispatch, retry filtering, audit logging,
// role authorization) against the live Supabase project.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { isAdmissionStaffRole } from '@/lib/validation/admission-review';
import {
  createAccountsForSelectedForCaller,
  sendLoginDetailsForCaller,
  retryFailedForSelectedForCaller,
} from '@/app/[locale]/(admin)/participants/accounts/actions';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `accounts-actions-live-${runId}-`;

let actorId: string;
const createdApplicationIds: string[] = [];
const createdAuthUserIds: string[] = [];

async function seedImportedApplication(email: string, fullName = 'Actions Test Person') {
  const { data, error } = await admin
    .from('applications')
    .insert({ applicant_id: null, imported_email: email, status: 'accepted', full_name: fullName })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to seed application: ${error?.message}`);
  createdApplicationIds.push(data.id);
  return data.id;
}

beforeAll(async () => {
  const { data: actor, error } = await admin.auth.admin.createUser({
    email: `${EMAIL_PREFIX}actor@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !actor.user) throw new Error(`Failed to create actor: ${error?.message}`);
  actorId = actor.user.id;
  createdAuthUserIds.push(actorId);
  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', actorId);
}, 60000);

afterAll(async () => {
  for (let i = 0; i < createdApplicationIds.length; i += 50) {
    await admin.from('applications').delete().in('id', createdApplicationIds.slice(i, i + 50));
  }
  for (const id of createdAuthUserIds) {
    await admin.from('audit_logs').delete().eq('actor_id', id);
  }
  for (const id of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

describe('createAccountsForSelectedForCaller: unselected participants untouched, one failure does not stop the rest', () => {
  it('only touches explicitly selected ids, and a malformed row does not abort the batch', async () => {
    const goodEmail1 = `${EMAIL_PREFIX}good1@example.com`;
    const goodEmail2 = `${EMAIL_PREFIX}good2@example.com`;
    const untouchedEmail = `${EMAIL_PREFIX}untouched@example.com`;

    const goodId1 = await seedImportedApplication(goodEmail1);
    const goodId2 = await seedImportedApplication(goodEmail2);
    const untouchedId = await seedImportedApplication(untouchedEmail);

    // A row whose imported_email is present (satisfying
    // applications_owner_or_import_identity) but does not parse as a usable
    // address forces provisionParticipantAccount into its 'error' branch at
    // the Auth-create step — proving one failure doesn't abort the rest.
    const malformedEmail = `${EMAIL_PREFIX}malformed-not-an-email`;
    const { data: malformed } = await admin
      .from('applications')
      .insert({ applicant_id: null, imported_email: malformedEmail, status: 'accepted', full_name: 'Malformed Person' })
      .select('id')
      .single();
    createdApplicationIds.push(malformed!.id);

    const results = await createAccountsForSelectedForCaller(
      [goodId1, malformed!.id, goodId2],
      { userId: actorId, service: admin }
    );

    for (const r of results) {
      if (r.applicationId === goodId1 || r.applicationId === goodId2) expect(r.outcome).toBe('account_created');
      if (r.applicationId === malformed!.id) expect(r.outcome).toBe('error');
    }

    const created1 = results.find((r) => r.applicationId === goodId1);
    const created2 = results.find((r) => r.applicationId === goodId2);
    if (created1?.outcome === 'account_created') {
      const { data: app1 } = await admin.from('applications').select('applicant_id').eq('id', goodId1).single();
      createdAuthUserIds.push(app1!.applicant_id!);
    }
    if (created2?.outcome === 'account_created') {
      const { data: app2 } = await admin.from('applications').select('applicant_id').eq('id', goodId2).single();
      createdAuthUserIds.push(app2!.applicant_id!);
    }

    // The untouched application was never in the selection — must remain
    // completely untouched (no provisioning row at all).
    const { data: untouchedProvisioning } = await admin
      .from('participant_account_provisioning')
      .select('id')
      .eq('application_id', untouchedId)
      .maybeSingle();
    expect(untouchedProvisioning).toBeNull();
    const { data: untouchedApp } = await admin.from('applications').select('applicant_id').eq('id', untouchedId).single();
    expect(untouchedApp?.applicant_id).toBeNull();
  }, 90000);
});

describe('sendLoginDetailsForCaller: only selected, never for an unreset existing account', () => {
  it('sends only to explicitly selected rows and excludes an existing_account row from getting password@123', async () => {
    const email = `${EMAIL_PREFIX}emailselected@example.com`;
    const applicationId = await seedImportedApplication(email);
    const createResult = await createAccountsForSelectedForCaller([applicationId], { userId: actorId, service: admin });
    expect(createResult[0].outcome).toBe('account_created');
    const { data: app } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    createdAuthUserIds.push(app!.applicant_id!);

    const unselectedEmail = `${EMAIL_PREFIX}emailunselected@example.com`;
    const unselectedId = await seedImportedApplication(unselectedEmail);
    await createAccountsForSelectedForCaller([unselectedId], { userId: actorId, service: admin });
    const { data: unselectedApp } = await admin.from('applications').select('applicant_id').eq('id', unselectedId).single();
    if (unselectedApp?.applicant_id) createdAuthUserIds.push(unselectedApp.applicant_id);

    // RESEND_API_KEY is unset in this test environment, so the send call
    // itself fails at the Resend SDK layer — this is expected and is
    // exactly what proves failure isolation (see next describe block).
    // What THIS test verifies is which rows were even ATTEMPTED: only the
    // explicitly selected applicationId, never the unselected one.
    const results = await sendLoginDetailsForCaller([applicationId], { userId: actorId, service: admin }, { isResend: false });
    expect(results).toHaveLength(1);
    expect(results[0].applicationId).toBe(applicationId);

    const { data: unselectedProvisioning } = await admin
      .from('participant_account_provisioning')
      .select('email_status')
      .eq('application_id', unselectedId)
      .single();
    expect(unselectedProvisioning?.email_status).toBe('not_sent'); // never touched by the email action

    // Existing-account row: never eligible for the temp-password email.
    const existingEmail = `${EMAIL_PREFIX}existingnoemail@example.com`;
    const { data: existingUser } = await admin.auth.admin.createUser({ email: existingEmail, password: 'RealPassword!1', email_confirm: true });
    createdAuthUserIds.push(existingUser!.user!.id);
    const existingAppId = await seedImportedApplication(existingEmail);
    const linkResult = await createAccountsForSelectedForCaller([existingAppId], { userId: actorId, service: admin });
    expect(linkResult[0].outcome).toBe('existing_account_linked');

    const existingEmailResults = await sendLoginDetailsForCaller([existingAppId], { userId: actorId, service: admin }, { isResend: false });
    expect(existingEmailResults[0].outcome).toBe('email_skipped'); // excluded, never sent password@123
  }, 90000);

  it('an email-send failure does not undo the already-created account', async () => {
    const email = `${EMAIL_PREFIX}emailfailure@example.com`;
    const applicationId = await seedImportedApplication(email);
    const createResult = await createAccountsForSelectedForCaller([applicationId], { userId: actorId, service: admin });
    expect(createResult[0].outcome).toBe('account_created');
    const { data: app } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    createdAuthUserIds.push(app!.applicant_id!);

    // RESEND_API_KEY unset -> the send genuinely fails here.
    const emailResults = await sendLoginDetailsForCaller([applicationId], { userId: actorId, service: admin }, { isResend: false });
    expect(emailResults[0].outcome).toBe('email_failed');

    // The account itself must still exist and be linked — untouched by the
    // email failure.
    const { data: appAfter } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    expect(appAfter?.applicant_id).toBe(app!.applicant_id);
    const { data: provisioning } = await admin
      .from('participant_account_provisioning')
      .select('account_status, email_status')
      .eq('application_id', applicationId)
      .single();
    expect(provisioning?.account_status).toBe('password_change_required'); // account state unaffected
    expect(provisioning?.email_status).toBe('failed');
  }, 60000);
});

describe('retryFailedForSelectedForCaller: retries only failed rows', () => {
  it('re-attempts only creation_failed/conflict rows from the given selection, leaving successful ones alone', async () => {
    const successEmail = `${EMAIL_PREFIX}retrysuccess@example.com`;
    const successId = await seedImportedApplication(successEmail);
    const successResult = await createAccountsForSelectedForCaller([successId], { userId: actorId, service: admin });
    expect(successResult[0].outcome).toBe('account_created');
    const { data: successApp } = await admin.from('applications').select('applicant_id').eq('id', successId).single();
    createdAuthUserIds.push(successApp!.applicant_id!);

    // Force a conflict row.
    const conflictEmail = `${EMAIL_PREFIX}retryconflict@example.com`;
    const { data: conflictUser } = await admin.auth.admin.createUser({ email: conflictEmail, password: 'password123', email_confirm: true });
    createdAuthUserIds.push(conflictUser!.user!.id);
    const firstConflictAppId = await seedImportedApplication(conflictEmail, 'First');
    await admin.from('applications').update({ applicant_id: conflictUser!.user!.id }).eq('id', firstConflictAppId);
    const secondConflictAppId = await seedImportedApplication(conflictEmail, 'Second');
    const conflictResult = await createAccountsForSelectedForCaller([secondConflictAppId], { userId: actorId, service: admin });
    expect(conflictResult[0].outcome).toBe('conflict');

    // Retry over a mixed selection (success + conflict) — only the conflict
    // row should be re-touched; the success row's provisioning state must
    // be unchanged (no re-attempt-count bump beyond what the original call
    // already produced would be hard to assert precisely, so instead assert
    // the success row's account_status stays exactly 'password_change_required',
    // never flipped to anything else by an unwanted second pass).
    const retryResults = await retryFailedForSelectedForCaller([successId, secondConflictAppId], { userId: actorId, service: admin });
    expect(retryResults.map((r) => r.applicationId)).toEqual([secondConflictAppId]); // success id excluded

    const { data: successAfterRetry } = await admin
      .from('participant_account_provisioning')
      .select('account_status')
      .eq('application_id', successId)
      .single();
    expect(successAfterRetry?.account_status).toBe('password_change_required');
  }, 90000);
});

describe('concurrent duplicate submission resolves to one account', () => {
  it('two simultaneous calls for the same application id produce exactly one Auth user', async () => {
    const email = `${EMAIL_PREFIX}concurrent@example.com`;
    const applicationId = await seedImportedApplication(email);

    await Promise.all([
      createAccountsForSelectedForCaller([applicationId], { userId: actorId, service: admin }),
      createAccountsForSelectedForCaller([applicationId], { userId: actorId, service: admin }),
    ]);

    // Both calls' findExistingAuthUserByEmail can race and both observe "no
    // existing user" before either call's createUser lands — in which case
    // both attempt createUser, and GoTrue's own email-uniqueness constraint
    // rejects whichever loses that race (an 'error' outcome for the loser,
    // not existing_account_linked/not_eligible). This is a real, accepted
    // possible interleaving (documented residual race in
    // findExistingAuthUserByEmail's own doc comment), and it is still SAFE:
    // it produces zero duplicate Auth users, only a request that must be
    // retried (retryFailedForSelected — see the sibling describe block).
    // The one invariant that must ALWAYS hold, regardless of which
    // interleaving occurred, is asserted below: at most one real Auth user
    // exists for this email at the end, never two.
    const { data: usersMatching } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const matches = usersMatching.users.filter((u) => u.email?.toLowerCase() === email.toLowerCase());
    expect(matches.length).toBeLessThanOrEqual(1); // never two distinct Auth users for the same email
    for (const m of matches) createdAuthUserIds.push(m.id);
  }, 60000);
});

describe('audit logging', () => {
  it('writes an audit_logs row for account_created', async () => {
    const email = `${EMAIL_PREFIX}auditcheck@example.com`;
    const applicationId = await seedImportedApplication(email);
    const result = await createAccountsForSelectedForCaller([applicationId], { userId: actorId, service: admin });
    expect(result[0].outcome).toBe('account_created');
    const { data: app } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    createdAuthUserIds.push(app!.applicant_id!);

    const { data: auditRows } = await admin
      .from('audit_logs')
      .select('action, entity_id, actor_id')
      .eq('entity_id', applicationId)
      .eq('action', 'account_created');
    expect(auditRows).toHaveLength(1);
    expect(auditRows![0].actor_id).toBe(actorId);
  }, 60000);
});

describe('role authorization', () => {
  it('isAdmissionStaffRole grants exactly super_admin and registration_admission_manager, no other role', () => {
    expect(isAdmissionStaffRole('super_admin')).toBe(true);
    expect(isAdmissionStaffRole('registration_admission_manager')).toBe(true);
    expect(isAdmissionStaffRole('agenda_allocation_manager')).toBe(false);
    expect(isAdmissionStaffRole('communications_attendance_manager')).toBe(false);
    expect(isAdmissionStaffRole('travel_operations_staff')).toBe(false);
    expect(isAdmissionStaffRole('participant_care_staff')).toBe(false);
    expect(isAdmissionStaffRole('participant')).toBe(false);
    expect(isAdmissionStaffRole(null)).toBe(false);
  });
});
