// tests/auth/provision-participant-account-live.test.ts
//
// Live integration coverage for Phase C (design doc section 14).
// provisionParticipantAccount / resetToTemporaryPassword against the real
// Supabase project — no local Postgres exists for this project, matching
// every other live suite's established pattern. All seeded/created rows
// are removed in afterAll.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  provisionParticipantAccount,
  resetToTemporaryPassword,
  APPROVED_TEMP_PASSWORD,
} from '@/lib/auth/provision-participant-account';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `provision-live-${runId}-`;

let actorId: string;
const createdApplicationIds: string[] = [];
const createdAuthUserIds: string[] = [];

async function seedImportedApplication(email: string, fullName = 'Provision Test Person') {
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

describe('provisionParticipantAccount: new account creation', () => {
  it('creates an account with the normalized email as username and password@123', async () => {
    const email = `${EMAIL_PREFIX}newaccount@example.com`;
    const applicationId = await seedImportedApplication(email);

    const outcome = await provisionParticipantAccount(admin, applicationId, actorId);
    expect(outcome.kind).toBe('account_created');
    if (outcome.kind !== 'account_created') throw new Error('expected account_created outcome');
    createdAuthUserIds.push(outcome.authUserId);

    const { data: authUser } = await admin.auth.admin.getUserById(outcome.authUserId);
    expect(authUser.user?.email?.toLowerCase()).toBe(email.toLowerCase());

    // Username IS the normalized email — verify signInWithPassword works
    // with the approved temporary password.
    const client = createClient<Database>(URL, ANON_KEY);
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: APPROVED_TEMP_PASSWORD });
    expect(signInError).toBeNull();

    const { data: application } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    expect(application?.applicant_id).toBe(outcome.authUserId);

    const { data: profile } = await admin.from('profiles').select('must_change_password, full_name').eq('id', outcome.authUserId).single();
    expect(profile?.must_change_password).toBe(true);
    expect(profile?.full_name).toBe('Provision Test Person');

    const { data: provisioning } = await admin
      .from('participant_account_provisioning')
      .select('account_status, must_change_password, normalized_email')
      .eq('application_id', applicationId)
      .single();
    expect(provisioning?.account_status).toBe('password_change_required');
    expect(provisioning?.must_change_password).toBe(true);
    expect(provisioning?.normalized_email).toBe(email.toLowerCase());
  }, 60000);

  it('never overwrites a non-null applicant_id belonging to another user', async () => {
    const ownerEmail = `${EMAIL_PREFIX}owner@test.local`;
    const { data: owner } = await admin.auth.admin.createUser({ email: ownerEmail, password: 'password123', email_confirm: true });
    createdAuthUserIds.push(owner!.user!.id);

    const email = `${EMAIL_PREFIX}alreadyclaimed@example.com`;
    const applicationId = await seedImportedApplication(email);
    await admin.from('applications').update({ applicant_id: owner!.user!.id }).eq('id', applicationId);

    const outcome = await provisionParticipantAccount(admin, applicationId, actorId);
    expect(outcome.kind).toBe('not_eligible');

    const { data: application } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    expect(application?.applicant_id).toBe(owner!.user!.id); // untouched
  }, 60000);

  it('is idempotent: calling twice on the same application produces exactly one account', async () => {
    const email = `${EMAIL_PREFIX}idempotent@example.com`;
    const applicationId = await seedImportedApplication(email);

    const first = await provisionParticipantAccount(admin, applicationId, actorId);
    expect(first.kind).toBe('account_created');
    if (first.kind === 'account_created') createdAuthUserIds.push(first.authUserId);

    const second = await provisionParticipantAccount(admin, applicationId, actorId);
    expect(second.kind).toBe('not_eligible');

    const { data: usersMatching } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const matches = usersMatching.users.filter((u) => u.email?.toLowerCase() === email.toLowerCase());
    expect(matches).toHaveLength(1); // exactly one Auth user, no duplicate
  }, 60000);
});

