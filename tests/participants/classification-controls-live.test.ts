// tests/participants/classification-controls-live.test.ts
//
// Live smoke coverage for Task 5's two new Server Action entry points on
// participants/[applicationId] (docs/superpowers/plans/2026-09-30-import-
// classification-approval.md, Task 5): updateParticipantTypeActionForCaller
// (actions.ts) and issueQrForApplicationAction (qr-actions.ts). Task 4's own
// live suite (classification-edit-live.test.ts) already exercises
// reclassifyApplication's full branch logic in depth; this file only proves
// the new thin wrappers are wired correctly end to end against the real DB
// (auth/role gating aside, which is exercised via the *ForCaller variant the
// same way the rest of this codebase's live suites test 'use server' actions
// that otherwise require a real Next.js request for cookies()).
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const RAW_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const RAW_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAW_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!RAW_URL || !RAW_SERVICE_KEY || !RAW_ANON_KEY) {
  throw new Error(
    'classification-controls-live.test.ts requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY to be set. This is a live-DB test against a real (scratch) Supabase project — ' +
      'it intentionally fails loudly rather than silently skipping when these are missing.'
  );
}

const URL: string = RAW_URL;
const SERVICE_KEY: string = RAW_SERVICE_KEY;
const ANON_KEY: string = RAW_ANON_KEY;

vi.setConfig({ testTimeout: 30000 });

// Same rationale as classification-edit-live.test.ts: intercept only the
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
    if (error) console.error('classification-controls-live.test.ts afterAll: failed to delete application fixtures', error);
  }
  for (const id of authUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

async function createStaffFixture(role: 'super_admin' = 'super_admin') {
  const email = `classification-controls-staff-live-${runId}-${randomUUID().slice(0, 8)}@test.local`;
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
      full_name: `Classification Controls Fixture ${runId}`,
      participant_type: 'delegate',
      application_number: `COY21-TEST-CC-${runId}-${applicationIds.length}`,
      imported_email: `classification-controls-live-${runId}-${applicationIds.length}@test.local`,
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

describe('updateParticipantTypeActionForCaller (live)', () => {
  it('delegates to reclassifyApplication and its result shape matches what classification-controls.tsx expects', async () => {
    vi.resetModules();
    const { updateParticipantTypeActionForCaller } = await import(
      '@/app/[locale]/(admin)/participants/[applicationId]/actions'
    );

    const applicationId = await insertAcceptedApplication({ participant_type: 'delegate' });
    const staff = await createStaffFixture();
    const before = await fetchApplication(applicationId);

    const result = await updateParticipantTypeActionForCaller(applicationId, 'knowledge_partner', {
      userId: staff.userId,
      session: staff.client,
      service: admin,
    });

    // No active QR credential and no applicant_id → 'number_regenerated'
    // branch of reclassifyApplication, matching Task 4's own equivalent case.
    expect(result.outcome).toBe('number_regenerated');
    expect(result.applicationId).toBe(applicationId);
    expect(result.newApplicationNumber).toBeTruthy();
    expect(result.newApplicationNumber).not.toBe(before.application_number);

    const after = await fetchApplication(applicationId);
    expect(after.participant_type).toBe('knowledge_partner');
    expect(after.application_number).toBe(result.newApplicationNumber);
  });

  it('throws (not a silent error return) when reclassifyApplication reports outcome "error"', async () => {
    vi.resetModules();
    const { updateParticipantTypeActionForCaller } = await import(
      '@/app/[locale]/(admin)/participants/[applicationId]/actions'
    );
    const staff = await createStaffFixture();

    await expect(
      updateParticipantTypeActionForCaller(randomUUID(), 'volunteer', {
        userId: staff.userId,
        session: staff.client,
        service: admin,
      })
    ).rejects.toThrow();
  });
});

describe('issueQrForApplicationAction (live)', () => {
  it('fetches application status via service, then issues a real QR credential for an accepted application with none active', async () => {
    vi.resetModules();
    const staff = await createStaffFixture();
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => staff.client,
      createServiceRoleClient: () => admin,
    }));

    const { issueQrForApplicationAction } = await import(
      '@/app/[locale]/(admin)/participants/[applicationId]/qr-actions'
    );

    const applicationId = await insertAcceptedApplication();

    const result = await issueQrForApplicationAction(applicationId);
    qrTouchedApplicationIds.add(applicationId);

    expect(result.error).toBeNull();
    const active = await fetchActiveCredential(applicationId);
    expect(active).toBeTruthy();
    expect(active!.status).toBe('active');
  });

  it('returns an error (not a throw) for a non-accepted application', async () => {
    vi.resetModules();
    const staff = await createStaffFixture();
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => staff.client,
      createServiceRoleClient: () => admin,
    }));

    const { issueQrForApplicationAction } = await import(
      '@/app/[locale]/(admin)/participants/[applicationId]/qr-actions'
    );

    const applicationId = await insertAcceptedApplication({ status: 'submitted', application_number: null });

    const result = await issueQrForApplicationAction(applicationId);
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/accepted/i);
  });

  it('is idempotent on a repeated call for an application that already has an active credential', async () => {
    vi.resetModules();
    const staff = await createStaffFixture();
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => staff.client,
      createServiceRoleClient: () => admin,
    }));

    const { issueQrForApplicationAction } = await import(
      '@/app/[locale]/(admin)/participants/[applicationId]/qr-actions'
    );

    const applicationId = await insertAcceptedApplication();

    const first = await issueQrForApplicationAction(applicationId);
    qrTouchedApplicationIds.add(applicationId);
    expect(first.error).toBeNull();

    const second = await issueQrForApplicationAction(applicationId);
    expect(second.error).toBeNull();

    // Exactly one active credential after both calls — the repeat call must
    // not have created a second active row.
    const { data: activeRows, error } = await admin
      .from('qr_credentials')
      .select('id')
      .eq('application_id', applicationId)
      .eq('status', 'active');
    if (error) throw new Error(`Failed to list active credentials: ${error.message}`);
    expect(activeRows ?? []).toHaveLength(1);
  });
});
