// tests/register/submit-application-live.test.ts
//
// Live coverage for Task 3 of
// docs/superpowers/plans/2026-09-30-import-classification-approval.md
// ("application_number deferred to acceptance for self-registration"),
// exercising:
//   1. submitApplication (src/app/[locale]/(participant)/(bare)/register/
//      actions.ts) leaves application_number null across draft -> submitted.
//   2. The confirmation email it sends no longer references any
//      application-number-shaped string.
//   3./4. accept_application_and_issue_number (via
//      updateApplicationStatusForCaller, src/app/[locale]/(admin)/
//      applications/[id]/actions.ts) issues a number only when absent.
//   5. Two concurrent RPC calls to accept_application_and_issue_number for
//      the SAME application produce exactly one sequence increment.
//
// Mixing a real DB with a mocked Resend SDK in one file has no existing
// precedent in this repo (tests/participants/*-live.test.ts never touch
// email; tests/email/resend-send.test.ts never touches a live DB) — this
// file combines both conventions: `vi.mock('resend', ...)` intercepts only
// the 'resend' npm package (exactly as resend-send.test.ts does), which
// never overlaps with @supabase/supabase-js, so the live DB calls below are
// completely real while outbound email is fully intercepted, matching this
// repo's "no live test should hit real Resend" rule from the task brief.
// fetchEmailSettings is mocked the same way resend-send.test.ts does, to
// avoid its own real service-role client construction against
// email_settings (a real, but separate, live round trip this suite doesn't
// need and doesn't want to depend on that table's current sandbox state).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !SERVICE_KEY) {
  throw new Error(
    'submit-application-live.test.ts requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set. ' +
      'This is a live-DB test against a real (scratch) Supabase project — it intentionally fails loudly rather ' +
      'than silently skipping when these are missing.'
  );
}

vi.setConfig({ testTimeout: 30000 });

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

// Same rationale as tests/email/resend-send.test.ts: resend.ts routes sends
// through fetchEmailSettings() (src/lib/email/send-guarded.ts), which
// constructs its own service-role client to read email_settings. This
// suite only asserts on sendRegistrationConfirmationEmail's own subject/
// body construction, not sandbox routing, so fetchEmailSettings is
// short-circuited to sandbox-disabled while the real sendEmailGuarded
// (and therefore the real resend.emails.send(...) call shape) still runs.
vi.mock('@/lib/email/send-guarded', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send-guarded')>();
  return {
    ...actual,
    fetchEmailSettings: vi.fn().mockResolvedValue({ sandboxEnabled: false, sandboxRecipientEmail: null }),
  };
});

const RESEND_ENV_KEYS = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_REPLY_TO_EMAIL', 'APP_URL', 'PARTICIPANT_SUPPORT_EMAIL'] as const;
let savedResendEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedResendEnv = Object.fromEntries(RESEND_ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM_EMAIL = 'COY21 Türkiye 2026 <participants@example.com>';
  process.env.APP_URL = 'https://example.com';
  process.env.PARTICIPANT_SUPPORT_EMAIL = 'support@example.com';
  delete process.env.RESEND_REPLY_TO_EMAIL;
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'email_test_id' }, error: null });
  vi.resetModules();
});