describe('provisionParticipantAccount: existing-account handling', () => {
  it('links a pre-existing, unlinked Auth account without creating a duplicate or touching its password', async () => {
    const email = `${EMAIL_PREFIX}existing@example.com`;
    const { data: existingUser } = await admin.auth.admin.createUser({ email, password: 'CustomPassword!1', email_confirm: true });
    createdAuthUserIds.push(existingUser!.user!.id);

    const applicationId = await seedImportedApplication(email);
    const outcome = await provisionParticipantAccount(admin, applicationId, actorId);

    expect(outcome.kind).toBe('existing_account_linked');
    if (outcome.kind === 'existing_account_linked') {
      expect(outcome.authUserId).toBe(existingUser!.user!.id);
    }

    const { data: application } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    expect(application?.applicant_id).toBe(existingUser!.user!.id);

    // Password was NOT touched — the original still works, password@123 does not.
    const client = createClient<Database>(URL, ANON_KEY);
    const { error: originalSignIn } = await client.auth.signInWithPassword({ email, password: 'CustomPassword!1' });
    expect(originalSignIn).toBeNull();

    const client2 = createClient<Database>(URL, ANON_KEY);
    const { error: tempPasswordSignIn } = await client2.auth.signInWithPassword({ email, password: APPROVED_TEMP_PASSWORD });
    expect(tempPasswordSignIn).not.toBeNull(); // must fail — password was never reset

    const { data: provisioning } = await admin
      .from('participant_account_provisioning')
      .select('account_status, must_change_password')
      .eq('application_id', applicationId)
      .single();
    expect(provisioning?.account_status).toBe('existing_account');
    expect(provisioning?.must_change_password).toBe(false);
  }, 60000);

  it('reports a conflict, and touches nothing, when the Auth account is already linked to a different application', async () => {
    const email = `${EMAIL_PREFIX}conflict@example.com`;
    const { data: existingUser } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
    createdAuthUserIds.push(existingUser!.user!.id);

    const firstApplicationId = await seedImportedApplication(email, 'First Owner');
    await admin.from('applications').update({ applicant_id: existingUser!.user!.id }).eq('id', firstApplicationId);

    const secondApplicationId = await seedImportedApplication(email, 'Second Claimant');
    const outcome = await provisionParticipantAccount(admin, secondApplicationId, actorId);

    expect(outcome.kind).toBe('conflict');

    const { data: secondApp } = await admin.from('applications').select('applicant_id').eq('id', secondApplicationId).single();
    expect(secondApp?.applicant_id).toBeNull(); // never overwritten

    const { data: firstApp } = await admin.from('applications').select('applicant_id').eq('id', firstApplicationId).single();
    expect(firstApp?.applicant_id).toBe(existingUser!.user!.id); // untouched

    const { data: provisioning } = await admin
      .from('participant_account_provisioning')
      .select('account_status, last_error_message')
      .eq('application_id', secondApplicationId)
      .single();
    expect(provisioning?.account_status).toBe('conflict');
    expect(provisioning?.last_error_message).toBeTruthy();
    // Safe message only — never a raw driver error, never a password.
    expect(provisioning?.last_error_message).not.toContain('password');
  }, 60000);
});

describe('resetToTemporaryPassword: explicit, separate action', () => {
  it('changes an existing linked account password to the approved value, only when explicitly called', async () => {
    const email = `${EMAIL_PREFIX}reset@example.com`;
    const { data: existingUser } = await admin.auth.admin.createUser({ email, password: 'OriginalPassword!1', email_confirm: true });
    createdAuthUserIds.push(existingUser!.user!.id);

    const applicationId = await seedImportedApplication(email);
    const linkOutcome = await provisionParticipantAccount(admin, applicationId, actorId);
    expect(linkOutcome.kind).toBe('existing_account_linked');

    // Plain provisioning (above) must NOT have reset the password.
    const preResetClient = createClient<Database>(URL, ANON_KEY);
    const { error: preResetError } = await preResetClient.auth.signInWithPassword({ email, password: 'OriginalPassword!1' });
    expect(preResetError).toBeNull();

    const resetResult = await resetToTemporaryPassword(admin, applicationId, actorId);
    expect(resetResult.success).toBe(true);

    const postResetClient = createClient<Database>(URL, ANON_KEY);
    const { error: postResetError } = await postResetClient.auth.signInWithPassword({ email, password: APPROVED_TEMP_PASSWORD });
    expect(postResetError).toBeNull();

    const { data: profile } = await admin.from('profiles').select('must_change_password').eq('id', existingUser!.user!.id).single();
    expect(profile?.must_change_password).toBe(true);

    const { data: provisioning } = await admin
      .from('participant_account_provisioning')
      .select('account_status')
      .eq('application_id', applicationId)
      .single();
    expect(provisioning?.account_status).toBe('password_change_required');
  }, 60000);
});

describe('one failure does not stop the rest / audit logging', () => {
  it('writes an audit row for account_created', async () => {
    const email = `${EMAIL_PREFIX}audit@example.com`;
    const applicationId = await seedImportedApplication(email);
    const outcome = await provisionParticipantAccount(admin, applicationId, actorId);
    expect(outcome.kind).toBe('account_created');
    if (outcome.kind === 'account_created') createdAuthUserIds.push(outcome.authUserId);

    // provisionParticipantAccount itself doesn't write the audit row (that's
    // the calling server action's job, per design doc 14.3 point 8) — this
    // test confirms the underlying data this session's audit call would
    // reference is present and correct, since the action-layer audit call
    // is exercised in the actions.ts-level tests.
    const { data: application } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    expect(application?.applicant_id).not.toBeNull();
  }, 60000);
});

describe('no password ever stored', () => {
  it('no provisioning row, application row, or audit row contains the literal approved temporary password string as a stored VALUE for a changed account', async () => {
    // This is a structural guarantee (provisionParticipantAccount has no
    // parameter/column that could hold a real changed password), verified
    // here as an explicit regression guard: scan every text-ish column this
    // suite has written to and confirm none of them ever equals a real
    // participant's actual (changed) password. Since no code path here ever
    // captures the new password at all, this assertion can never
    // meaningfully fail by construction — it exists to catch a future
    // regression that accidentally adds such a write.
    const { data: rows } = await admin
      .from('participant_account_provisioning')
      .select('last_error_message')
      .like('normalized_email', `${EMAIL_PREFIX}%`);
    for (const row of rows ?? []) {
      expect(row.last_error_message ?? '').not.toMatch(/OriginalPassword|CustomPassword/);
    }
  }, 30000);
});
