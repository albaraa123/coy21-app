// tests/participants/accounts-classification-live.test.ts
//
// Live smoke coverage for Task 6's new bulk Server Action entry point on
// participants/accounts (docs/superpowers/plans/2026-09-30-import-
// classification-approval.md, Task 6): changeClassificationForSelectedForCaller
// (actions.ts). Task 4's own live suite (classification-edit-live.test.ts)
// already exercises reclassifyApplication's full branch logic in depth, and
// Task 7 will add more thorough coverage of this exact entry point later —
// this file is a smaller smoke test proving the new bulk wrapper (its own
// local processClassificationChangesInChunks chunking helper, and threading
// applicationIds through to reclassifyApplication per item) is wired
// correctly end to end against the real DB, attributing each outcome to the
// right applicationId across a batch with mixed QR states.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const RAW_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const RAW_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAW_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!RAW_URL || !RAW_SERVICE_KEY || !RAW_ANON_KEY) {
  throw new Error(
    'accounts-classification-live.test.ts requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY to be set. This is a live-DB test against a real (scratch) Supabase project — ' +
      'it intentionally fails loudly rather than silently skipping when these are missing.'
  );
}

const URL: string = RAW_URL;
const SERVICE_KEY: string = RAW_SERVICE_KEY;
const ANON_KEY: string = RAW_ANON_KEY;

vi.setConfig({ testTimeout: 30000 });

// Same rationale as classification-controls-live.test.ts: intercept only the
// outbound 'resend' SDK call, everything else (DB, QR RPCs) is fully real.
const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));
vi.mock('@/lib/email/send-guarded', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send-guarded')>();
  return {
    ...actual,
    fetchEmailSettings: vi.fn().mockResolvedValue({ sandboxEnabled: false, sandboxRecipientEmail: null }),
  };
});

const admin = createClient<Database>(URL, SERVICE_KEY);
const runId = randomUUID().slice(0, 8);

const authUserIds: string[] = [];
const applicationIds: string[] = [];
// Same immutability constraint documented in classification-edit-live.test.ts:
// once a fixture application gets a real qr_credentials row, it can never be
// deleted (delete-restrict FK + a permanent no-delete trigger on
// qr_credentials/qr_lifecycle_operations). Track which ones were QR-touched.
const qrTouchedApplicationIds = new Set<string>();

afterAll(async () => {
  const deletableApplicationIds = applicationIds.filter((id) => !qrTouchedApplicationIds.has(id));
  if (deletableApplicationIds.length > 0) {
    const { error } = await admin.from('applications').delete().in('id', deletableApplicationIds);
    if (error) console.error('accounts-classification-live.test.ts afterAll: failed to delete application fixtures', error);
  }
  for (const id of authUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

async function createStaffFixture(role: 'super_admin' = 'super_admin') {
  const email = `accounts-classification-staff-live-${runId}-${randomUUID().slice(0, 8)}@test.local`;
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
      full_name: `Accounts Classification Fixture ${runId}`,
      participant_type: 'delegate',
      application_number: `COY21-TEST-AC-${runId}-${applicationIds.length}`,
      imported_email: `accounts-classification-live-${runId}-${applicationIds.length}@test.local`,
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

describe('changeClassificationForSelectedForCaller (live)', () => {
  it('applies a bulk classification change across a batch with mixed QR states, attributing each outcome to its applicationId', async () => {
    vi.resetModules();
    const { changeClassificationForSelectedForCaller } = await import(
      '@/app/[locale]/(admin)/participants/accounts/actions'
    );
    const { issueStaffQrCredential } = await import('@/lib/attendance/qr-credential-issuance');

    const staff = await createStaffFixture();

    // One application with no active QR credential.
    const noQrId = await insertAcceptedApplication({ participant_type: 'delegate' });

    // One application with a real active QR credential, issued via the
    // established issuance path so the reissue branch of
    // reclassifyApplication is genuinely exercised.
    const withQrId = await insertAcceptedApplication({ participant_type: 'delegate' });
    const issueResult = await issueStaffQrCredential(staff.client, admin, {
      requestKey: randomUUID(),
      applicationId: withQrId,
      issuanceReasonCode: 'staff_other',
      issuanceNote: 'accounts-classification-live.test.ts fixture setup',
    });
    if (issueResult.outcome !== 'issued' && issueResult.outcome !== 'already_finalized') {
      throw new Error(`Failed to issue fixture QR credential: ${issueResult.outcome}`);
    }
    qrTouchedApplicationIds.add(withQrId);

    const beforeNoQr = await fetchApplication(noQrId);
    const beforeWithQr = await fetchApplication(withQrId);

    const results = await changeClassificationForSelectedForCaller([noQrId, withQrId], 'knowledge_partner', {
      userId: staff.userId,
      session: staff.client,
      service: admin,
    });

    expect(results).toHaveLength(2);
    const byId = new Map(results.map((r) => [r.applicationId, r] as const));

    const noQrResult = byId.get(noQrId);
    expect(noQrResult).toBeTruthy();
    expect(noQrResult!.outcome).toBe('number_regenerated');

    const withQrResult = byId.get(withQrId);
    expect(withQrResult).toBeTruthy();
    expect(withQrResult!.outcome).toBe('reissued');

    const afterNoQr = await fetchApplication(noQrId);
    expect(afterNoQr.participant_type).toBe('knowledge_partner');
    expect(afterNoQr.application_number).not.toBe(beforeNoQr.application_number);

    const afterWithQr = await fetchApplication(withQrId);
    expect(afterWithQr.participant_type).toBe('knowledge_partner');
    expect(afterWithQr.application_number).not.toBe(beforeWithQr.application_number);

    // Old credential replaced, new one active.
    const { data: credentials, error: credError } = await admin
      .from('qr_credentials')
      .select('id, status')
      .eq('application_id', withQrId);
    if (credError) throw new Error(`Failed to list credentials: ${credError.message}`);
    const active = (credentials ?? []).filter((c) => c.status === 'active');
    const replaced = (credentials ?? []).filter((c) => c.status === 'replaced');
    expect(active).toHaveLength(1);
    expect(replaced.length).toBeGreaterThanOrEqual(1);
  });

  it('reports outcome "error" per item (not a thrown batch failure) for an unknown applicationId mixed into a batch', async () => {
    vi.resetModules();
    const { changeClassificationForSelectedForCaller } = await import(
      '@/app/[locale]/(admin)/participants/accounts/actions'
    );
    const staff = await createStaffFixture();

    const validId = await insertAcceptedApplication({ participant_type: 'delegate' });
    const missingId = randomUUID();

    const results = await changeClassificationForSelectedForCaller([validId, missingId], 'volunteer', {
      userId: staff.userId,
      session: staff.client,
      service: admin,
    });

    expect(results).toHaveLength(2);
    const byId = new Map(results.map((r) => [r.applicationId, r] as const));
    expect(byId.get(validId)?.outcome).toBe('number_regenerated');
    expect(byId.get(missingId)?.outcome).toBe('error');
  });
});
