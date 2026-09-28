// tests/import/claim-live.test.ts
//
// Live integration coverage for Task 21 — the transactional application
// claim. Covers all 5 cases from the plan's Step 5.
//
// ============================================================================
// NO REAL EMAILS ARE SENT BY THIS SUITE.
// ============================================================================
// This suite NEVER calls inviteUserByEmail (or any other email-sending Auth
// Admin method). This project has no custom SMTP and its default 2-sends-per-
// hour quota is exhausted; per explicit instruction the quota must be waited
// out, not worked around, and no test may consume it.
//
// Instead, the exact end state Task 20's sendInvitation would have produced
// is constructed DIRECTLY:
//   * admin.auth.admin.createUser({ email, password, email_confirm: true })
//     — creates a real Auth user and sends NO email (unlike inviteUserByEmail).
//     Giving it a password up front also lets the test sign in as that user
//     with signInWithPassword, which is how it obtains the genuine
//     authenticated session the claim path requires.
//   * a participant_invitations row with status 'sent', invited_user_id set
//     to that Auth user, and sent_at populated — the same shape Task 20's
//     sendInvitation writes on success (verified against
//     src/lib/import/invitation.ts and tests/import/invitation-live.test.ts).
// The claim path itself is exercised for real and is completely unaffected by
// how the invited Auth user came to exist — the RPC only ever looks at
// participant_invitations.invited_user_id, never at how that user was created.
//
// This suite calls claimApplication with a REAL anon-key client signed in as
// the invited user, rather than the service-role *ForCaller substitution used
// by other live tests in this directory. That substitution is impossible here
// by design: the RPC is SECURITY DEFINER and asserts p_claiming_user_id =
// auth.uid(), which a service-role call (no JWT, no auth.uid()) can never
// satisfy. Passing the session client explicitly avoids next/headers' cookies(),
// which is unavailable outside a Next.js request.
//
// Runs against the live linked Supabase project (no local Postgres exists for
// this project), same as every other tests/import/*-live.test.ts. All created
// rows/users are removed in afterAll, and the suite is written to be safely
// re-runnable back-to-back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { claimApplication } from '@/app/[locale]/(participant)/(bare)/claim/actions';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PASSWORD = 'password123';
// Every application/Auth user this suite creates carries this prefix so
// cleanup can sweep by prefix even after a mid-test failure. @test.local
// matches the domain every other live test in this repo uses.
const EMAIL_PREFIX = 'claim-live-';
const EMAIL_DOMAIN = 'test.local';

const createdApplicationIds: string[] = [];
const createdAuthUserIds: string[] = [];

/** A fresh anon-key client, signed in as the given user. This is a genuine
 *  authenticated session with a real JWT — exactly what the SECURITY DEFINER
 *  RPC's auth.uid() assertion needs, and what the browser would hold after
 *  the invite-link token exchange. */
async function signInAs(email: string) {
  const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Failed to sign in as ${email}: ${error.message}`);
  return client;
}

/** Creates a real Auth user WITHOUT sending any email. See the header note. */
async function createInvitedAuthUser(email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Failed to create auth user: ${error?.message}`);
  createdAuthUserIds.push(data.user.id);
  return data.user.id;
}

/** Seeds an unclaimed imported application plus a 'sent' invitation for it —
 *  the exact state Task 20's sendInvitation leaves behind on success. */
