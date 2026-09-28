// tests/auth/resend-production-email-live.test.ts
//
// Live integration coverage for the production Resend email setup (this
// task's own scope: env-driven config, delivery-status tracking columns,
// retryFailedEmailsForSelected, and bounded processing of a 500+
// selection). Uses the REAL sendLoginDetailsEmail path but with
// RESEND_API_KEY intentionally left unset/invalid for automated-test runs
// — the design explicitly forbids sending real emails to a full
// participant list during automated testing, and every send here is
// expected to fail at the Resend API layer, which is exactly what proves
// the failure-isolation and status-tracking behavior this task adds.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  createAccountsForSelectedForCaller,
  sendLoginDetailsForCaller,
  retryFailedEmailsForSelectedForCaller,
} from '@/app/[locale]/(admin)/participants/accounts/actions';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `resend-prod-live-${runId}-`;

let actorId: string;
const createdApplicationIds: string[] = [];
const createdAuthUserIds: string[] = [];

async function seedImportedApplication(email: string, fullName = 'Prod Email Test Person') {
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

describe('email status transitions through sending -> failed (no real send in this env)', () => {
  it('marks sending before the API call, then failed (never leaves a stale not_sent)', async () => {
    const email = `${EMAIL_PREFIX}status@example.com`;
    const applicationId = await seedImportedApplication(email);
    const createResult = await createAccountsForSelectedForCaller([applicationId], { userId: actorId, service: admin });
    expect(createResult[0].outcome).toBe('account_created');
    const { data: app } = await admin.from('applications').select('applicant_id').eq('id', applicationId).single();
    createdAuthUserIds.push(app!.applicant_id!);

    await sendLoginDetailsForCaller([applicationId], { userId: actorId, service: admin }, { isResend: false });

    const { data: row } = await admin
      .from('participant_account_provisioning')
      .select('email_status, last_send_attempt_at, last_error_code, last_error_message')
      .eq('application_id', applicationId)
      .single();
    // RESEND_API_KEY is unset in the automated-test environment, so the
    // send genuinely fails at the SDK/config layer -- proving the status
    // lands on 'failed' with a safe error, never silently stuck at
    // 'not_sent' or 'sending'.
    expect(row?.email_status).toBe('failed');
    expect(row?.last_send_attempt_at).toBeTruthy();
    expect(row?.last_error_code).toBe('email_send_failed');
    expect(row?.last_error_message).not.toContain('password');
  }, 60000);
});

describe('retryFailedEmailsForSelectedForCaller', () => {
  it('retries only rows whose email_status is failed, leaving others untouched', async () => {
    const failedEmail = `${EMAIL_PREFIX}retry-failed@example.com`;
    const failedAppId = await seedImportedApplication(failedEmail);
    const createResult1 = await createAccountsForSelectedForCaller([failedAppId], { userId: actorId, service: admin });
    const { data: failedApp } = await admin.from('applications').select('applicant_id').eq('id', failedAppId).single();
    if (createResult1[0].outcome === 'account_created') createdAuthUserIds.push(failedApp!.applicant_id!);
    await sendLoginDetailsForCaller([failedAppId], { userId: actorId, service: admin }, { isResend: false });
    const { data: afterFirstSend } = await admin.from('participant_account_provisioning').select('email_status').eq('application_id', failedAppId).single();
    expect(afterFirstSend?.email_status).toBe('failed');

    const notAttemptedEmail = `${EMAIL_PREFIX}retry-not-attempted@example.com`;
    const notAttemptedAppId = await seedImportedApplication(notAttemptedEmail);
    const createResult2 = await createAccountsForSelectedForCaller([notAttemptedAppId], { userId: actorId, service: admin });
    const { data: notAttemptedApp } = await admin.from('applications').select('applicant_id').eq('id', notAttemptedAppId).single();
    if (createResult2[0].outcome === 'account_created') createdAuthUserIds.push(notAttemptedApp!.applicant_id!);
    // Deliberately never send for this one — its email_status stays 'not_sent'.

    const retryResults = await retryFailedEmailsForSelectedForCaller([failedAppId, notAttemptedAppId], { userId: actorId, service: admin });

    // Only the failed row was in scope for the retry.
    expect(retryResults.map((r) => r.applicationId)).toEqual([failedAppId]);

    const { data: notAttemptedAfter } = await admin.from('participant_account_provisioning').select('email_status').eq('application_id', notAttemptedAppId).single();
    expect(notAttemptedAfter?.email_status).toBe('not_sent'); // untouched by the retry
  }, 90000);
});

describe('bounded processing of a 500+ selection (no real email sends)', () => {
  it('processes 520 selected applications\' email-send attempts without crashing, isolating each failure', async () => {
    // This test's subject is the email-dispatch chunk loop specifically
    // (processInChunks inside sendLoginDetailsForCaller), not account
    // creation — Phase C's own live suites already cover account-creation
    // correctness exhaustively. Seeding applications AND their
    // participant_account_provisioning rows directly (bypassing
    // provisionParticipantAccount's real auth.admin.createUser call
    // entirely) keeps setup fast while still exercising the exact code
    // path a 500+ "send login details" bulk action runs in production:
    // sendLoginDetailsForCaller's own eligibility check, its 'sending'
    // status write, the real (failing, since no API key is configured in
    // this test environment) sendLoginDetailsEmail call, and the final
    // 'failed' status write — for every one of 520 rows, each isolated
    // from the others.
    const count = 520;
    const emails = Array.from({ length: count }, (_, i) => `${EMAIL_PREFIX}bulk-${i}@example.com`);
    const ids: string[] = [];
    for (let i = 0; i < emails.length; i += 100) {
      const appBatch = emails.slice(i, i + 100).map((email) => ({ applicant_id: null, imported_email: email, status: 'accepted' as const, full_name: 'Bulk Test Person' }));
      const { data, error } = await admin.from('applications').insert(appBatch).select('id');
      if (error) throw new Error(`Failed to seed bulk applications: ${error.message}`);
      for (const row of data ?? []) ids.push(row.id);
    }
    createdApplicationIds.push(...ids);

    // Directly seed a provisioning row per application in the exact state
    // sendLoginDetailsForCaller requires to consider a row eligible
    // (account_status='password_change_required', must_change_password
    // true) — auth_user_id is left null deliberately; the actor id itself
    // is a valid uuid and reused here purely as a structurally-valid
    // placeholder foreign key value, not a real linked account per row
    // (this test never asserts anything about auth_user_id).
    for (let i = 0; i < ids.length; i += 200) {
      const rows = ids.slice(i, i + 200).map((applicationId, idx) => ({
        application_id: applicationId,
        normalized_email: emails[i + idx],
        account_status: 'password_change_required' as const,
        email_status: 'not_sent' as const,
        must_change_password: true,
        auth_user_id: actorId,
      }));
      const { error } = await admin.from('participant_account_provisioning').insert(rows);
      if (error) throw new Error(`Failed to seed provisioning rows: ${error.message}`);
    }

    const emailResults = await sendLoginDetailsForCaller(ids, { userId: actorId, service: admin }, { isResend: false });
    expect(emailResults).toHaveLength(count);
    // Every send genuinely fails (no real RESEND_API_KEY in this test
    // environment) -- the exact scenario that proves one failure never
    // stops the remaining 519.
    expect(emailResults.every((r) => r.outcome === 'email_failed')).toBe(true);

    // Re-verify against the database too (not just the in-memory result
    // array), chunked -- a single .in() filter over all 520 uuids exceeds
    // PostgREST's URL-length limit (the same reason the import pipeline's
    // own lookups chunk at 100, per row-validation.ts's LOOKUP_CHUNK).
    let dbFailedCount = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const { count: chunkCount } = await admin
        .from('participant_account_provisioning')
        .select('application_id', { count: 'exact', head: true })
        .in('application_id', ids.slice(i, i + 100))
        .eq('email_status', 'failed');
      dbFailedCount += chunkCount ?? 0;
    }
    expect(dbFailedCount).toBe(count);
  }, 180000);
});
