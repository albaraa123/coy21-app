// tests/attendance/qr-credentials-lifecycle-trigger.test.ts
//
// Live coverage for qr_credentials_enforce_lifecycle_trigger() (Phase 6
// design doc §1.5) — exercised via direct service_role inserts/updates
// against qr_credentials that bypass every reservation/finalizer RPC
// entirely, proving the trigger is a genuine second, independent defense
// layer and not merely a restatement of what the RPCs already check.
//
// Fixture pattern follows tests/attendance/scan-attempt-live.test.ts and
// tests/schedule/concurrency.test.ts: real Supabase Auth users via
// admin.auth.admin.createUser (which fires handle_new_user() and creates
// the matching profiles row automatically — profiles is never inserted
// directly, only updated afterward for role), one real accepted
// applications row per fixture (respecting applications_one_per_applicant),
// and careful afterAll cleanup in FK-dependency order.
//
// Each test creates its own isolated auth user(s) + profile(s) +
// application + credential id + token hash via createFixture()/
// createStaffActor() below — no two tests share an application_id, so
// qr_credentials_one_active_per_application can never collide across tests
// regardless of run order.
//
// REQUIRES A DISPOSABLE DATABASE — local by default. Unlike this repo's
// other `*-live.test.ts` files (which run against whichever project
// NEXT_PUBLIC_SUPABASE_URL points at), this file creates permanent
// encryption-key-registry transitions (rotate_encryption_key_version_for_server
// calls that cannot be undone by this file's own afterAll — only a full
// database reset restores the original key state) and depends on two
// SECURITY DEFINER test-only helper functions
// (qr-credentials-lifecycle-trigger.test-only-setup.sql) that must never
// exist on a shared, staging, or production project. See
// tests/attendance/disposable-database-guard.ts for the shared guard
// (used identically by qr-issuance-reservation.test.ts) — it refuses to
// run unless NEXT_PUBLIC_SUPABASE_URL is clearly local, or a remote
// Supabase Cloud project is explicitly pinned via
// PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS=true + PHASE6_DISPOSABLE_PROJECT_REF.
//
// Exact local run sequence:
//   supabase start
//   supabase db reset --local
//   supabase db query --local -f tests/attendance/qr-credentials-lifecycle-trigger.test-only-setup.sql
//   npx vitest run tests/attendance/qr-credentials-lifecycle-trigger.test.ts
//   supabase db query --local -f tests/attendance/qr-credentials-lifecycle-trigger.test-only-teardown.sql
//   supabase db reset --local
//
// `supabase start` prints (and `supabase status -o env` re-prints) the
// local API URL and local service_role key. vitest.config.ts already loads
// .env.local into process.env before any test file runs (see that file's
// own loadEnv call) — set NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY in .env.local to the LOCAL values from
// `supabase status`, not the shared/staging project's values, before
// running this file. The guard below exists specifically so a
// misconfigured .env.local (still pointing at the shared project because
// that is what every other live-test file in this repo intentionally
// uses) fails loudly instead of silently running permanent key-rotation
// side effects against real project state.
import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { assertDisposableDatabase } from './disposable-database-guard';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// This suite performs permanent encryption-key-registry transitions and
// depends on SECURITY DEFINER test-only helpers
// (qr-credentials-lifecycle-trigger.test-only-setup.sql) that must never
// exist on a shared, staging, or production project. Local
// (127.0.0.1/localhost) is always allowed with no override. A remote host
// is allowed ONLY for an explicitly pinned, disposable Supabase Cloud
// project — see disposable-database-guard.ts. This replaces the previous
// bare QR_TRIGGER_TEST_ALLOW_REMOTE=1 escape hatch, which accepted any
// non-local hostname with no project-ref pinning.
assertDisposableDatabase('qr-credentials-lifecycle-trigger.test.ts', URL);

const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

