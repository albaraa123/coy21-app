// tests/cafeteria/coffee-schema-live.test.ts
//
// Minimal live-schema proof for cafeteria_coffee_scans, mirroring
// tests/cafeteria/schema-live.test.ts's shape (the Phase 1 lunch table's
// own schema test).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { generateCafeteriaToken, hashCafeteriaToken } from '@/lib/cafeteria/token';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let applicantUserId: string;
let applicationId: string;
let credentialId: string;

beforeAll(async () => {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `coffee-schema-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`fixture user setup failed: ${error?.message}`);
  applicantUserId = user.user.id;

  const { data: app, error: appError } = await admin.from('applications').insert({
    applicant_id: applicantUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (appError || !app) throw new Error(`application fixture setup failed: ${appError?.message}`);
  applicationId = app.id;

  const tok = generateCafeteriaToken();
  const { data: cred, error: credError } = await admin.from('cafeteria_credentials').insert({
    application_id: applicationId, token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (credError || !cred) throw new Error(`credential fixture setup failed: ${credError?.message}`);
  credentialId = cred.id;
});

afterAll(async () => {
  if (credentialId) await admin.from('cafeteria_coffee_scans').delete().eq('credential_id', credentialId);
  if (credentialId) await admin.from('cafeteria_credentials').delete().eq('id', credentialId);
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  if (applicantUserId) await admin.auth.admin.deleteUser(applicantUserId);
});

describe('cafeteria_coffee_scans', () => {
  it('accepts a deducted row with a positive amount', async () => {
    const { data, error } = await admin.from('cafeteria_coffee_scans').insert({
      credential_id: credentialId, scan_date: '2026-11-05', result: 'deducted', amount_deducted: 15,
    }).select('id, amount_deducted').single();
    expect(error).toBeNull();
    expect(Number(data!.amount_deducted)).toBe(15);
  });

  it('rejects a deducted row with a null/zero amount', async () => {
    const { error } = await admin.from('cafeteria_coffee_scans').insert({
      credential_id: credentialId, scan_date: '2026-11-05', result: 'deducted', amount_deducted: 0,
    });
    expect(error).not.toBeNull();
  });

  it('rejects a non-deducted row that has an amount set', async () => {
    const { error } = await admin.from('cafeteria_coffee_scans').insert({
      credential_id: credentialId, scan_date: '2026-11-05', result: 'ineligible', amount_deducted: 10,
    });
    expect(error).not.toBeNull();
  });

  it('accepts a non-deducted row with no amount', async () => {
    const { data, error } = await admin.from('cafeteria_coffee_scans').insert({
      credential_id: credentialId, scan_date: '2026-11-05', result: 'insufficient_balance',
    }).select('id, amount_deducted').single();
    expect(error).toBeNull();
    expect(data!.amount_deducted).toBeNull();
  });
});
