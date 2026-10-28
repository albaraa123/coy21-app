// tests/import/delegate-code-schema-live.test.ts
//
// Minimal live-schema proof for the external_delegate_code/
// registration_category columns added in
// 20261028110000_add_delegate_code_and_registration_category.sql --
// mirrors the shape of other *-schema-live.test.ts files in this
// codebase (e.g. tests/cafeteria/schema-live.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let applicantUserId: string;
let applicantUserId2: string;
let applicationId: string;
let applicationId2: string | undefined;

beforeAll(async () => {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `delcode-schema-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`fixture user setup failed: ${error?.message}`);
  applicantUserId = user.user.id;

  const { data: user2, error: error2 } = await admin.auth.admin.createUser({
    email: `delcode-schema-${runId}-b@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error2 || !user2.user) throw new Error(`fixture user 2 setup failed: ${error2?.message}`);
  applicantUserId2 = user2.user.id;
});

afterAll(async () => {
  if (applicationId2) await admin.from('applications').delete().eq('id', applicationId2);
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  for (const id of [applicantUserId, applicantUserId2].filter(Boolean)) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('applications.external_delegate_code / registration_category', () => {
  it('accepts null on insert (both columns nullable)', async () => {
    const { data, error } = await admin
      .from('applications')
      .insert({ applicant_id: applicantUserId, status: 'draft' })
      .select('id, external_delegate_code, registration_category')
      .single();
    expect(error).toBeNull();
    applicationId = data!.id;
    expect(data!.external_delegate_code).toBeNull();
    expect(data!.registration_category).toBeNull();
  });

  it('stores and reads back real values', async () => {
    const code = `DEL-TEST-${runId}`;
    const { data, error } = await admin
      .from('applications')
      .update({ external_delegate_code: code, registration_category: 'Delegates' })
      .eq('id', applicationId)
      .select('external_delegate_code, registration_category')
      .single();
    expect(error).toBeNull();
    expect(data!.external_delegate_code).toBe(code);
    expect(data!.registration_category).toBe('Delegates');
  });

  it('rejects a duplicate external_delegate_code', async () => {
    const dupeCode = `DEL-DUPE-${runId}`;
    await admin.from('applications').update({ external_delegate_code: dupeCode }).eq('id', applicationId);

    const { data: app2, error: insertError } = await admin
      .from('applications')
      .insert({ applicant_id: applicantUserId2, status: 'draft', external_delegate_code: dupeCode })
      .select('id')
      .maybeSingle();
    if (app2) applicationId2 = app2.id; // only set if it unexpectedly succeeded, so afterAll can still clean it up
    expect(insertError).not.toBeNull();
    expect(insertError!.message).toMatch(/unique|duplicate/i);
  });
});