// -- bytea helpers ----------------------------------------------------------
// PostgREST represents bytea as a "\x"-prefixed hex string on both read and
// write; there is no other client-side encoding this repo's schema expects
// (no existing table in this codebase yet has a client-inserted bytea
// column to follow as precedent — this is the first — so this uses
// PostgREST's own documented bytea wire format directly).
function toBytea(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

function randomTokenHash(): string {
  return toBytea(randomBytes(32)); // token_hash: bytea, must be exactly 32 bytes (§1.2 CHECK)
}

// A valid v1 ciphertext envelope: version byte 0x01 followed by 60 bytes of
// arbitrary payload — exactly 61 bytes total, matching §1.2/§1.5's
// octet_length = 61 and get_byte(...,0) = 1 requirements. The trigger only
// validates shape (length + version tag), never decrypts, so the payload
// content is immaterial.
function validEnvelope(): Buffer {
  return Buffer.concat([Buffer.from([1]), randomBytes(60)]);
}

function envelopeWithVersion(version: number): Buffer {
  return Buffer.concat([Buffer.from([version]), randomBytes(60)]);
}

function envelopeOfLength(length: number): Buffer {
  // Version-byte-correct regardless of length, so a wrong-length rejection
  // can only be attributed to the length check, never the version check.
  return Buffer.concat([Buffer.from([1]), randomBytes(Math.max(length - 1, 0))]);
}

// -- Postgres exception assertion helper -------------------------------------
// A `raise exception '<message>'` with no explicit SQLSTATE always surfaces
// through PostgREST/Supabase JS as code 'P0001' (Postgres's default for
// plpgsql RAISE EXCEPTION) with error.message equal to the exact literal
// text passed to RAISE. Asserting BOTH the code and the exact message is
// the JS-client equivalent of GET STACKED DIAGNOSTICS RETURNED_SQLSTATE /
// MESSAGE_TEXT in a raw SQL test — it distinguishes the trigger's own raise
// from a same-transaction FK violation (23503), unique violation (23505),
// or CHECK violation (23514), any of which could otherwise produce a
// false-positive "rejected" result without ever reaching the code path
// under test.
function expectTriggerRejection(error: { code?: string; message?: string } | null, expectedMessage: string) {
  expect(error, `expected rejection "${expectedMessage}" but the operation succeeded`).not.toBeNull();
  expect(error!.code, `expected Postgres RAISE EXCEPTION (P0001), got code ${error!.code} / message "${error!.message}"`).toBe('P0001');
  expect(error!.message).toBe(expectedMessage);
}

// -- fixtures -----------------------------------------------------------------
const cleanupUserIds: string[] = [];
const cleanupApplicationIds: string[] = [];
const cleanupCredentialIds: string[] = [];
let fixtureCounter = 0;

interface CredentialFixture {
  applicationId: string;
  credentialId: string;
  tokenHash: string;
}

interface StaffActor {
  profileId: string;
}

async function createAuthUserAndProfile(role?: Database['public']['Enums']['user_role']): Promise<string> {
  fixtureCounter += 1;
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: `qr-trigger-live-${fixtureCounter}-${Date.now()}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`Failed to create fixture auth user: ${userError?.message}`);
  cleanupUserIds.push(user.user.id);

  if (role) {
    const { error: roleError } = await admin.from('profiles').update({ role }).eq('id', user.user.id);
    if (roleError) throw new Error(`Failed to set fixture profile role: ${roleError.message}`);
  }

  return user.user.id;
}

// One isolated application per fixture: a fresh auth user (→ auto-created
// profiles row via handle_new_user(), left at its 'participant' default —
// this fixture is the credential's OWNING application, never itself the
// staff actor performing an issuance/revocation/replacement on some OTHER
// application) plus one accepted application for that user
// (applications_one_per_applicant permits exactly one, which is exactly
// what every test here needs), and a fresh, unused credential id + token
// hash for the qr_credentials row the test itself will attempt to
// insert/update.
async function createCredentialFixture(): Promise<CredentialFixture> {
  const applicantProfileId = await createAuthUserAndProfile();

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: applicantProfileId, status: 'accepted' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to create fixture application: ${appError?.message}`);
  cleanupApplicationIds.push(app.id);

  const credentialId = randomUUID();
  cleanupCredentialIds.push(credentialId);

  return { applicationId: app.id, credentialId, tokenHash: randomTokenHash() };
}

// A staff (or otherwise-roled, e.g. plain 'participant' for the negative
// cases) actor — a person who ISSUES/REVOKES/REPLACES a credential on
// someone else's application, never the applicant of the credential row
// itself. Independent auth user from any CredentialFixture in the same
// test, so no test ever accidentally reuses one person as both the
// credential's owning applicant and its staff actor.
async function createStaffActor(role: Database['public']['Enums']['user_role']): Promise<StaffActor> {
  const profileId = await createAuthUserAndProfile(role);
  return { profileId };
}

// Resolved fresh, live, per call — never cached in shared mutable state.
// The decrypt_only-key test below rotates the registry's active key
// version, which would silently invalidate a cached value for every test
// that runs after it; querying live each time keeps every test's fixture
// construction independent of test execution order.
async function getActiveKeyVersion(): Promise<number> {
  const { data: keyRow, error } = await admin
    .from('qr_encryption_key_registry')
    .select('key_version')
    .eq('status', 'active')
    .limit(1)
    .single();
  if (error || !keyRow) throw new Error(`Failed to resolve the active encryption key version: ${error?.message}`);
  return keyRow.key_version;
}

