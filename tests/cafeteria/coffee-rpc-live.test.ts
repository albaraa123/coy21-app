// tests/cafeteria/coffee-rpc-live.test.ts
//
// Fixture pattern mirrors tests/cafeteria/lunch-scan-rpc-live.test.ts
// exactly: real Supabase Auth users, real applications rows, afterAll
// cleanup in FK-dependency order.
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
let scannerUserId: string;
let delegateUserId: string;
let delegateApplicationId: string;
let delegateCredentialId: string;
let delegateRawToken: Buffer;
let speakerUserId: string;
let speakerApplicationId: string;
let speakerCredentialId: string;
let speakerRawToken: Buffer;
let kpUserId: string;
let kpApplicationId: string;
let kpCredentialId: string;
let kpRawToken: Buffer;
// Concurrent-deduction test's fixtures: assigned immediately on creation
// (not batched) so the unconditional afterAll sweep can still clean them
// up even if an assertion throws first -- same precedent as
// lunch-scan-rpc-live.test.ts's own concurrent-test fixture handling.
let concurrentUserId: string | undefined;
let concurrentApplicationId: string | undefined;
let concurrentCredentialId: string | undefined;

beforeAll(async () => {
  const { data: scanner, error: scannerError } = await admin.auth.admin.createUser({
    email: `coffee-rpc-${runId}-scanner@test.local`, password: 'password123', email_confirm: true,
  });
  if (scannerError || !scanner.user) throw new Error(`scanner setup failed: ${scannerError?.message}`);
  scannerUserId = scanner.user.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerUserId);

  const { data: delegate, error: delegateError } = await admin.auth.admin.createUser({
    email: `coffee-rpc-${runId}-delegate@test.local`, password: 'password123', email_confirm: true,
  });
  if (delegateError || !delegate.user) throw new Error(`delegate setup failed: ${delegateError?.message}`);
  delegateUserId = delegate.user.id;
  const { data: delegateApp, error: delegateAppError } = await admin.from('applications').insert({
    applicant_id: delegateUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (delegateAppError || !delegateApp) throw new Error(`delegate application setup failed: ${delegateAppError?.message}`);
  delegateApplicationId = delegateApp.id;
  const delegateTok = generateCafeteriaToken();
  delegateRawToken = delegateTok.rawToken;
  const { data: delegateCred, error: delegateCredError } = await admin.from('cafeteria_credentials').insert({
    application_id: delegateApplicationId, token_hash: toByteaHex(hashCafeteriaToken(delegateTok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (delegateCredError || !delegateCred) throw new Error(`delegate credential setup failed: ${delegateCredError?.message}`);
  delegateCredentialId = delegateCred.id;

  // Speaker -- coffee-eligible, NOT lunch-eligible. This fixture is the
  // one case that proves isCoffeeEligible's speaker branch is actually
  // wired into the RPC, not just the TypeScript helper.
  const { data: speaker, error: speakerError } = await admin.auth.admin.createUser({
    email: `coffee-rpc-${runId}-speaker@test.local`, password: 'password123', email_confirm: true,
  });
  if (speakerError || !speaker.user) throw new Error(`speaker setup failed: ${speakerError?.message}`);
  speakerUserId = speaker.user.id;
  const { data: speakerApp, error: speakerAppError } = await admin.from('applications').insert({
    applicant_id: speakerUserId, status: 'accepted', participant_type: 'speaker', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (speakerAppError || !speakerApp) throw new Error(`speaker application setup failed: ${speakerAppError?.message}`);
  speakerApplicationId = speakerApp.id;
  const speakerTok = generateCafeteriaToken();
  speakerRawToken = speakerTok.rawToken;
  const { data: speakerCred, error: speakerCredError } = await admin.from('cafeteria_credentials').insert({
    application_id: speakerApplicationId, token_hash: toByteaHex(hashCafeteriaToken(speakerTok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (speakerCredError || !speakerCred) throw new Error(`speaker credential setup failed: ${speakerCredError?.message}`);
  speakerCredentialId = speakerCred.id;

  // Knowledge partner -- ineligible for both lunch and coffee.
  const { data: kp, error: kpError } = await admin.auth.admin.createUser({
    email: `coffee-rpc-${runId}-kp@test.local`, password: 'password123', email_confirm: true,
  });
  if (kpError || !kp.user) throw new Error(`kp setup failed: ${kpError?.message}`);
  kpUserId = kp.user.id;
  const { data: kpApp, error: kpAppError } = await admin.from('applications').insert({
    applicant_id: kpUserId, status: 'accepted', participant_type: 'knowledge_partner', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (kpAppError || !kpApp) throw new Error(`kp application setup failed: ${kpAppError?.message}`);
  kpApplicationId = kpApp.id;
  const kpTok = generateCafeteriaToken();
  kpRawToken = kpTok.rawToken;
  const { data: kpCred, error: kpCredError } = await admin.from('cafeteria_credentials').insert({
    application_id: kpApplicationId, token_hash: toByteaHex(hashCafeteriaToken(kpTok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (kpCredError || !kpCred) throw new Error(`kp credential setup failed: ${kpCredError?.message}`);
  kpCredentialId = kpCred.id;
});

afterAll(async () => {
  const credentialIds = [delegateCredentialId, speakerCredentialId, kpCredentialId, concurrentCredentialId].filter(Boolean) as string[];
  const applicationIds = [delegateApplicationId, speakerApplicationId, kpApplicationId, concurrentApplicationId].filter(Boolean) as string[];
  const userIds = [scannerUserId, delegateUserId, speakerUserId, kpUserId, concurrentUserId].filter(Boolean) as string[];

  await admin.from('cafeteria_coffee_scans').delete().in('credential_id', credentialIds);
  await admin.from('cafeteria_credentials').delete().in('id', credentialIds);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('cafeteria_coffee_check_balance', () => {
  it('returns eligible=true and remaining_balance=50 for a fresh delegate credential', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)),
    });
    expect(error).toBeNull();
    expect(data![0].eligible).toBe(true);
    expect(Number(data![0].remaining_balance)).toBe(50);
  });

  it('returns eligible=true for a speaker credential (the lunch-ineligible case)', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(speakerRawToken)),
    });
    expect(error).toBeNull();
    expect(data![0].eligible).toBe(true);
  });

  it('returns eligible=false for a knowledge_partner credential', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(kpRawToken)),
    });
    expect(error).toBeNull();
    expect(data![0].eligible).toBe(false);
  });
});

describe('cafeteria_coffee_deduct_transactional', () => {
  it('deducts a valid amount within balance', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_deduct_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)), p_scanned_by: scannerUserId, p_amount: 15,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('deducted');
    expect(Number(data?.amount_deducted)).toBe(15);
  });

  it('reflects the reduced balance on a subsequent check', async () => {
    const { data } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)),
    });
    expect(Number(data![0].remaining_balance)).toBe(35);
  });

  it('allows a second deduction within the remaining balance', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_deduct_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)), p_scanned_by: scannerUserId, p_amount: 20,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('deducted');
  });

  it('rejects a deduction exceeding the remaining balance IN FULL, not partially', async () => {
    // 50 already spent: 15 + 20 = 35, so 15 remains. Requesting 20 must fail outright.
    const { data, error } = await admin.rpc('cafeteria_coffee_deduct_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)), p_scanned_by: scannerUserId, p_amount: 20,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('insufficient_balance');
    expect(data?.amount_deducted).toBeNull();

    // Confirm the balance is unchanged by the rejected attempt (still 15, not reduced).
    const { data: balanceCheck } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)),
    });
    expect(Number(balanceCheck![0].remaining_balance)).toBe(15);
  });

  it('a knowledge_partner credential deducts as ineligible, never succeeds', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_deduct_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(kpRawToken)), p_scanned_by: scannerUserId, p_amount: 10,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('ineligible');
  });

  it('two concurrent deductions that together exceed the balance resolve to exactly one succeeding', async () => {
    const tok = generateCafeteriaToken();
    const { data: applicant2, error: a2Error } = await admin.auth.admin.createUser({
      email: `coffee-rpc-${runId}-concur@test.local`, password: 'password123', email_confirm: true,
    });
    if (a2Error || !applicant2.user) throw new Error('concurrent fixture setup failed');
    concurrentUserId = applicant2.user.id;
    const { data: app2 } = await admin.from('applications').insert({
      applicant_id: applicant2.user.id, status: 'accepted', participant_type: 'volunteer', attendance_confirmation: 'confirmed',
    }).select('id').single();
    concurrentApplicationId = app2!.id;
    const { data: cred2 } = await admin.from('cafeteria_credentials').insert({
      application_id: app2!.id, token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)) as unknown as never,
      qr_image_data_uri: 'data:image/png;base64,TEST',
    }).select('id').single();
    concurrentCredentialId = cred2!.id;

    // Two concurrent deductions of 30 each against a 50 balance -- only one can succeed.
    const [r1, r2] = await Promise.all([
      admin.rpc('cafeteria_coffee_deduct_transactional', { p_token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)), p_scanned_by: scannerUserId, p_amount: 30 }),
      admin.rpc('cafeteria_coffee_deduct_transactional', { p_token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)), p_scanned_by: scannerUserId, p_amount: 30 }),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    const results = [r1.data?.result, r2.data?.result].sort();
    expect(results).toEqual(['deducted', 'insufficient_balance']);
  });
});
