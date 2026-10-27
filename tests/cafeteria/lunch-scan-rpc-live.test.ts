// tests/cafeteria/lunch-scan-rpc-live.test.ts
//
// Fixture pattern mirrors tests/attendance/scan-attempt-concurrency-live.test.ts
// exactly: real Supabase Auth users, real applications rows, afterAll
// cleanup in FK-dependency order. Unlike that file's session-scoped
// concurrency, this credential's advisory lock is keyed per-credential-id
// (not per-session), so two DIFFERENT credentials never contend with
// each other — only two scans of the SAME credential do.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { generateCafeteriaToken, hashCafeteriaToken } from '@/lib/cafeteria/token';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// PostgREST bytea encoding: supabase-js JSON-serializes a raw Node Buffer
// as {"type":"Buffer","data":[...]} , which is NOT a valid bytea literal
// and trips cafeteria_credentials_token_hash_check / this RPC's own
// length guard. Same `\x` + hex convention this codebase already uses in
// src/lib/attendance/scan-qr-attempt.ts's toByteaHexOrNull and
// src/lib/attendance/qr-credential-issuance.ts's toByteaHex.
function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let scannerUserId: string;
let applicantUserId: string;
let applicationId: string;
let credentialId: string;
let credentialRawToken: Buffer;
let ineligibleApplicantUserId: string;
let ineligibleApplicationId: string;
let ineligibleCredentialId: string;
let ineligibleRawToken: Buffer;
// Concurrent-scan test's fixtures: created inline inside that `it(...)`
// block (not beforeAll, since this credential must be fresh/untouched),
// but assigned here the moment each is created so the unconditional
// afterAll sweep below can still clean them up even if an assertion in
// that test throws before its own inline cleanup would otherwise run —
// see tests/attendance/scan-attempt-concurrency-live.test.ts for the
// precedent of module-level accumulators swept in one afterAll.
let concurrentApplicantUserId: string | undefined;
let concurrentApplicationId: string | undefined;
let concurrentCredentialId: string | undefined;

beforeAll(async () => {
  const { data: scanner, error: scannerError } = await admin.auth.admin.createUser({
    email: `cafe-scan-${runId}-scanner@test.local`, password: 'password123', email_confirm: true,
  });
  if (scannerError || !scanner.user) throw new Error(`scanner setup failed: ${scannerError?.message}`);
  scannerUserId = scanner.user.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerUserId);

  const { data: applicant, error: applicantError } = await admin.auth.admin.createUser({
    email: `cafe-scan-${runId}-delegate@test.local`, password: 'password123', email_confirm: true,
  });
  if (applicantError || !applicant.user) throw new Error(`applicant setup failed: ${applicantError?.message}`);
  applicantUserId = applicant.user.id;
  const { data: app, error: appError } = await admin.from('applications').insert({
    applicant_id: applicantUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (appError || !app) throw new Error(`application setup failed: ${appError?.message}`);
  applicationId = app.id;

  const tok = generateCafeteriaToken();
  credentialRawToken = tok.rawToken;
  const { data: cred, error: credError } = await admin.from('cafeteria_credentials').insert({
    application_id: applicationId, token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (credError || !cred) throw new Error(`credential setup failed: ${credError?.message}`);
  credentialId = cred.id;

  // A second, ineligible (knowledge_partner) credential for the
  // live-eligibility-recheck test.
  const { data: kp, error: kpError } = await admin.auth.admin.createUser({
    email: `cafe-scan-${runId}-kp@test.local`, password: 'password123', email_confirm: true,
  });
  if (kpError || !kp.user) throw new Error(`kp setup failed: ${kpError?.message}`);
  ineligibleApplicantUserId = kp.user.id;
  const { data: kpApp, error: kpAppError } = await admin.from('applications').insert({
    applicant_id: ineligibleApplicantUserId, status: 'accepted', participant_type: 'knowledge_partner', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (kpAppError || !kpApp) throw new Error(`kp application setup failed: ${kpAppError?.message}`);
  ineligibleApplicationId = kpApp.id;
  const kpTok = generateCafeteriaToken();
  ineligibleRawToken = kpTok.rawToken;
  const { data: kpCred, error: kpCredError } = await admin.from('cafeteria_credentials').insert({
    application_id: ineligibleApplicationId, token_hash: toByteaHex(hashCafeteriaToken(kpTok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (kpCredError || !kpCred) throw new Error(`kp credential setup failed: ${kpCredError?.message}`);
  ineligibleCredentialId = kpCred.id;
});

afterAll(async () => {
  const credentialIds = [credentialId, ineligibleCredentialId, concurrentCredentialId].filter(Boolean);
  const applicationIds = [applicationId, ineligibleApplicationId, concurrentApplicationId].filter(Boolean);
  const userIds = [scannerUserId, applicantUserId, ineligibleApplicantUserId, concurrentApplicantUserId].filter(Boolean) as string[];

  await admin.from('cafeteria_lunch_scans').delete().in('credential_id', credentialIds);
  await admin.from('cafeteria_credentials').delete().in('id', credentialIds);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('cafeteria_lunch_scan_transactional', () => {
  it('first scan of the day admits', async () => {
    const { data, error } = await admin.rpc('cafeteria_lunch_scan_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(credentialRawToken)),
      p_scanned_by: scannerUserId,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('admitted');
  });

  it('second scan same day is already_used_today', async () => {
    const { data, error } = await admin.rpc('cafeteria_lunch_scan_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(credentialRawToken)),
      p_scanned_by: scannerUserId,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('already_used_today');
  });

  it('knowledge_partner credential scans as ineligible, never admitted', async () => {
    const { data, error } = await admin.rpc('cafeteria_lunch_scan_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(ineligibleRawToken)),
      p_scanned_by: scannerUserId,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('ineligible');
  });

  it('two concurrent same-day scans of the same credential resolve to exactly one admitted (fresh credential)', async () => {
    const tok = generateCafeteriaToken();
    const { data: applicant2, error: a2Error } = await admin.auth.admin.createUser({
      email: `cafe-scan-${runId}-concur@test.local`, password: 'password123', email_confirm: true,
    });
    if (a2Error || !applicant2.user) throw new Error('concurrent fixture setup failed');
    // Assign to the module-level tracking var immediately on creation
    // (not batched at the end) so the afterAll sweep can still find and
    // clean this up even if an assertion below throws first.
    concurrentApplicantUserId = applicant2.user.id;
    const { data: app2 } = await admin.from('applications').insert({
      applicant_id: applicant2.user.id, status: 'accepted', participant_type: 'volunteer', attendance_confirmation: 'confirmed',
    }).select('id').single();
    concurrentApplicationId = app2!.id;
    const { data: cred2 } = await admin.from('cafeteria_credentials').insert({
      application_id: app2!.id, token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)) as unknown as never,
      qr_image_data_uri: 'data:image/png;base64,TEST',
    }).select('id').single();
    concurrentCredentialId = cred2!.id;

    const [r1, r2] = await Promise.all([
      admin.rpc('cafeteria_lunch_scan_transactional', { p_token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)), p_scanned_by: scannerUserId }),
      admin.rpc('cafeteria_lunch_scan_transactional', { p_token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)), p_scanned_by: scannerUserId }),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    const results = [r1.data?.result, r2.data?.result].sort();
    expect(results).toEqual(['admitted', 'already_used_today']);
  });
});