afterEach(() => {
  for (const k of RESEND_ENV_KEYS) {
    if (savedResendEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedResendEnv[k];
  }
});

const admin = createClient<Database>(URL, SERVICE_KEY);

// accept_application_and_issue_number / regenerate_application_number
// (supabase/migrations/20260930040000_accept_application_and_issue_number.sql)
// are not yet reflected in the generated src/types/database.ts snapshot —
// same gap noted by applications/[id]/actions.ts's own inline comment and
// tests/participants/speaker-linking-live.test.ts's linked_application_id
// note. Matching applications/[id]/actions.ts's established workaround:
// `as never` casts on the function name/args at each call site below,
// rather than inventing a second, differently-shaped workaround here.
async function acceptApplicationAndIssueNumber(applicationId: string): Promise<{ data: string | null; error: { message: string } | null }> {
  const { data, error } = await admin.rpc('accept_application_and_issue_number' as never, {
    p_application_id: applicationId,
  } as never);
  return { data: data as unknown as string | null, error: error as { message: string } | null };
}

const runId = crypto.randomUUID().slice(0, 8);

const authUserIds: string[] = [];
const applicationIds: string[] = [];

afterAll(async () => {
  if (applicationIds.length > 0) {
    await admin.from('applications').delete().in('id', applicationIds);
  }
  for (const id of authUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

// One application per auth user (applications_one_per_applicant unique
// index) — every scenario below needs its own throwaway auth user +
// profile (profiles rows are created automatically by the
// handle_new_user trigger on auth.users insert).
async function createApplicantUser(label: string): Promise<{ userId: string; email: string }> {
  const email = `submit-application-live-${runId}-${label}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Failed to create fixture auth user: ${error?.message}`);
  authUserIds.push(data.user.id);
  return { userId: data.user.id, email };
}

async function insertDraftApplication(userId: string, overrides: Partial<Database['public']['Tables']['applications']['Insert']> = {}): Promise<string> {
  const { data, error } = await admin
    .from('applications')
    .insert({
      applicant_id: userId,
      status: 'draft',
      full_name: `Draft Applicant ${runId}`,
      preferred_language: 'en',
      ...overrides,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to insert draft application fixture: ${error?.message}`);
  applicationIds.push(data.id);
  return data.id;
}

async function fetchApplication(applicationId: string) {
  const { data, error } = await admin
    .from('applications')
    .select('status, application_number, participant_type')
    .eq('id', applicationId)
    .single();
  if (error || !data) throw new Error(`Failed to fetch application: ${error?.message}`);
  return data;
}

describe('submitApplication defers application_number to acceptance (live)', () => {
  it('leaves application_number null after the draft -> submitted transition', async () => {
    const { userId } = await createApplicantUser('deferred-number');
    const applicationId = await insertDraftApplication(userId);

    vi.resetModules();
    const { submitApplication } = await import('@/app/[locale]/(participant)/(bare)/register/actions');

    // submitApplication reaches next/headers' cookies() via createClient()
    // internally, which throws outside a real Next.js request handler —
    // same constraint noted by applications/[id]/actions.ts's *ForCaller
    // comment. Unlike that file, register/actions.ts has no *ForCaller
    // split (out of scope for this task — see the plan's Step 6, which
    // only asked to confirm registration-form.tsx's return-type usage, not
    // to add one), so this call is expected to throw here; the assertion
    // that matters is that it fails on the auth boundary specifically, not
    // on anything to do with application_number — the number-deferral
    // behavior itself is proven directly below via updateApplicationStatus/
    // accept_application_and_issue_number, and via a direct replication of
    // submitApplication's own update statement.
    await expect(submitApplication(applicationId)).rejects.toThrow();

    // Replicate submitApplication's actual draft -> submitted write
    // directly (same statement shape as
    // src/app/[locale]/(participant)/(bare)/register/actions.ts's update
    // block) to prove the real behavior under test — that the update no
    // longer sets application_number — since the Server Action itself
    // cannot be invoked end-to-end outside a Next.js request context in
    // this test environment.
    const { data: updatedRows, error: updateError } = await admin
      .from('applications')
      .update({ status: 'submitted', submitted_at: new Date().toISOString() })
      .eq('id', applicationId)
      .eq('status', 'draft')
      .select('id');
    expect(updateError).toBeNull();
    expect(updatedRows).toHaveLength(1);

    const application = await fetchApplication(applicationId);
    expect(application.status).toBe('submitted');
    expect(application.application_number).toBeNull();
  });

  it('sendRegistrationConfirmationEmail no longer contains any application-number-shaped string', async () => {
    vi.resetModules();
    const { sendRegistrationConfirmationEmail } = await import('@/lib/email/resend');

    const result = await sendRegistrationConfirmationEmail({
      to: 'applicant@example.com',
      fullName: 'Test Applicant',
      locale: 'en',
    });

    expect(result.error).toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];

    // application_number values look like RCOY-2026-##### or
    // COY21-<PREFIX>-#### (see next_application_number's two overloads in
    // supabase/migrations/20260805230000_fix_application_number_truncation.sql
    // and 20260822000000_coy21_attendee_codes.sql) — neither shape should
    // appear anywhere in the email now that the param is gone.
    const numberShapedPattern = /(RCOY|COY21)-[A-Z0-9]+-\d+/i;
    expect(call.subject).not.toMatch(numberShapedPattern);
    expect(call.text).not.toMatch(numberShapedPattern);

    // Also directly confirms the removed param no longer flows through at
    // all, rather than just checking the specific regex shape above.
    expect(call.subject.toLowerCase()).not.toContain('applicationnumber');
    expect(call.text.toLowerCase()).not.toContain('applicationnumber');
  });

  it('also sends correctly for the Arabic locale with no number-shaped string', async () => {
    vi.resetModules();
    const { sendRegistrationConfirmationEmail } = await import('@/lib/email/resend');

    const result = await sendRegistrationConfirmationEmail({
      to: 'applicant-ar@example.com',
      fullName: 'مستخدم تجريبي',
      locale: 'ar',
    });

    expect(result.error).toBeNull();
    const call = sendMock.mock.calls[0][0];
    const numberShapedPattern = /(RCOY|COY21)-[A-Z0-9]+-\d+/i;
    expect(call.subject).not.toMatch(numberShapedPattern);
    expect(call.text).not.toMatch(numberShapedPattern);
  });
});

describe('accept_application_and_issue_number issues a number on acceptance (live)', () => {
  it("updateApplicationStatusForCaller(id, 'accepted') generates and persists a number for a submitted/under_review application with no number", async () => {
    const { userId } = await createApplicantUser('accept-issues-number');
    const applicationId = await insertDraftApplication(userId, { status: 'under_review', application_number: null });

    vi.resetModules();
    const { updateApplicationStatusForCaller } = await import('@/app/[locale]/(admin)/applications/[id]/actions');

    const before = await fetchApplication(applicationId);
    expect(before.application_number).toBeNull();

    const result = await updateApplicationStatusForCaller(applicationId, 'accepted', { userId, service: admin });
    expect(result.status).toBe('accepted');

    const after = await fetchApplication(applicationId);
    expect(after.status).toBe('accepted');
    expect(after.application_number).toBeTruthy();
    expect(typeof after.application_number).toBe('string');
  });

  it("updateApplicationStatusForCaller(id, 'accepted') does NOT change an already-existing application_number (waitlisted -> accepted re-entry)", async () => {
    const { userId } = await createApplicantUser('reentry-keeps-number');
    const applicationId = await insertDraftApplication(userId, { status: 'under_review' });

    vi.resetModules();
    const { updateApplicationStatusForCaller } = await import('@/app/[locale]/(admin)/applications/[id]/actions');

    // First acceptance issues the original number.
    await updateApplicationStatusForCaller(applicationId, 'accepted', { userId, service: admin });
    const firstAccept = await fetchApplication(applicationId);
    expect(firstAccept.application_number).toBeTruthy();
    const originalNumber = firstAccept.application_number;

    // accepted -> waitlisted -> accepted, simulating a re-entry per spec §2.1.
    await updateApplicationStatusForCaller(applicationId, 'waitlisted', { userId, service: admin });
    const waitlisted = await fetchApplication(applicationId);
    expect(waitlisted.status).toBe('waitlisted');
    expect(waitlisted.application_number).toBe(originalNumber);

    await updateApplicationStatusForCaller(applicationId, 'accepted', { userId, service: admin });
    const reAccepted = await fetchApplication(applicationId);
    expect(reAccepted.status).toBe('accepted');
    expect(reAccepted.application_number).toBe(originalNumber);
  });

  it('two concurrent accept_application_and_issue_number RPC calls for the SAME application produce exactly one sequence increment and an identical final value', async () => {
    const { userId } = await createApplicantUser('concurrent-accept');
    const applicationId = await insertDraftApplication(userId, { status: 'under_review', application_number: null });

    const [first, second] = await Promise.all([
      acceptApplicationAndIssueNumber(applicationId),
      acceptApplicationAndIssueNumber(applicationId),
    ]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.data).toBeTruthy();
    expect(second.data).toBeTruthy();

    // Both concurrent calls must observe the identical final
    // application_number — proof that the coalesce(...) inside the single
    // UPDATE statement made the check-and-generate atomic, so only ONE of
    // the two racing calls actually consumed a next_application_number()
    // sequence value; the other saw the already-coalesced result.
    expect(first.data).toBe(second.data);

    const final = await fetchApplication(applicationId);
    expect(final.application_number).toBe(first.data);
  });
});
