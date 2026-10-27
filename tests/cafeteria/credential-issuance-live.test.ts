// tests/cafeteria/credential-issuance-live.test.ts
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

beforeAll(async () => {
  const { data: delegate } = await admin.auth.admin.createUser({
    email: `cafe-issue-${runId}-delegate@test.local`, password: 'password123', email_confirm: true,
  });
  delegateUserId = delegate!.user!.id;
  const { data: app } = await admin.from('applications').insert({
    applicant_id: delegateUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  delegateApplicationId = app!.id;

  const { data: kp } = await admin.auth.admin.createUser({
    email: `cafe-issue-${runId}-kp@test.local`, password: 'password123', email_confirm: true,
  });
  kpUserId = kp!.user!.id;
  await admin.from('applications').insert({
    applicant_id: kpUserId, status: 'accepted', participant_type: 'knowledge_partner', attendance_confirmation: 'confirmed',
  });
});

afterAll(async () => {
  await admin.from('cafeteria_credentials').delete().eq('application_id', delegateApplicationId);
  await admin.from('applications').delete().in('applicant_id', [delegateUserId, kpUserId]);
  await admin.auth.admin.deleteUser(delegateUserId);
  await admin.auth.admin.deleteUser(kpUserId);
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
});
