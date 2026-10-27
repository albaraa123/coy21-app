// tests/participants/guardian-info-schema-live.test.ts
//
// Minimal live-schema proof for the guardian_name/guardian_phone
// columns added in 20261028100000_add_guardian_info_to_applications.sql
// -- mirrors the shape of other *-schema-live.test.ts files in this
// codebase (e.g. tests/cafeteria/schema-live.test.ts): no business
// logic here, just confirming the columns exist with the right
// nullability via a real insert/select round trip.
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
let applicationId: string;

beforeAll(async () => {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `guardian-schema-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`fixture user setup failed: ${error?.message}`);
  applicantUserId = user.user.id;
});

afterAll(async () => {
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  if (applicantUserId) await admin.auth.admin.deleteUser(applicantUserId);
});

describe('applications.guardian_name / guardian_phone', () => {
  it('accepts null on insert (column is nullable)', async () => {
    const { data, error } = await admin
      .from('applications')
      .insert({ applicant_id: applicantUserId, status: 'draft' })
      .select('id, guardian_name, guardian_phone')
      .single();
    expect(error).toBeNull();
    applicationId = data!.id;
    expect(data!.guardian_name).toBeNull();
    expect(data!.guardian_phone).toBeNull();
  });

  it('stores and reads back real values', async () => {
    const { data, error } = await admin
      .from('applications')
      .update({ guardian_name: 'Fatima Al-Rashid', guardian_phone: '+96899112233' })
      .eq('id', applicationId)
      .select('guardian_name, guardian_phone')
      .single();
    expect(error).toBeNull();
    expect(data!.guardian_name).toBe('Fatima Al-Rashid');
    expect(data!.guardian_phone).toBe('+96899112233');
  });
});
