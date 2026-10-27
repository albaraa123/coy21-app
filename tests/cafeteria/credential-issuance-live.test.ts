// tests/cafeteria/credential-issuance-live.test.ts
//
// Fixture pattern mirrors tests/cafeteria/lunch-scan-rpc-live.test.ts and
// its own cited precedent tests/attendance/scan-attempt-concurrency-live.test.ts:
// real Supabase Auth users, real applications rows, every setup call's
// error destructured and checked explicitly before its data is used.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { issueCafeteriaCredentialForCaller } from '@/lib/cafeteria/credential-issuance';

// Live round trips to the real Supabase project routinely exceed Vitest's
// 5000ms default in this codebase (see tests/cafeteria/schema-live.test.ts
// and others for the same fix).
vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
let delegateUserId: string;
let delegateApplicationId: string;
let kpUserId: string;
// Staff fixture: profile_id-keyed path (no applications row). Assigned
// the moment it's created (not batched at the end) so the afterAll sweep
// can still find and clean it up even if an assertion in its test throws
// first — same discipline as the concurrent-scan fixture in
// tests/cafeteria/lunch-scan-rpc-live.test.ts.
let staffUserId: string | undefined;

beforeAll(async () => {
  const { data: delegate, error: delegateError } = await admin.auth.admin.createUser({
    email: `cafe-issue-${runId}-delegate@test.local`, password: 'password123', email_confirm: true,
  });
  if (delegateError || !delegate.user) throw new Error(`delegate user setup failed: ${delegateError?.message}`);
  delegateUserId = delegate.user.id;

  const { data: app, error: appError } = await admin.from('applications').insert({
    applicant_id: delegateUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (appError || !app) throw new Error(`delegate application setup failed: ${appError?.message}`);
  delegateApplicationId = app.id;

  const { data: kp, error: kpError } = await admin.auth.admin.createUser({
    email: `cafe-issue-${runId}-kp@test.local`, password: 'password123', email_confirm: true,
  });
  if (kpError || !kp.user) throw new Error(`knowledge_partner user setup failed: ${kpError?.message}`);
  kpUserId = kp.user.id;

  const { error: kpAppError } = await admin.from('applications').insert({
    applicant_id: kpUserId, status: 'accepted', participant_type: 'knowledge_partner', attendance_confirmation: 'confirmed',
  });
  if (kpAppError) throw new Error(`knowledge_partner application setup failed: ${kpAppError.message}`);
});

afterAll(async () => {
  const userIds = [delegateUserId, kpUserId, staffUserId].filter(Boolean) as string[];

  await admin.from('cafeteria_credentials').delete().eq('application_id', delegateApplicationId);
  if (staffUserId) {
    await admin.from('cafeteria_credentials').delete().eq('profile_id', staffUserId);
  }
  await admin.from('applications').delete().in('applicant_id', [delegateUserId, kpUserId]);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('issueCafeteriaCredentialForCaller', () => {
  it('issues a credential for an eligible delegate', async () => {
    const result = await issueCafeteriaCredentialForCaller({ userId: delegateUserId, service: admin });
    expect(result.outcome).toBe('issued');
  });

  it('is idempotent — a second call returns the existing credential and the SAME QR image', async () => {
    const first = await issueCafeteriaCredentialForCaller({ userId: delegateUserId, service: admin });
    const second = await issueCafeteriaCredentialForCaller({ userId: delegateUserId, service: admin });
    expect(second.outcome).toBe('already_exists');
    if (first.outcome === 'issued' && second.outcome === 'already_exists') {
      expect(second.credentialId).toBe(first.credentialId);
      expect(second.qrImageDataUri).toBe(first.qrImageDataUri);
    }
  });

  it('refuses to issue for an ineligible knowledge_partner', async () => {
    const result = await issueCafeteriaCredentialForCaller({ userId: kpUserId, service: admin });
    expect(result.outcome).toBe('not_eligible');
  });

  it('issues a profile_id-keyed credential for a staff member (no applications row), and is idempotent', async () => {
    const { data: staff, error: staffError } = await admin.auth.admin.createUser({
      email: `cafe-issue-${runId}-staff@test.local`, password: 'password123', email_confirm: true,
    });
    if (staffError || !staff.user) throw new Error(`staff user setup failed: ${staffError?.message}`);
    staffUserId = staff.user.id;

    const { error: roleError } = await admin.from('profiles').update({ role: 'staff' }).eq('id', staffUserId);
    if (roleError) throw new Error(`staff role update failed: ${roleError.message}`);

    const first = await issueCafeteriaCredentialForCaller({ userId: staffUserId, service: admin });
    expect(first.outcome).toBe('issued');

    const second = await issueCafeteriaCredentialForCaller({ userId: staffUserId, service: admin });
    expect(second.outcome).toBe('already_exists');
    if (first.outcome === 'issued' && second.outcome === 'already_exists') {
      expect(second.credentialId).toBe(first.credentialId);
      expect(second.qrImageDataUri).toBe(first.qrImageDataUri);
    }
  });
});
