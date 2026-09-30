// tests/participants/classification-edit-live.test.ts
//
// Live coverage for Task 4 of
// docs/superpowers/plans/2026-09-30-import-classification-approval.md
// ("Shared reclassify-and-reissue helper", spec §3.4) — src/lib/participants/
// reclassify.ts's reclassifyApplication, exercised against the real
// database and real Phase 6 QR reservation/finalizer RPCs, with only the
// outbound Resend SDK call intercepted.
//
// Mixing a real DB with a mocked Resend SDK in one file follows the
// precedent established by tests/register/submit-application-live.test.ts
// (Task 3): `vi.mock('resend', ...)` intercepts only the 'resend' npm
// package (exactly as tests/email/resend-send.test.ts does), which never
// overlaps with @supabase/supabase-js, so the live DB/QR-RPC calls below
// are completely real while outbound email is fully intercepted.
// fetchEmailSettings is mocked the same way, to avoid its own real
// service-role client construction against email_settings.
//
// request_staff_qr_issuance_transactional / request_staff_qr_reissue_
// transactional are SECURITY DEFINER but granted EXECUTE only to
// `authenticated` and derive the caller from auth.uid() — so, mirroring
// tests/attendance/qr-credential-issuance-live.test.ts's own
// createStaffFixture pattern, every reissue call below uses a real signed-in
// staff fixture client as the `requester`, while the service-role admin
// client is used for direct fixture setup/assertions.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const RAW_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const RAW_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAW_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!RAW_URL || !RAW_SERVICE_KEY || !RAW_ANON_KEY) {
  throw new Error(
    'classification-edit-live.test.ts requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY to be set. This is a live-DB test against a real (scratch) Supabase project — ' +
      'it intentionally fails loudly rather than silently skipping when these are missing.'
  );
}

// TypeScript's control-flow narrowing on a module-scope const doesn't carry
// into functions declared later in the file — re-bind to `string`-typed
// constants right after the guard above, rather than sprinkling `!`
// assertions at every later call site.
const URL: string = RAW_URL;
const SERVICE_KEY: string = RAW_SERVICE_KEY;
const ANON_KEY: string = RAW_ANON_KEY;

vi.setConfig({ testTimeout: 30000 });

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

// Same rationale as submit-application-live.test.ts: resend.ts routes sends
// through fetchEmailSettings() (src/lib/email/send-guarded.ts), which
// constructs its own service-role client to read email_settings. This suite
// only cares about whether sendClassificationChangeNotificationEmail is
// invoked (and how many times), not sandbox routing, so fetchEmailSettings
// is short-circuited to sandbox-disabled while the real sendEmailGuarded
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

const runId = randomUUID().slice(0, 8);

const authUserIds: string[] = [];
const applicationIds: string[] = [];
// qr_credentials and qr_lifecycle_operations both have a trigger enforcing
// "rows are never deleted, only transitioned" (Phase 6,
// 20260805235959_phase6_qr_issuance_reissue.sql — a deliberate, permanent
// audit-trail guarantee, confirmed by deliberately attempting the delete
// against the live scratch DB and reading the raised exception's own text).
// qr_credentials.application_id/qr_lifecycle_operations.application_id both
// reference applications(id) on delete restrict, so once a test below calls
// issueStaffQrCredential for an application, that application can NEVER be
// deleted either — not a bug to work around, a structural consequence of
// this immutability guarantee. tests/attendance/qr-credential-issuance-live.test.ts
// (the established precedent for QR fixtures) has no afterAll cleanup at
// all, for the same reason. Track which application IDs actually got a real
// credential so this suite only attempts to delete the ones that CAN be
// deleted, and accepts that QR-touched fixture rows accumulate permanently
// in the scratch project (acceptable for a disposable, non-production
// database — mirroring the precedent file's own accepted tradeoff).
const qrTouchedApplicationIds = new Set<string>();

