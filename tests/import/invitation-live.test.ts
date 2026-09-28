// tests/import/invitation-live.test.ts
//
// Live integration coverage for Task 20 — invitation send/resend/revoke.
// Covers all 4 cases from the plan's Step 6.
//
// No local Postgres exists for this project — every test here runs against
// the live linked Supabase project, same pattern as
// tests/import/rollback-live.test.ts, whose fixture/cleanup patterns this
// file reuses. All seeded/created rows are removed in afterAll, and the
// suite is written to be safely re-runnable back-to-back.
//
// Calls the *ForCaller variants rather than the exported 'use server'
// actions: 'use server' functions call next/headers' cookies() via
// requireAgendaStaffCaller, which throws outside a real Next.js request —
// the same constraint documented throughout tests/import/*-live.test.ts.
// Every DB-touching line still runs; only the cookie-based auth wrapper is
// swapped for the service-role client.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  sendInvitationActionForCaller,
  resendInvitationActionForCaller,
  revokeInvitationActionForCaller,
} from '@/app/[locale]/(admin)/participants/[applicationId]/actions';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const STAFF_EMAIL = 'invitation-live-staff@test.local';
const PASSWORD = 'password123';
// Every application/Auth-user this suite creates carries this prefix, so
// cleanup can sweep by prefix even after a mid-test failure. Uses the
// @test.local domain (not @example.com) to match every other live test's
// Auth-user fixtures in this repo — confirmed live that Supabase Auth's
// inviteUserByEmail rejects @example.com outright as an invalid address
// (independent of, and prior to, the email-send-rate-limit constraint noted
// below), while @test.local is accepted.
const EMAIL_PREFIX = 'invitation-live-';
const EMAIL_DOMAIN = 'test.local';