// Finds the first version in 1..32767 (encryption_key_version's own
// smallint CHECK range, §1.2) that has NO row in qr_encryption_key_registry
// at all. CORRECTED this round: a prior version computed
// max(key_version) + 1, which fails at the boundary — if the maximum
// registered version is already 32767, that arithmetic produces 32768,
// which the registry's own smallint CHECK constraint rejects BEFORE the
// value ever reaches qr_credentials_enforce_lifecycle_trigger(), testing
// an unrelated CHECK-constraint failure instead of the trigger's own
// controlled rejection. Scanning for a genuine gap avoids ever producing
// an out-of-range value.
async function findUnusedKeyVersion(): Promise<number> {
  const { data: rows, error } = await admin
    .from('qr_encryption_key_registry')
    .select('key_version')
    .order('key_version', { ascending: true });
  if (error) throw new Error(`Failed to list registered key versions: ${error.message}`);
  const registered = new Set((rows ?? []).map((r) => r.key_version));
  for (let candidate = 1; candidate <= 32767; candidate++) {
    if (!registered.has(candidate)) return candidate;
  }
  throw new Error('findUnusedKeyVersion: every version in 1..32767 is already registered — no unused key version is available for this test precondition.');
}

afterAll(async () => {
  if (cleanupCredentialIds.length > 0) {
    await admin.from('qr_credentials').delete().in('id', cleanupCredentialIds);
  }
  if (cleanupApplicationIds.length > 0) {
    await admin.from('applications').delete().in('id', cleanupApplicationIds);
  }
  await Promise.allSettled(cleanupUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('qr_credentials_enforce_lifecycle_trigger — actor semantics (correction 1)', () => {
  it('accepts a participant_self_service insert with issued_by null', async () => {
    const fx = await createCredentialFixture();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'participant_self_service',
      issued_by: null,
    });
    expect(error).toBeNull();

    const { data } = await admin.from('qr_credentials').select('issued_by').eq('id', fx.credentialId).single();
    expect(data!.issued_by).toBeNull();
  });

  // The actual regression this correction targets: the previous trigger
  // draft mis-grouped the 'system' channel with the staff channels
  // (issuance_channel <> 'participant_self_service' => require issued_by),
  // which would have wrongly rejected this legal insert.
  it('accepts a system-channel insert with issued_by null', async () => {
    const fx = await createCredentialFixture();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(error).toBeNull();

    const { data } = await admin.from('qr_credentials').select('issued_by').eq('id', fx.credentialId).single();
    expect(data!.issued_by).toBeNull();
  });

  it('rejects a staff_individual insert with issued_by left null', async () => {
    const fx = await createCredentialFixture();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'staff_individual',
      issued_by: null,
    });
    expectTriggerRejection(error, 'staff_individual channel rows must have a non-null issued_by');
  });
});