afterAll(async () => {
  const deletableApplicationIds = applicationIds.filter((id) => !qrTouchedApplicationIds.has(id));
  if (deletableApplicationIds.length > 0) {
    const { error: applicationDeleteError } = await admin.from('applications').delete().in('id', deletableApplicationIds);
    if (applicationDeleteError) {
      console.error('classification-edit-live.test.ts afterAll: failed to delete applications fixtures', applicationDeleteError);
    }
  }
  for (const id of authUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

async function createApplicantUser(label: string): Promise<{ userId: string; email: string }> {
  const email = `classification-edit-live-${runId}-${label}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create fixture applicant user: ${error?.message}`);
  authUserIds.push(data.user.id);
  return { userId: data.user.id, email };
}

async function createStaffFixture(role: 'super_admin' = 'super_admin') {
  const email = `classification-edit-staff-live-${runId}-${randomUUID().slice(0, 8)}@test.local`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (userError || !user.user) throw new Error(`Failed to create fixture staff user: ${userError?.message}`);
  authUserIds.push(user.user.id);

  const { error: roleError } = await admin.from('profiles').update({ role }).eq('id', user.user.id);
  if (roleError) throw new Error(`Failed to set staff role: ${roleError.message}`);

  const client = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`Staff sign-in failed: ${signInError.message}`);

  return { userId: user.user.id, client };
}

async function insertAcceptedApplication(overrides: Partial<Database['public']['Tables']['applications']['Insert']> = {}): Promise<string> {
  const { data, error } = await admin
    .from('applications')
    .insert({
      status: 'accepted',
      full_name: `Classification Edit Fixture ${runId}`,
      participant_type: 'delegate',
      application_number: `COY21-TEST-${runId}-${applicationIds.length}`,
      ...overrides,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to insert accepted application fixture: ${error?.message}`);
  applicationIds.push(data.id);
  return data.id;
}

async function fetchApplication(applicationId: string) {
  const { data, error } = await admin
    .from('applications')
    .select('status, application_number, participant_type, applicant_id')
    .eq('id', applicationId)
    .single();
  if (error || !data) throw new Error(`Failed to fetch application: ${error?.message}`);
  return data;
}

async function fetchCredential(credentialId: string) {
  const { data, error } = await admin.from('qr_credentials').select('id, status, application_id').eq('id', credentialId).single();
  if (error || !data) throw new Error(`Failed to fetch credential: ${error?.message}`);
  return data;
}

async function fetchActiveCredential(applicationId: string) {
  const { data, error } = await admin
    .from('qr_credentials')
    .select('id, status, application_id')
    .eq('application_id', applicationId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch active credential: ${error.message}`);
  return data;
}

describe('reclassifyApplication (live)', () => {
  it('a real accepted application with a real active QR credential gets reclassified: old credential replaced, new one active, application_number changes', async () => {
    vi.resetModules();
    const { issueStaffQrCredential } = await import('@/lib/attendance/qr-credential-issuance');
    const { reclassifyApplication } = await import('@/lib/participants/reclassify');

    const { userId } = await createApplicantUser('qr-reclassify');
    const applicationId = await insertAcceptedApplication({ applicant_id: userId, participant_type: 'delegate' });
    const staff = await createStaffFixture();

    const issued = await issueStaffQrCredential(staff.client, admin, {
      requestKey: randomUUID(),
      applicationId,
      issuanceReasonCode: 'staff_other',
      issuanceNote: 'Fixture setup for classification-edit-live.test.ts',
    });
    qrTouchedApplicationIds.add(applicationId);
    expect(issued.outcome).toBe('issued');
    expect(issued.credentialId).toBeTruthy();
    const oldCredentialId = issued.credentialId!;

    const before = await fetchApplication(applicationId);
    const oldApplicationNumber = before.application_number;

    const result = await reclassifyApplication(staff.client, admin, {
      applicationId,
      newParticipantType: 'volunteer',
      actorId: staff.userId,
    });

    expect(result.outcome).toBe('reissued');
    expect(result.newApplicationNumber).toBeTruthy();
    expect(result.newApplicationNumber).not.toBe(oldApplicationNumber);

    const after = await fetchApplication(applicationId);
    expect(after.participant_type).toBe('volunteer');
    expect(after.application_number).toBe(result.newApplicationNumber);
    expect(after.application_number).not.toBe(oldApplicationNumber);

    const oldCredential = await fetchCredential(oldCredentialId);
    expect(oldCredential.status).toBe('replaced');

    const newActiveCredential = await fetchActiveCredential(applicationId);
    expect(newActiveCredential).toBeTruthy();
    expect(newActiveCredential!.status).toBe('active');
    expect(newActiveCredential!.id).not.toBe(oldCredentialId);
  });

  it('accepted, no active QR credential: application_number is regenerated with no reissue and no email', async () => {
    vi.resetModules();
    const { reclassifyApplication } = await import('@/lib/participants/reclassify');

    const { userId } = await createApplicantUser('no-qr');
    const applicationId = await insertAcceptedApplication({ applicant_id: userId, participant_type: 'delegate' });
    const staff = await createStaffFixture();

    const before = await fetchApplication(applicationId);

    const result = await reclassifyApplication(staff.client, admin, {
      applicationId,
      newParticipantType: 'knowledge_partner',
      actorId: staff.userId,
    });

    expect(result.outcome).toBe('number_regenerated');
    expect(result.newApplicationNumber).toBeTruthy();
    expect(result.newApplicationNumber).not.toBe(before.application_number);
    expect(sendMock).not.toHaveBeenCalled();

    const after = await fetchApplication(applicationId);
    expect(after.participant_type).toBe('knowledge_partner');
    expect(after.application_number).toBe(result.newApplicationNumber);
  });

  it('not-yet-accepted application: participant_type updates, application_number stays untouched, no reissue, no email', async () => {
    vi.resetModules();
    const { reclassifyApplication } = await import('@/lib/participants/reclassify');

    const { userId } = await createApplicantUser('not-accepted');
    const applicationId = await insertAcceptedApplication({
      applicant_id: userId,
      participant_type: 'delegate',
      status: 'submitted',
      application_number: null,
    });
    const staff = await createStaffFixture();

    const result = await reclassifyApplication(staff.client, admin, {
      applicationId,
      newParticipantType: 'youngo',
      actorId: staff.userId,
    });

    expect(result.outcome).toBe('updated_only');
    expect(sendMock).not.toHaveBeenCalled();

    const after = await fetchApplication(applicationId);
    expect(after.status).toBe('submitted');
    expect(after.participant_type).toBe('youngo');
    expect(after.application_number).toBeNull();
  });

  describe('notification email is sent via the guarded layer only when applicant_id is set', () => {
    it('sends exactly one email when applicant_id is set (claimed) and an active QR credential exists', async () => {
      vi.resetModules();
      const { issueStaffQrCredential } = await import('@/lib/attendance/qr-credential-issuance');
      const { reclassifyApplication } = await import('@/lib/participants/reclassify');

      const { userId, email } = await createApplicantUser('claimed-email');
      const profileName = `Claimed Applicant ${runId}`;
      const { error: profileError } = await admin.from('profiles').update({ full_name: profileName }).eq('id', userId);
      expect(profileError).toBeNull();

      const applicationId = await insertAcceptedApplication({ applicant_id: userId, participant_type: 'delegate' });
      const staff = await createStaffFixture();

      const issued = await issueStaffQrCredential(staff.client, admin, {
        requestKey: randomUUID(),
        applicationId,
        issuanceReasonCode: 'staff_other',
        issuanceNote: 'Fixture setup for claimed-applicant email test',
      });
      qrTouchedApplicationIds.add(applicationId);
      expect(issued.outcome).toBe('issued');

      const result = await reclassifyApplication(staff.client, admin, {
        applicationId,
        newParticipantType: 'speaker',
        actorId: staff.userId,
      });

      expect(result.outcome).toBe('reissued');
      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = sendMock.mock.calls[0][0];
      expect(call.to).toBe(email);
      expect(call.subject).toContain(result.newApplicationNumber);
    });

    it('sends zero emails when applicant_id is null (unclaimed), even with an active QR credential', async () => {
      vi.resetModules();
      const { issueStaffQrCredential } = await import('@/lib/attendance/qr-credential-issuance');
      const { reclassifyApplication } = await import('@/lib/participants/reclassify');

      // applications_owner_or_import_identity requires applicant_id OR
      // imported_email to be set — an unclaimed row is never identity-less,
      // it's always traceable to an import (see
      // supabase/migrations/20260726100000_applications_import_columns.sql).
      const applicationId = await insertAcceptedApplication({
        applicant_id: null,
        imported_email: `classification-edit-live-${runId}-unclaimed@test.local`,
        participant_type: 'delegate',
      });
      const staff = await createStaffFixture();

      const issued = await issueStaffQrCredential(staff.client, admin, {
        requestKey: randomUUID(),
        applicationId,
        issuanceReasonCode: 'staff_other',
        issuanceNote: 'Fixture setup for unclaimed-applicant email test',
      });
      qrTouchedApplicationIds.add(applicationId);
      expect(issued.outcome).toBe('issued');

      const result = await reclassifyApplication(staff.client, admin, {
        applicationId,
        newParticipantType: 'speaker',
        actorId: staff.userId,
      });

      expect(result.outcome).toBe('reissued');
      expect(sendMock).not.toHaveBeenCalled();

      const after = await fetchApplication(applicationId);
      expect(after.applicant_id).toBeNull();
    });
  });
});