// This project has no custom SMTP configured (confirmed live via the
// Supabase Management API: GET /v1/projects/{ref}/config/auth returns
// rate_limit_email_sent: 2, external_email_enabled: true, smtp_admin_email:
// null — i.e. the default built-in mailer, capped at 2 emails per PROJECT
// per HOUR). inviteUserByEmail is the only call in this codebase that sends
// a real email, so every case that calls it (Case 1, 3, 4 — Case 2 never
// reaches inviteUserByEmail because the existing-user check short-circuits
// first) competes for that 2/hour budget alongside any other live email
// send happening anywhere else against this same project in the same
// window (e.g. a concurrently running validation-live/rollback-live run, or
// a real staff member testing the feature by hand).
//
// This is a genuine external constraint, not a bug in the code under test:
// raising rate_limit_email_sent requires a PATCH to the project's live Auth
// config via the Management API, which is an infrastructure change outside
// this task's scope (and was correctly blocked when attempted here — this
// suite does not attempt to work around that block). Consequently this
// suite CANNOT be guaranteed to pass in a single fast run; the 3 sends may
// span more than one hourly window. withRateLimitRetry backs off long
// enough to survive a *tight* window boundary (a send that lands just
// before the hour rolls over) but cannot manufacture quota that doesn't
// exist — a full "0 quota left, next reset in 55 minutes" case will still
// fail this test run and require re-running later. Documented explicitly
// for whoever re-runs or reviews this suite (see Task 20's report).
async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delaysMs = [65000, 65000];
  let lastErr: unknown;
  try {
    return await fn();
  } catch (err) {
    lastErr = err;
  }
  for (const delay of delaysMs) {
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    if (!/rate limit/i.test(message)) throw lastErr;
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

let staffId: string;
const createdApplicationIds: string[] = [];
const createdAuthUserIds: string[] = [];

async function seedUnclaimedApplication(email: string) {
  const { data, error } = await admin
    .from('applications')
    .insert({ applicant_id: null, imported_email: email, status: 'accepted' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to seed application: ${error?.message}`);
  createdApplicationIds.push(data.id);
  return data.id;
}

beforeAll(async () => {
  // Sweep any stale STAFF_EMAIL user from a prior aborted run BEFORE
  // creating a fresh one. Code-quality review finding: if a previous run's
  // afterAll never reached the staff-delete step (e.g. it threw partway
  // through — see the per-step try/catch added below, which is the actual
  // fix, but this sweep is a second line of defense), createUser here would
  // fail with "email already registered", leave staffId undefined, and
  // every afterAll guard keyed on `if (staffId)` would then skip — silently
  // wedging every subsequent run of this suite indefinitely.
  {
    let page = 1;
    const perPage = 1000;
    for (;;) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) break;
      const stale = data.users.find((u) => u.email?.toLowerCase() === STAFF_EMAIL);
      if (stale) {
        try {
          await admin.from('audit_logs').delete().eq('actor_id', stale.id);
          await admin.auth.admin.deleteUser(stale.id);
        } catch {
          // best-effort — this is a defensive sweep, not the primary cleanup path
        }
        break;
      }
      if (data.users.length < perPage) break;
      page += 1;
    }
  }

  const { data: staff, error } = await admin.auth.admin.createUser({
    email: STAFF_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`Failed to create staff user: ${error.message}`);
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
}, 300000);

afterAll(async () => {
  // Every step below is independently try/caught. Code-quality review
  // finding: the original version let a thrown rejection from any one step
  // (observed in practice: the per-id deleteUser loop) abort the whole
  // afterAll body, skipping every step after it — including the prefix
  // sweeps that exist specifically to catch what per-id tracking missed.
  // Cleanup must be best-effort and exhaustive, not all-or-nothing.
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`afterAll cleanup step failed: ${label}`, err);
    }
  };

  // participant_invitations.application_id cascades from applications, and
  // application_answers / application_status_history also cascade — deleting
  // applications is sufficient, but participant_invitations is cleared
  // explicitly first so a failure there surfaces rather than being masked.
  await step('delete tracked applications', async () => {
    if (createdApplicationIds.length > 0) {
      await admin.from('participant_invitations').delete().in('application_id', createdApplicationIds);
      await admin.from('applications').delete().in('id', createdApplicationIds);
    }
  });

  // Sweep by email prefix too, in case a case failed before pushing its id.
  await step('sweep applications by email prefix', async () => {
    const { data: leftoverApps } = await admin.from('applications').select('id').like('imported_email', `${EMAIL_PREFIX}%`);
    if (leftoverApps && leftoverApps.length > 0) {
      const ids = leftoverApps.map((a) => a.id);
      await admin.from('participant_invitations').delete().in('application_id', ids);
      await admin.from('applications').delete().in('id', ids);
    }
  });

  // Any invited/pre-seeded Auth users this suite created directly. Each
  // delete is its own try/catch so one failure doesn't stop the rest of the
  // list from being attempted.
  await step('delete tracked auth users', async () => {
    for (const id of createdAuthUserIds) {
      try {
        const result = await admin.auth.admin.deleteUser(id);
        if (result.error) console.error('afterAll cleanup: invited-user delete returned an error', id, result.error);
      } catch (err) {
        console.error('afterAll cleanup: invited-user delete threw', id, err);
      }
    }
  });

  // Sweep any Auth users left over from a sendInvitation call whose id this
  // suite never captured (e.g. a failed assertion before the push, or the
  // rate-limit exhaustion this suite is known to hit), keyed by the same
  // email prefix. Paginates rather than trusting a single unparameterized
  // listUsers() call, mirroring the production fix in
  // src/lib/import/invitation.ts. Runs regardless of whether the tracked-id
  // delete step above succeeded, since it now runs in its own step().
  await step('sweep auth users by email prefix', async () => {
    let page = 1;
    const perPage = 1000;
    const stragglers: string[] = [];
    for (;;) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) break;
      for (const u of data.users) {
        if (u.email?.toLowerCase().startsWith(EMAIL_PREFIX) && u.id !== staffId) stragglers.push(u.id);
      }
      if (data.users.length < perPage) break;
      page += 1;
    }
    for (const id of stragglers) {
      await admin.auth.admin.deleteUser(id).catch(() => undefined);
    }
  });

  // audit_logs.actor_id references profiles(id) with NO `on delete` clause
  // (pre-existing Phase 5 gap discovered in Task 14). This suite writes
  // audit rows for staffId via writeAuditLog inside the *ActionForCaller
  // wrappers, and the auth-user hard-delete below fails with an opaque 500
  // if they still exist.
  await step('delete staff audit_logs', async () => {
    if (staffId) {
      await admin.from('audit_logs').delete().eq('actor_id', staffId);
    }
  });

  // deleteUser's second argument is shouldSoftDelete (default false) — the
  // SDK already hard-deletes with no second argument. Do not add one.
  await step('delete staff user', async () => {
    if (staffId) {
      const result = await admin.auth.admin.deleteUser(staffId);
      if (result.error) console.error('afterAll cleanup: staff delete returned an error', result.error);
    }
  });
}, 300000);

describe('invitation send/resend/revoke (live)', () => {
  it('Case 1: sends an invitation to a fresh imported application with no existing Auth user', async () => {
    const email = `${EMAIL_PREFIX}fresh-${Date.now()}@${EMAIL_DOMAIN}`;
    const applicationId = await seedUnclaimedApplication(email);

    const result = await withRateLimitRetry(() => sendInvitationActionForCaller(applicationId, { userId: staffId, service: admin }));
    // Tracked immediately on return, before any assertion — code-quality
    // review finding: a real Auth user already exists at this point
    // regardless of what any later expect() does, so a failing assertion
    // below must not be able to leave it untracked. The afterAll prefix
    // sweep is a second line of defense, not the only one.
    createdAuthUserIds.push(result.invitedUserId);
    expect(result.invitedUserId).toBeTruthy();

    const { data: invitation } = await admin
      .from('participant_invitations')
      .select('status, invited_user_id, sent_at')
      .eq('application_id', applicationId)
      .single();
    expect(invitation?.status).toBe('sent');
    expect(invitation?.invited_user_id).toBe(result.invitedUserId);
    expect(invitation?.sent_at).toBeTruthy();

    // Rule 1: invite creation is NOT a claim — applicant_id must still be
    // null even though an Auth user now exists for this email.
    const { data: appAfter } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    expect(appAfter?.applicant_id).toBeNull();

    // Resend coverage folded into Case 1 rather than a separate case, to
    // keep this suite's total real inviteUserByEmail calls as low as
    // possible against the project's 2/hour email-send quota (see
    // withRateLimitRetry's comment above). Pins the Task 20 investigation-2
    // deviation from the plan: resendInvitation must NOT re-run
    // sendInvitation's existing-Auth-user collision check against the
    // invitation's OWN just-created user (which would always misfire), and
    // must increment resend_count and keep status 'sent'.
    const resendResult = await withRateLimitRetry(() =>
      resendInvitationActionForCaller(applicationId, { userId: staffId, service: admin })
    );
    expect(resendResult.invitedUserId).toBe(result.invitedUserId); // same Auth user, not a second one

    const { data: afterResend } = await admin
      .from('participant_invitations')
      .select('status, resend_count, invited_user_id')
      .eq('application_id', applicationId)
      .single();
    expect(afterResend?.status).toBe('sent');
    expect(afterResend?.resend_count).toBe(1);
    expect(afterResend?.invited_user_id).toBe(result.invitedUserId);
  }, 300000);

  it('Case 2: rejects sending an invitation when an Auth user with that email already exists', async () => {
    const email = `${EMAIL_PREFIX}collision-${Date.now()}@${EMAIL_DOMAIN}`;
    const applicationId = await seedUnclaimedApplication(email);

    // Seed a pre-existing Auth user with this exact email BEFORE inviting —
    // simulates a participant who already has an account (e.g. self-
    // registered previously) under the same address as an imported row.
    const { data: existingAuthUser, error: seedAuthError } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (seedAuthError || !existingAuthUser.user) throw new Error(`Failed to seed colliding Auth user: ${seedAuthError?.message}`);
    createdAuthUserIds.push(existingAuthUser.user.id);

    await expect(sendInvitationActionForCaller(applicationId, { userId: staffId, service: admin })).rejects.toThrow(
      /already exists/i
    );

    // The resulting state is correctly 'failed', not silently linked.
    const { data: invitation } = await admin
      .from('participant_invitations')
      .select('status, last_error, invited_user_id')
      .eq('application_id', applicationId)
      .single();
    expect(invitation?.status).toBe('failed');
    expect(invitation?.last_error).toBe('email_already_registered');
    expect(invitation?.invited_user_id).toBeNull();

    // applicant_id was never touched by the failed attempt.
    const { data: appAfter } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    expect(appAfter?.applicant_id).toBeNull();

    // No SECOND Auth user was created for this email — only the one we
    // seeded exists.
    let page = 1;
    let matches = 0;
    for (;;) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      matches += data.users.filter((u) => u.email?.toLowerCase() === email.toLowerCase()).length;
      if (data.users.length < 1000) break;
      page += 1;
    }
    expect(matches).toBe(1);
  }, 300000);

  it('Case 3: revokes an unclaimed invitation and deletes the underlying Auth user', async () => {
    const email = `${EMAIL_PREFIX}revoke-${Date.now()}@${EMAIL_DOMAIN}`;
    const applicationId = await seedUnclaimedApplication(email);

    const sendResult = await withRateLimitRetry(() => sendInvitationActionForCaller(applicationId, { userId: staffId, service: admin }));
    const invitedUserId = sendResult.invitedUserId;
    // Tracked even though this case expects revokeInvitation to delete it —
    // code-quality review finding: if the revoke call or a later assertion
    // fails, this Auth user must still be cleaned up. The afterAll delete
    // loop tolerates a "user not found" error from an id that revoke
    // already successfully deleted, so tracking it here is safe either way.
    createdAuthUserIds.push(invitedUserId);

    // Confirm the Auth user really exists before revoking.
    const { data: beforeRevoke } = await admin.auth.admin.getUserById(invitedUserId);
    expect(beforeRevoke.user).toBeTruthy();

    await revokeInvitationActionForCaller(applicationId, { userId: staffId, service: admin });

    const { data: invitation } = await admin
      .from('participant_invitations')
      .select('status, revoked_at, invited_user_id')
      .eq('application_id', applicationId)
      .single();
    expect(invitation?.status).toBe('revoked');
    expect(invitation?.revoked_at).toBeTruthy();
    // invited_user_id is nulled by the `on delete set null` FK once the
    // underlying Auth user (and cascaded profiles row) is gone.
    expect(invitation?.invited_user_id).toBeNull();

    const { data: afterRevoke, error: afterRevokeError } = await admin.auth.admin.getUserById(invitedUserId);
    expect(afterRevoke.user).toBeFalsy();
    expect(afterRevokeError).toBeTruthy();
  }, 300000);

  it('Case 4: refuses to revoke an accepted invitation, leaving the Auth user intact', async () => {
    const email = `${EMAIL_PREFIX}accepted-${Date.now()}@${EMAIL_DOMAIN}`;
    const applicationId = await seedUnclaimedApplication(email);

    const sendResult = await withRateLimitRetry(() => sendInvitationActionForCaller(applicationId, { userId: staffId, service: admin }));
    const invitedUserId = sendResult.invitedUserId;
    createdAuthUserIds.push(invitedUserId);

    // Simulate the invitation having been claimed (Task 21's job in
    // production; here we set status directly since this suite is testing
    // revoke's own guard, not the claim flow).
    await admin.from('participant_invitations').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq(
      'application_id',
      applicationId
    );

    await expect(revokeInvitationActionForCaller(applicationId, { userId: staffId, service: admin })).rejects.toThrow(
      /already-claimed|already been claimed/i
    );

    const { data: invitation } = await admin
      .from('participant_invitations')
      .select('status, invited_user_id')
      .eq('application_id', applicationId)
      .single();
    expect(invitation?.status).toBe('accepted');
    expect(invitation?.invited_user_id).toBe(invitedUserId);

    // The Auth user was NOT deleted.
    const { data: stillThere } = await admin.auth.admin.getUserById(invitedUserId);
    expect(stillThere.user).toBeTruthy();
  }, 300000);
});