describe('qr_credentials_enforce_lifecycle_trigger — authorized-role validation (correction 2)', () => {
  it('rejects issued_by naming a profile without an authorized staff role', async () => {
    const fx = await createCredentialFixture();
    const nonStaffActor = await createStaffActor('participant');
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'staff_individual',
      issued_by: nonStaffActor.profileId,
    });
    expectTriggerRejection(error, 'issued_by must reference a profile with an authorized staff role');
  });

  it('accepts issued_by naming an authorized program_attendance_manager profile', async () => {
    const fx = await createCredentialFixture();
    const staffActor = await createStaffActor('program_attendance_manager');
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'staff_individual',
      issued_by: staffActor.profileId,
    });
    expect(error).toBeNull();

    const { data } = await admin.from('qr_credentials').select('issued_by').eq('id', fx.credentialId).single();
    expect(data!.issued_by).toBe(staffActor.profileId);
  });

  it('accepts issued_by naming an authorized super_admin profile', async () => {
    const fx = await createCredentialFixture();
    const staffActor = await createStaffActor('super_admin');
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'staff_bulk',
      issued_by: staffActor.profileId,
    });
    expect(error).toBeNull();
  });

  it('rejects revoked_by naming a profile without an authorized staff role on the active -> revoked transition', async () => {
    const fx = await createCredentialFixture();
    const nonStaffActor = await createStaffActor('participant');
    const { error: insertError } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(insertError).toBeNull();

    const { error } = await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: nonStaffActor.profileId,
        revocation_reason_code: 'administrative_correction',
        token_ciphertext: null,
        encryption_key_version: null,
      })
      .eq('id', fx.credentialId);
    expectTriggerRejection(error, 'revoked_by must reference a profile with an authorized staff role');
  });

  it('accepts revoked_by naming an authorized staff profile on the active -> revoked transition', async () => {
    const fx = await createCredentialFixture();
    const staffActor = await createStaffActor('super_admin');
    const { error: insertError } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(insertError).toBeNull();

    const { error } = await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: staffActor.profileId,
        revocation_reason_code: 'administrative_correction',
        token_ciphertext: null,
        encryption_key_version: null,
      })
      .eq('id', fx.credentialId);
    expect(error).toBeNull();
  });

  // qr_credentials_replacement_same_application_fkey (§1.2) requires the
  // replacement target to share the OLD row's application_id, enforced via
  // a deferred composite FK resolved only at commit. The real finalizer
  // satisfies this by updating the OLD row and inserting the NEW row in
  // ONE transaction; PostgREST/Supabase JS cannot span a transaction
  // across two separate REST calls (the first call's own UPDATE would
  // commit — and fail the deferred FK check — before a second call's
  // INSERT ever ran; reversing the order instead fails
  // qr_credentials_one_active_per_application). These tests therefore
  // drive both statements through test_only_replace_qr_credential_same_application
  // (§5.2c), a test-only security definer helper that performs exactly the
  // same two-statement transaction the real finalizer's inner block does.
  it('rejects replaced_by naming a profile without an authorized staff role on the active -> replaced transition', async () => {
    const oldFx = await createCredentialFixture();
    const nonStaffActor = await createStaffActor('participant');
    const newCredentialId = randomUUID();
    cleanupCredentialIds.push(newCredentialId);

    const { error: oldInsertError } = await admin.from('qr_credentials').insert({
      id: oldFx.credentialId,
      application_id: oldFx.applicationId,
      token_hash: oldFx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(oldInsertError).toBeNull();

    const { error } = await admin.rpc('test_only_replace_qr_credential_same_application', {
      p_old_credential_id: oldFx.credentialId,
      p_new_credential_id: newCredentialId,
      p_new_token_hash: randomTokenHash(),
      p_new_token_ciphertext: toBytea(validEnvelope()),
      p_new_encryption_key_version: await getActiveKeyVersion(),
      p_replaced_by: nonStaffActor.profileId,
      p_reissue_channel: 'staff_individual',
      p_reissue_reason_code: 'staff_assisted_recovery',
    });
    expectTriggerRejection(error, 'replaced_by must reference a profile with an authorized staff role');
  });

  it('accepts replaced_by naming an authorized staff profile on the active -> replaced transition', async () => {
    const oldFx = await createCredentialFixture();
    const staffActor = await createStaffActor('program_attendance_manager');
    const newCredentialId = randomUUID();
    cleanupCredentialIds.push(newCredentialId);

    const { error: oldInsertError } = await admin.from('qr_credentials').insert({
      id: oldFx.credentialId,
      application_id: oldFx.applicationId,
      token_hash: oldFx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(oldInsertError).toBeNull();

    const { error } = await admin.rpc('test_only_replace_qr_credential_same_application', {
      p_old_credential_id: oldFx.credentialId,
      p_new_credential_id: newCredentialId,
      p_new_token_hash: randomTokenHash(),
      p_new_token_ciphertext: toBytea(validEnvelope()),
      p_new_encryption_key_version: await getActiveKeyVersion(),
      p_replaced_by: staffActor.profileId,
      p_reissue_channel: 'staff_individual',
      p_reissue_reason_code: 'staff_assisted_recovery',
    });
    expect(error).toBeNull();

    const { data } = await admin.from('qr_credentials').select('replaced_by, replaced_by_credential_id').eq('id', oldFx.credentialId).single();
    expect(data!.replaced_by).toBe(staffActor.profileId);
    expect(data!.replaced_by_credential_id).toBe(newCredentialId);

    const { data: newRow } = await admin.from('qr_credentials').select('application_id').eq('id', newCredentialId).single();
    expect(newRow!.application_id).toBe(oldFx.applicationId);
  });

  // system-channel replacement gap (correction 1, replaced_by side):
  // qr_credentials_self_service_reissue_has_no_actor (§1.2) only excludes
  // reissue_channel = 'participant_self_service', not 'system' — the
  // trigger must reject a non-null replaced_by on a system-channel
  // reissue explicitly, since the CHECK constraint alone would not.
  it('rejects a system reissue_channel replacement with a non-null replaced_by', async () => {
    const oldFx = await createCredentialFixture();
    const staffActor = await createStaffActor('super_admin');
    const newCredentialId = randomUUID();
    cleanupCredentialIds.push(newCredentialId);

    const { error: oldInsertError } = await admin.from('qr_credentials').insert({
      id: oldFx.credentialId,
      application_id: oldFx.applicationId,
      token_hash: oldFx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(oldInsertError).toBeNull();

    const { error } = await admin.rpc('test_only_replace_qr_credential_same_application', {
      p_old_credential_id: oldFx.credentialId,
      p_new_credential_id: newCredentialId,
      p_new_token_hash: randomTokenHash(),
      p_new_token_ciphertext: toBytea(validEnvelope()),
      p_new_encryption_key_version: await getActiveKeyVersion(),
      p_replaced_by: staffActor.profileId, // non-null on a 'system' reissue — illegal
      p_reissue_channel: 'system',
      p_reissue_reason_code: 'staff_assisted_recovery',
    });
    expectTriggerRejection(error, 'system reissue_channel rows must have replaced_by null');
  });

  it('rejects a replacement target credential belonging to a different application, and fully rolls back the old row', async () => {
    // Exercises qr_credentials_replacement_same_application_fkey directly
    // (this round's correction), independent of the trigger's own
    // replaced_by/reissue_channel checks — a completely valid staff actor
    // and reissue_channel are used here so any rejection can only be
    // attributed to the composite FK, not to correction 1/2's checks.
    const oldFx = await createCredentialFixture();
    const otherApplicationFx = await createCredentialFixture();
    const staffActor = await createStaffActor('program_attendance_manager');
    const originalCiphertext = toBytea(validEnvelope());
    const originalKeyVersion = await getActiveKeyVersion();

    const { error: oldInsertError } = await admin.from('qr_credentials').insert({
      id: oldFx.credentialId,
      application_id: oldFx.applicationId,
      token_hash: oldFx.tokenHash,
      token_ciphertext: originalCiphertext,
      encryption_key_version: originalKeyVersion,
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(oldInsertError).toBeNull();

    // A credential that already exists on a DIFFERENT application — the
    // composite FK must reject naming it as oldFx's replacement target
    // regardless of what the trigger's own actor checks would otherwise
    // allow.
    const { error: otherInsertError } = await admin.from('qr_credentials').insert({
      id: otherApplicationFx.credentialId,
      application_id: otherApplicationFx.applicationId,
      token_hash: otherApplicationFx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(otherInsertError).toBeNull();

    const { error } = await admin
      .from('qr_credentials')
      .update({
        status: 'replaced',
        replaced_at: new Date().toISOString(),
        replaced_by: staffActor.profileId,
        replaced_by_credential_id: otherApplicationFx.credentialId, // wrong application — must be rejected
        reissue_channel: 'staff_individual',
        reissue_reason_code: 'staff_assisted_recovery',
        token_ciphertext: null,
        encryption_key_version: null,
      })
      .eq('id', oldFx.credentialId);
    // qr_credentials_replacement_same_application_fkey is DEFERRABLE
    // INITIALLY DEFERRED, so it is not checked at the UPDATE statement
    // itself — it is checked at COMMIT. PostgREST wraps every single
    // request in its own implicit transaction (BEGIN; ...; COMMIT;) that
    // commits before the HTTP response is returned, so this ONE .update()
    // call's own commit is exactly where the deferred check fires; the
    // error below is genuinely the commit-time failure, not a same-
    // statement CHECK/unique-violation being mistaken for it (those would
    // carry codes 23514/23505, not 23503).
    expect(error, 'a cross-application replacement target must be rejected at commit').not.toBeNull();
    expect(error!.code).toBe('23503'); // foreign_key_violation — qr_credentials_replacement_same_application_fkey, resolved at this request's own implicit-transaction commit

    // The deferred FK failing at commit must roll back the ENTIRE
    // statement, including every column the UPDATE touched — not merely
    // leave replaced_by_credential_id unset while everything else the
    // UPDATE wrote (status, replaced_at, replaced_by, reissue_channel,
    // the ciphertext/key-version nulling) silently persists as a
    // half-applied transition. A single UPDATE statement is one atomic
    // unit in Postgres, but this is asserted directly rather than merely
    // assumed, exactly as the sibling decrypt-only-key test above asserts
    // its own rollback directly.
    const { data: oldRowAfter, error: selectError } = await admin
      .from('qr_credentials')
      .select('status, replaced_at, replaced_by, replaced_by_credential_id, reissue_channel, token_ciphertext, encryption_key_version')
      .eq('id', oldFx.credentialId)
      .single();
    expect(selectError).toBeNull();
    expect(oldRowAfter!.status, 'status must remain active — the UPDATE must have fully rolled back').toBe('active');
    expect(oldRowAfter!.replaced_at).toBeNull();
    expect(oldRowAfter!.replaced_by).toBeNull();
    expect(oldRowAfter!.replaced_by_credential_id).toBeNull();
    expect(oldRowAfter!.reissue_channel).toBeNull();
    expect(oldRowAfter!.token_ciphertext, 'token_ciphertext must remain non-null and unchanged').toBe(originalCiphertext);
    expect(oldRowAfter!.encryption_key_version, 'encryption_key_version must remain non-null and unchanged').toBe(originalKeyVersion);
  });
});

describe('qr_credentials_enforce_lifecycle_trigger — created_at = issued_at (correction 3)', () => {
  it('rejects an insert where created_at differs from issued_at', async () => {
    const fx = await createCredentialFixture();
    const now = new Date();
    const oneSecondEarlier = new Date(now.getTime() - 1000);
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
      created_at: now.toISOString(),
      issued_at: oneSecondEarlier.toISOString(),
    });
    expectTriggerRejection(error, 'created_at must equal issued_at on insert');
  });

  it('accepts an insert where created_at equals issued_at exactly', async () => {
    const fx = await createCredentialFixture();
    const now = new Date().toISOString();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
      created_at: now,
      issued_at: now,
    });
    expect(error).toBeNull();
  });
});

describe('qr_credentials_enforce_lifecycle_trigger — ciphertext envelope validation (correction 4)', () => {
  it('rejects a ciphertext envelope shorter than 61 bytes', async () => {
    const fx = await createCredentialFixture();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(envelopeOfLength(60)),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expectTriggerRejection(error, 'Invalid or malformed ciphertext envelope');
  });

  it('rejects a ciphertext envelope longer than 61 bytes', async () => {
    const fx = await createCredentialFixture();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(envelopeOfLength(62)),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expectTriggerRejection(error, 'Invalid or malformed ciphertext envelope');
  });

  it('rejects a correctly-sized envelope with an unsupported version byte', async () => {
    const fx = await createCredentialFixture();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(envelopeWithVersion(2)),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expectTriggerRejection(error, 'Unsupported ciphertext envelope version');
  });

  it('accepts a correctly-sized, version-1 envelope', async () => {
    const fx = await createCredentialFixture();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(error).toBeNull();
  });
});

const TEST_ONLY_ROLLBACK_SENTINEL = 'TEST_ONLY_ROLLBACK_SENTINEL: inactive-key probe completed as expected, rolling back';

describe('qr_credentials_enforce_lifecycle_trigger — active-key-version validation (correction 5)', () => {
  // Uses test_only_rotate_and_probe_inactive_key (test-only-setup.sql), a
  // single-transaction helper, rather than two separate PostgREST calls.
  // An earlier draft rotated via one .rpc() call and then attempted the
  // rejected insert via a second, separate .rpc()/.insert() call — the
  // rotation COMMITTED (its own PostgREST request is its own transaction)
  // before the rejected insert was ever attempted, so nothing about that
  // sequence was actually rollback-safe: a failed probe insert could never
  // have undone the already-committed rotation. This version performs the
  // capture, rotation, probe insert, and a documented sentinel RAISE all
  // inside ONE transaction (the helper function's own), so the ENTIRE
  // thing — rotation included — rolls back every time, regardless of
  // outcome, leaving the registry exactly as this test found it. The
  // sentinel is caught here and treated as the expected successful
  // outcome; any OTHER error propagating out of the RPC call is a genuine
  // test failure (the helper's own probe-insert branch re-raises anything
  // that isn't the exact expected trigger message, rather than swallowing
  // it).
  it('rejects an insert referencing a decrypt_only (non-active) key version, then rolls back the entire probe transaction including the rotation', async () => {
    // CORRECTED this round: a prior version tried to predict WHICH
    // temporary key version the helper would select (max(key_version) + 1,
    // computed client-side before the helper's own advisory lock was ever
    // acquired) purely to assert its post-rollback absence. That is an
    // external guess about an internal implementation detail — the
    // helper's own selection happens under a lock this client-side read
    // never holds, so the two are independent observations even in a
    // single-writer disposable test environment. Replaced with a full
    // ordered snapshot of the ENTIRE registry taken before and after the
    // call, compared field-by-field — this proves the rotation left no
    // trace at all, without needing to know or predict any specific
    // version number the helper picked internally.
    const selectSnapshot = () =>
      admin
        .from('qr_encryption_key_registry')
        .select('key_version, status, activated_at, retired_at')
        .order('key_version', { ascending: true });

    const { data: snapshotBefore, error: snapshotBeforeError } = await selectSnapshot();
    expect(snapshotBeforeError, 'the before-snapshot query itself must not error').toBeNull();
    expect(snapshotBefore, 'the before-snapshot must return rows').not.toBeNull();

    const probeCredentialId = randomUUID();
    const probeFx = await createCredentialFixture();

    const { error } = await admin.rpc('test_only_rotate_and_probe_inactive_key', {
      p_credential_id: probeCredentialId,
      p_application_id: probeFx.applicationId,
      p_token_hash: randomTokenHash(),
      p_token_ciphertext: toBytea(validEnvelope()),
    });

    // The sentinel IS the expected, successful outcome here — it proves
    // the probe insert was correctly rejected before the transaction
    // unconditionally rolled back. Exact SQLSTATE and exact message, not
    // merely toContain — a substring match could pass on an unrelated
    // error that happens to contain overlapping text. Any other error
    // (including the three failure-mode raises inside the helper itself:
    // "no active key version found", "probe insert unexpectedly
    // succeeded", "probe insert did not reach the expected rejection")
    // must fail this test, not be treated as a pass.
    expect(error, 'expected the documented rollback sentinel, got no error at all').not.toBeNull();
    expect(error!.code).toBe('P0001');
    expect(error!.message).toBe(TEST_ONLY_ROLLBACK_SENTINEL);

    // Verify the ENTIRE transaction rolled back, not merely that an error
    // was returned. Every query below checks `error` first, before
    // inspecting `data` — a query/permission/connection/schema-cache
    // error must never be silently read as "the row doesn't exist" or
    // "nothing changed."
    const { data: snapshotAfter, error: snapshotAfterError } = await selectSnapshot();
    expect(snapshotAfterError, 'the after-snapshot query itself must not error').toBeNull();
    expect(snapshotAfter, 'the after-snapshot must return rows').not.toBeNull();

    // Exact equality of the full ordered snapshot — same row count, same
    // key_version set, same status/activated_at/retired_at for every row,
    // in the same order. This directly proves the rotation (which would
    // have added exactly one new row and changed the original row's
    // status/activated_at) left no trace whatsoever, without needing to
    // predict which temporary version the helper chose internally.
    expect(snapshotAfter, 'the entire key-registry snapshot must be byte-for-byte identical before and after the rolled-back probe transaction').toEqual(snapshotBefore);

    const { data: probeCredentialRow, error: probeCredentialRowError } = await admin
      .from('qr_credentials')
      .select('id')
      .eq('id', probeCredentialId)
      .maybeSingle();
    expect(probeCredentialRowError, 'the probe-credential existence check itself must not error').toBeNull();
    expect(probeCredentialRow, 'the probe credential must not exist — its (rejected) insert attempt must have rolled back with the rest of the transaction').toBeNull();
  });

  // A retired (not merely decrypt_only) key version is deliberately NOT
  // covered here: is_encryption_key_version_active() returns false for
  // BOTH decrypt_only and retired identically — the trigger has exactly
  // one branch that rejects "not active," with no way to distinguish
  // which of the two non-active statuses it was, so a retired-key insert
  // would exercise the exact same trigger branch as the decrypt_only test
  // above, adding no new trigger coverage. retire_encryption_key_version
  // (§1.6) also requires an auth.uid()-resolved super_admin SESSION (not
  // the service_role admin client this file otherwise uses throughout),
  // meaning a retired-key test would need a separate signInWithPassword
  // flow (this repo's real pattern, e.g.
  // tests/allocation/authorization.test.ts) purely to reach a registry
  // state the trigger cannot distinguish from decrypt_only. Left out of
  // Sub-pass 1 for that reason; listed as a deferred item.

  it('accepts an insert referencing the current active key version', async () => {
    const fx = await createCredentialFixture();
    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(error).toBeNull();
  });

  // Added this round: proves is_encryption_key_version_active()'s
  // coalesce(v_status = 'active', false) fix (§1.6) actually works, and
  // proves the trigger's own controlled rejection is what fires — not an
  // unrelated foreign-key error. Before the fix, `return v_status =
  // 'active';` returned NULL (not false) when p_key_version matched no
  // row at all, and the trigger's `if not
  // is_encryption_key_version_active(...)` treated `not NULL` as NULL —
  // never entering the rejection branch — so an UNRECOGNIZED key version
  // (distinct from a recognized-but-non-active one, which the
  // decrypt_only test above covers) would have silently skipped this
  // check and fallen through to whatever the rest of the INSERT produced
  // instead. There is deliberately no foreign key from
  // qr_credentials.encryption_key_version to
  // qr_encryption_key_registry.key_version in this schema (§1.2), so
  // without the trigger's own check, an unknown key version would not
  // even hit a foreign-key error — it would simply be accepted, which is
  // the actual bug this test guards against.
  it('rejects an insert referencing a key version that does not exist in the registry at all', async () => {
    const fx = await createCredentialFixture();
    const unknownKeyVersion = await findUnusedKeyVersion();

    const { error } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: unknownKeyVersion,
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expectTriggerRejection(error, 'encryption_key_version must be an active key version');
  });
});

describe('qr_credentials_enforce_lifecycle_trigger — ON DELETE SET NULL remains permitted (checklist item)', () => {
  it('permits issued_by to transition to null after the owning profile is deleted, post-issuance', async () => {
    const fx = await createCredentialFixture();
    const staffActor = await createStaffActor('program_attendance_manager');
    const { error: insertError } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'staff_individual',
      issued_by: staffActor.profileId,
    });
    expect(insertError).toBeNull();

    // Deleting the auth user cascades to profiles (on delete cascade, per
    // roles_and_profiles.sql), which in turn fires qr_credentials.issued_by's
    // own `on delete set null` — a real ON DELETE SET NULL, not a
    // hand-simulated UPDATE, so this exercises the actual FK action path.
    const { error: deleteError } = await admin.auth.admin.deleteUser(staffActor.profileId);
    expect(deleteError).toBeNull();

    const { data } = await admin.from('qr_credentials').select('issued_by').eq('id', fx.credentialId).single();
    expect(data!.issued_by).toBeNull();
  });

  it('permits revoked_by to transition to null after the revoking staff profile is deleted, post-revocation', async () => {
    const fx = await createCredentialFixture();
    const staffActor = await createStaffActor('super_admin');
    const { error: insertError } = await admin.from('qr_credentials').insert({
      id: fx.credentialId,
      application_id: fx.applicationId,
      token_hash: fx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(insertError).toBeNull();

    const { error: revokeError } = await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: staffActor.profileId,
        revocation_reason_code: 'administrative_correction',
        token_ciphertext: null,
        encryption_key_version: null,
      })
      .eq('id', fx.credentialId);
    expect(revokeError).toBeNull();

    const { error: deleteError } = await admin.auth.admin.deleteUser(staffActor.profileId);
    expect(deleteError).toBeNull();

    const { data } = await admin.from('qr_credentials').select('revoked_by').eq('id', fx.credentialId).single();
    expect(data!.revoked_by).toBeNull();
  });

  it('permits replaced_by to transition to null after the replacing staff profile is deleted, post-replacement', async () => {
    const oldFx = await createCredentialFixture();
    const staffActor = await createStaffActor('program_attendance_manager');
    const newCredentialId = randomUUID();
    cleanupCredentialIds.push(newCredentialId);

    const { error: oldInsertError } = await admin.from('qr_credentials').insert({
      id: oldFx.credentialId,
      application_id: oldFx.applicationId,
      token_hash: oldFx.tokenHash,
      token_ciphertext: toBytea(validEnvelope()),
      encryption_key_version: await getActiveKeyVersion(),
      status: 'active',
      issuance_channel: 'system',
      issued_by: null,
    });
    expect(oldInsertError).toBeNull();

    const { error: replaceError } = await admin.rpc('test_only_replace_qr_credential_same_application', {
      p_old_credential_id: oldFx.credentialId,
      p_new_credential_id: newCredentialId,
      p_new_token_hash: randomTokenHash(),
      p_new_token_ciphertext: toBytea(validEnvelope()),
      p_new_encryption_key_version: await getActiveKeyVersion(),
      p_replaced_by: staffActor.profileId,
      p_reissue_channel: 'staff_individual',
      p_reissue_reason_code: 'staff_assisted_recovery',
    });
    expect(replaceError).toBeNull();

    const { error: deleteError } = await admin.auth.admin.deleteUser(staffActor.profileId);
    expect(deleteError).toBeNull();

    const { data } = await admin.from('qr_credentials').select('replaced_by').eq('id', oldFx.credentialId).single();
    expect(data!.replaced_by).toBeNull();
  });
});