async function seedImportedApplicationWithSentInvitation(email: string, invitedUserId: string) {
  const { data, error } = await admin
    .from('applications')
    .insert({ applicant_id: null, imported_email: email, status: 'accepted' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to seed application: ${error?.message}`);
  createdApplicationIds.push(data.id);

  const { error: invError } = await admin.from('participant_invitations').insert({
    application_id: data.id,
    imported_email: email,
    invited_user_id: invitedUserId,
    status: 'sent',
    sent_at: new Date().toISOString(),
  });
  if (invError) throw new Error(`Failed to seed invitation: ${invError.message}`);

  return data.id;
}

/** Seeds a non-sensitive answer so Case 4 has something whose readability
 *  can be asserted before vs. after the claim. */
async function seedAnswer(applicationId: string) {
  const { error } = await admin.from('application_answers').insert({
    application_id: applicationId,
    question_key: 'organization',
    normalized_value: 'Claim Test Org',
    raw_value: 'Claim Test Org',
    value_type: 'text',
    source: 'import',
    is_sensitive: false,
  });
  if (error) throw new Error(`Failed to seed answer: ${error.message}`);
}

/** Sweeps any leftovers from a previous aborted run, so the suite is
 *  re-runnable back-to-back even after a mid-test failure. */
async function sweepByPrefix() {
  const { data: apps } = await admin.from('applications').select('id').like('imported_email', `${EMAIL_PREFIX}%`);
  if (apps && apps.length > 0) {
    const ids = apps.map((a) => a.id);
    await admin.from('participant_invitations').delete().in('application_id', ids);
    await admin.from('audit_logs').delete().in('entity_id', ids);
    await admin.from('applications').delete().in('id', ids);
  }

  let page = 1;
  const perPage = 1000;
  const stragglers: string[] = [];
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) break;
    for (const u of data.users) {
      if (u.email?.toLowerCase().startsWith(EMAIL_PREFIX)) stragglers.push(u.id);
    }
    if (data.users.length < perPage) break;
    page += 1;
  }
  for (const id of stragglers) {
    // audit_logs.actor_id references profiles(id) with no `on delete` clause
    // (pre-existing gap found in Task 14) — the audit rows the claim RPC
    // writes for a claiming user MUST go before that user can be hard-deleted,
    // or deleteUser fails with an opaque 500.
    await admin.from('audit_logs').delete().eq('actor_id', id).then(() => undefined, () => undefined);
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}

beforeAll(async () => {
  await sweepByPrefix();
}, 300000);

afterAll(async () => {
  // Every step independently try/caught — a throw in one step must not skip
  // the rest (the exact failure mode that leaked orphaned data in Task 20).
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`afterAll cleanup step failed: ${label}`, err);
    }
  };

  await step('delete tracked applications', async () => {
    if (createdApplicationIds.length > 0) {
      await admin.from('participant_invitations').delete().in('application_id', createdApplicationIds);
      await admin.from('audit_logs').delete().in('entity_id', createdApplicationIds);
      await admin.from('applications').delete().in('id', createdApplicationIds);
    }
  });

  await step('delete tracked auth users', async () => {
    for (const id of createdAuthUserIds) {
      try {
        await admin.from('audit_logs').delete().eq('actor_id', id);
        const result = await admin.auth.admin.deleteUser(id);
        if (result.error) console.error('afterAll: auth user delete returned an error', id, result.error);
      } catch (err) {
        console.error('afterAll: auth user delete threw', id, err);
      }
    }
  });

  // Prefix sweep as a second line of defence for anything never tracked.
  await step('sweep by prefix', sweepByPrefix);
}, 300000);

describe('imported application claim (live)', () => {
  it('Case 1: happy path — invited user claims their imported application', async () => {
    const email = `${EMAIL_PREFIX}happy-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createInvitedAuthUser(email);
    const applicationId = await seedImportedApplicationWithSentInvitation(email, userId);

    const session = await signInAs(email);
    await claimApplication(applicationId, session);

    const { data: application } = await admin
      .from('applications')
      .select('applicant_id')
      .eq('id', applicationId)
      .single();
    expect(application?.applicant_id).toBe(userId);

    const { data: invitation } = await admin
      .from('participant_invitations')
      .select('status, accepted_at')
      .eq('application_id', applicationId)
      .single();
    expect(invitation?.status).toBe('accepted');
    expect(invitation?.accepted_at).toBeTruthy();

    // The RPC's in-transaction audit row.
    const { data: audits } = await admin
      .from('audit_logs')
      .select('action, actor_id, actor_type')
      .eq('entity_id', applicationId)
      .eq('action', 'invitation_claimed');
    expect(audits?.length).toBe(1);
    expect(audits?.[0].actor_id).toBe(userId);
  }, 120000);

  it('Case 2: replay — a second claim of the same application is rejected, state unchanged', async () => {
    const email = `${EMAIL_PREFIX}replay-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createInvitedAuthUser(email);
    const applicationId = await seedImportedApplicationWithSentInvitation(email, userId);

    const session = await signInAs(email);
    await claimApplication(applicationId, session);

    await expect(claimApplication(applicationId, session)).rejects.toThrow(
      /cannot be claimed by this account/i
    );

    const { data: application } = await admin
      .from('applications')
      .select('applicant_id')
      .eq('id', applicationId)
      .single();
    expect(application?.applicant_id).toBe(userId); // unchanged, still the first claimer

    const { data: invitation } = await admin
      .from('participant_invitations')
      .select('status')
      .eq('application_id', applicationId)
      .single();
    expect(invitation?.status).toBe('accepted');

    // The rejected replay must not have written a second audit row.
    const { data: audits } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_id', applicationId)
      .eq('action', 'invitation_claimed');
    expect(audits?.length).toBe(1);
  }, 120000);

  it('Case 3: wrong user — a different authenticated user cannot claim it', async () => {
    const email = `${EMAIL_PREFIX}victim-${Date.now()}@${EMAIL_DOMAIN}`;
    const attackerEmail = `${EMAIL_PREFIX}attacker-${Date.now()}@${EMAIL_DOMAIN}`;
    const invitedUserId = await createInvitedAuthUser(email);
    await createInvitedAuthUser(attackerEmail);
    const applicationId = await seedImportedApplicationWithSentInvitation(email, invitedUserId);

    const attackerSession = await signInAs(attackerEmail);
    await expect(claimApplication(applicationId, attackerSession)).rejects.toThrow(
      /cannot be claimed by this account/i
    );

    const { data: application } = await admin
      .from('applications')
      .select('applicant_id')
      .eq('id', applicationId)
      .single();
    expect(application?.applicant_id).toBeNull(); // no state change

    const { data: invitation } = await admin
      .from('participant_invitations')
      .select('status')
      .eq('application_id', applicationId)
      .single();
    expect(invitation?.status).toBe('sent'); // still claimable by the rightful user

    // And the rightful user can still claim it afterwards — the failed
    // attempt must not have poisoned the invitation.
    const victimSession = await signInAs(email);
    await claimApplication(applicationId, victimSession);
    const { data: after } = await admin
      .from('applications')
      .select('applicant_id')
      .eq('id', applicationId)
      .single();
    expect(after?.applicant_id).toBe(invitedUserId);
  }, 120000);

  it('Case 4: the imported data is unreadable via RLS before the claim and readable after', async () => {
    const email = `${EMAIL_PREFIX}rls-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createInvitedAuthUser(email);
    const applicationId = await seedImportedApplicationWithSentInvitation(email, userId);
    await seedAnswer(applicationId);

    // BEFORE the claim: the invited user is authenticated but owns nothing.
    // applications_select_own / application_answers_select_own both key on
    // applicant_id = auth.uid(), which is null here, so both must return
    // zero rows. This is design spec rule 1's core property: an Auth user
    // existing for an imported email conveys NO access whatsoever.
    const session = await signInAs(email);

    const { data: appBefore } = await session.from('applications').select('id').eq('id', applicationId);
    expect(appBefore ?? []).toHaveLength(0);

    const { data: answersBefore } = await session
      .from('application_answers')
      .select('id')
      .eq('application_id', applicationId);
    expect(answersBefore ?? []).toHaveLength(0);

    await claimApplication(applicationId, session);

    // AFTER the claim: the very same session, unchanged, can now read both.
    const { data: appAfter } = await session.from('applications').select('id').eq('id', applicationId);
    expect(appAfter ?? []).toHaveLength(1);

    const { data: answersAfter } = await session
      .from('application_answers')
      .select('id, question_key')
      .eq('application_id', applicationId);
    expect(answersAfter ?? []).toHaveLength(1);
    expect(answersAfter?.[0].question_key).toBe('organization');
  }, 120000);

  it('Case 5: a user who already claimed one application cannot claim a second', async () => {
    const email = `${EMAIL_PREFIX}double-${Date.now()}@${EMAIL_DOMAIN}`;
    const secondEmail = `${EMAIL_PREFIX}double2-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createInvitedAuthUser(email);

    const firstApplicationId = await seedImportedApplicationWithSentInvitation(email, userId);
    // A SECOND application whose invitation names the SAME Auth user, so the
    // ownership/status check passes and execution actually reaches the
    // applications_one_per_applicant unique-violation catch — which is the
    // whole point of this case.
    const secondApplicationId = await seedImportedApplicationWithSentInvitation(secondEmail, userId);

    const session = await signInAs(email);
    await claimApplication(firstApplicationId, session);

    // Must surface the specific, readable message from the RPC's
    // unique_violation handler — NOT a raw Postgres constraint-violation
    // error mentioning applications_one_per_applicant.
    await expect(claimApplication(secondApplicationId, session)).rejects.toThrow(
      /already claimed a different accepted-participant record/i
    );
    await expect(claimApplication(secondApplicationId, session)).rejects.not.toThrow(
      /applications_one_per_applicant|duplicate key value/i
    );

    const { data: second } = await admin
      .from('applications')
      .select('applicant_id')
      .eq('id', secondApplicationId)
      .single();
    expect(second?.applicant_id).toBeNull();

    const { data: secondInvitation } = await admin
      .from('participant_invitations')
      .select('status')
      .eq('application_id', secondApplicationId)
      .single();
    expect(secondInvitation?.status).toBe('sent');

    // The first claim is untouched by the failed second attempt.
    const { data: first } = await admin
      .from('applications')
      .select('applicant_id')
      .eq('id', firstApplicationId)
      .single();
    expect(first?.applicant_id).toBe(userId);
  }, 120000);
});
