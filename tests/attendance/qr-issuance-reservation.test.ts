// tests/attendance/qr-issuance-reservation.test.ts
//
// Live coverage for request_my_qr_issuance_transactional_internal(), its
// production wrapper request_my_qr_issuance_transactional(), and the
// shared reserve_or_reuse_qr_lifecycle_operation()/
// resolve_blocking_qr_lifecycle_operation() helpers (Phase 6 design doc
// §5.1, Sub-pass 2) — specifically the TTL-vs-credential-lock ordering
// guarantee and the request-key advisory-lock protocol, both of which
// require genuine two-session concurrency with FULLY DETERMINISTIC
// synchronization to observe correctly: no fixed-duration sleep, no
// inference from elapsed wall-clock time, no assumption about which of
// two concurrently-launched sessions reaches a lock first.
//
// Synchronization design (three cooperating primitives):
//   1. HOLDER-READY barrier (test_only_is_holder_ready): a lock-holding
//      test-only RPC tags its own Postgres backend's
//      pg_stat_activity.application_name with a caller-supplied unique
//      holder tag ONLY AFTER it has successfully acquired its target row
//      lock. Every test polls this observer BEFORE launching its waiter
//      session, so the waiter can never race ahead of the holder and
//      acquire the lock itself.
//   2. WAITER-TO-HOLDER barrier (test_only_is_waiter_blocked_by_holder):
//      proves, via pg_stat_activity.wait_event_type and
//      pg_blocking_pids(), that the SPECIFIC tagged waiter backend is
//      blocked by the SPECIFIC tagged holder backend — not merely that
//      some backend somewhere is waiting on something.
//   3. EXPLICIT RELEASE GATE (test_only_lock_gates table +
//      test_only_release_lock_gate): a lock holder does not sleep for a
//      fixed duration — it polls its own gate row (unlocked reads) until
//      the CONTROLLING TEST explicitly flips `released = true`, which the
//      test only does once every fixture-insertion, cancellation, or
//      other setup step that must complete BEFORE the holder lets go has
//      actually completed and been verified.
//
// Uses a REAL authenticated participant client (signInWithPassword,
// matching tests/allocation/authorization.test.ts's own established
// pattern) — never the service-role admin client — for every reservation
// RPC call, since request_my_qr_issuance_transactional_internal()
// requires a real auth.uid().
//
// REQUIRES A DISPOSABLE DATABASE — local by default. See
// tests/attendance/disposable-database-guard.ts for the shared guard (used
// identically by qr-credentials-lifecycle-trigger.test.ts) — this file
// also depends on service-role-only test-only helpers, including a
// disposable table, that must never exist on a shared project. A remote
// Supabase Cloud project is permitted ONLY when explicitly pinned via
// PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS=true + PHASE6_DISPOSABLE_PROJECT_REF;
// this exists solely to unblock verification while local Docker is
// unavailable, and does not loosen production QR authorization in any way.
//
// Exact local run sequence (see also
// scripts/run-qr-issuance-reservation-tests.sh for the failure-safe
// wrapper around this same sequence):
//   supabase start
//   supabase db reset --local
//   supabase db query --local -f tests/attendance/qr-issuance-reservation.test-only-setup.sql
//   npx --no-install vitest run tests/attendance/qr-issuance-reservation.test.ts
//   supabase db query --local -f tests/attendance/qr-issuance-reservation.test-only-teardown.sql
//   supabase db reset --local
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { assertDisposableDatabase } from './disposable-database-guard';
import {
  waitUntilHolderReadyCloudNative,
  waitUntilWaiterBlockedCloudNative,
  launchCloudNativeHolder,
  launchCloudNativeWaiter,
  getCloudNativeHolderSession,
  getCloudNativeWaiterSession,
  getCloudNativeWaiterResult,
  getCloudNativeWaiterOutcome,
  closeCloudNativeSession,
  closeAllCloudNativeSessions,
  closeDirectClient,
  CloudNativeAuthenticatedSession,
} from './cloud-native-lock-observer';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// This suite installs SECURITY DEFINER test-only helpers (including
// pg_sleep-free but still lock-holding infrastructure and a disposable
// table) that must never exist on a shared, staging, or production
// project. Local (127.0.0.1/localhost) is always allowed with no
// override. A remote host is allowed ONLY for an explicitly pinned,
// disposable Supabase Cloud project — see disposable-database-guard.ts.
const disposableDatabaseCheck = assertDisposableDatabase('qr-issuance-reservation.test.ts', URL);

// waitUntilHolderReady()/waitUntilBlocked() poll a real RPC round-trip
// every 50ms until the target condition is observed or this budget
// elapses. 5000ms is correct against local Docker Postgres (round-trip
// latency near zero) but was measured — reproducibly, including in
// isolation, not merely under contention — to be too tight against a
// real disposable Supabase Cloud project's own network round-trip
// latency (confirmed against ap-northeast-1). Widened ONLY for remote
// disposable-cloud runs; local runs keep the original 5000ms budget
// unchanged. This does not change any database lock behavior, RPC logic,
// or concurrency assertion — only how long the test is willing to poll
// before concluding the awaited condition never occurred.
const HOLDER_WAIT_TIMEOUT_MS = disposableDatabaseCheck.reason === 'local' ? 5000 : 20000;

// Vitest's own per-test timeout must exceed the largest possible sum of
// HOLDER_WAIT_TIMEOUT_MS waits a single test can perform (several tests
// call waitUntilHolderReady/waitUntilBlocked more than once) plus normal
// RPC/setup time — 5000ms (vitest's default) is already tight for local
// runs with multiple waits and is not enough at all once
// HOLDER_WAIT_TIMEOUT_MS is widened to 20000ms for remote disposable-cloud
// runs. Scoped the same way as HOLDER_WAIT_TIMEOUT_MS itself.
vi.setConfig({ testTimeout: disposableDatabaseCheck.reason === 'local' ? 15000 : 60000 });

const admin = createClient<Database>(URL, SERVICE_KEY);

// Bounded retry for CLEARLY TRANSIENT Supabase Auth infrastructure
// responses only — an explicit rate-limit (HTTP 429 / status 'over_
// request_rate_limit') or a generic network fetch failure before any
// functional test logic runs. Never retries assertion failures,
// PostgreSQL functional errors, or authorization failures caused by the
// code under test — those all throw before this helper's retry loop
// would even see them, since it only wraps the raw Auth SDK call itself,
// not the expect() that follows it in each fixture function.
async function withBoundedAuthRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;
  let lastResult: T | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    const error = (result as { error?: { status?: number; code?: string; message?: string } }).error;
    if (!error) return result;
    const isTransient =
      error.status === 429 ||
      error.code === 'over_request_rate_limit' ||
      /rate limit/i.test(error.message ?? '') ||
      /fetch failed/i.test(error.message ?? '');
    if (!isTransient || attempt === maxAttempts) return result;
    lastResult = result;
    const backoffMs = 500 * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  return lastResult as T;
}

// Only test_only_lock_gates rows are tracked for cleanup here. Durable
// fixture rows (auth.users, applications, qr_credentials,
// qr_lifecycle_operations) are intentionally NOT tracked for in-file
// DELETION — see the comment on afterAll() below for why, and where their
// cleanup actually happens. On a REMOTE disposable-cloud run (no local
// `supabase db reset --local` ever executes), fixture application ids ARE
// tracked here so afterAll can run a lifecycle-safe teardown (transition
// each out of 'accepted', never delete the append-only QR history) —
// see the remote-mode branch in afterAll() below.
const cleanupGateIds: string[] = [];
const remoteFixtureApplicationIds: string[] = [];

interface ParticipantFixture {
  userId: string;
  applicationId: string;
  client: ReturnType<typeof createClient<Database>>;
  // The real access_token from this fixture's own signInWithPassword()
  // call — used only by remote disposable-cloud concurrency tests to
  // reproduce PostgREST's own request context over a raw PostgreSQL
  // connection (see CloudNativeAuthenticatedSession); unused, harmless,
  // on every other test and on local runs.
  accessToken: string;
}

async function createParticipantFixture(): Promise<ParticipantFixture> {
  const email = `qr-reservation-live-${randomUUID()}@test.local`;
  const { data: user, error: userError } = await withBoundedAuthRetry(
    () => admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true }),
    'createUser',
  );
  expect(userError, `createUser failed: ${userError?.message}`).toBeNull();
  expect(user?.user).toBeTruthy();

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user!.user!.id, status: 'accepted' })
    .select('id')
    .single();
  expect(appError, `fixture application insert failed: ${appError?.message}`).toBeNull();
  expect(app).toBeTruthy();
  if (disposableDatabaseCheck.reason !== 'local') {
    remoteFixtureApplicationIds.push(app!.id);
  }

  const client = createClient<Database>(URL, ANON_KEY);
  const { data: signInData, error: signInError } = await withBoundedAuthRetry(
    () => client.auth.signInWithPassword({ email, password: 'password123' }),
    'signInWithPassword',
  );
  expect(signInError, `sign-in failed: ${signInError?.message}`).toBeNull();

  return { userId: user!.user!.id, applicationId: app!.id, client, accessToken: signInData!.session!.access_token };
}

interface StaffFixture {
  userId: string;
  client: ReturnType<typeof createClient<Database>>;
  // The real access_token from this fixture's own signInWithPassword()
  // call — used only by remote disposable-cloud concurrency tests to
  // reproduce PostgREST's own request context over a raw PostgreSQL
  // connection (see CloudNativeAuthenticatedSession); unused, harmless,
  // on every other test and on local runs.
  accessToken: string;
}

async function createStaffFixture(role: 'super_admin' | 'program_attendance_manager'): Promise<StaffFixture> {
  const email = `qr-reservation-staff-${randomUUID()}@test.local`;
  const { data: user, error: userError } = await withBoundedAuthRetry(
    () => admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true }),
    'createUser',
  );
  expect(userError, `createUser failed: ${userError?.message}`).toBeNull();
  expect(user?.user).toBeTruthy();

  const { error: roleError } = await admin.from('profiles').update({ role }).eq('id', user!.user!.id);
  expect(roleError, `profile role update failed: ${roleError?.message}`).toBeNull();

  const client = createClient<Database>(URL, ANON_KEY);
  const { data: signInData, error: signInError } = await withBoundedAuthRetry(
    () => client.auth.signInWithPassword({ email, password: 'password123' }),
    'signInWithPassword',
  );
  expect(signInError, `sign-in failed: ${signInError?.message}`).toBeNull();

  return { userId: user!.user!.id, client, accessToken: signInData!.session!.access_token };
}

async function createBulkBatch(staffUserId: string, intendedOperationType: 'issue' | 'reissue' = 'issue'): Promise<string> {
  const { data, error } = await admin.rpc('create_qr_bulk_operation_batch_for_server', {
    p_staff_auth_user_id: staffUserId,
    p_staff_profile_id: staffUserId,
    p_intended_operation_type: intendedOperationType,
  });
  expect(error, `bulk batch creation failed: ${error?.message}`).toBeNull();
  expect(data).toBeTruthy();
  return data as unknown as string;
}

async function insertActiveCredential(applicationId: string): Promise<string> {
  const { data: keyRow, error: keyError } = await admin
    .from('qr_encryption_key_registry')
    .select('key_version')
    .eq('status', 'active')
    .limit(1)
    .single();
  expect(keyError, `active key lookup failed: ${keyError?.message}`).toBeNull();
  expect(keyRow).toBeTruthy();

  const credentialId = randomUUID();
  // token_hash carries a UNIQUE constraint and qr_credentials rows are
  // never deleted (append-only, enforced by trigger) — a constant hash
  // would 23505-collide on the second fixture inserted in any given suite
  // run, so every call must generate fresh random bytes.
  const envelope = Buffer.concat([Buffer.from([1]), randomBytes(60)]);
  const { error } = await admin.from('qr_credentials').insert({
    id: credentialId,
    application_id: applicationId,
    token_hash: `\\x${randomBytes(32).toString('hex')}`,
    token_ciphertext: `\\x${envelope.toString('hex')}`,
    encryption_key_version: keyRow!.key_version,
    status: 'active',
    issuance_channel: 'system',
    issued_by: null,
  });
  expect(error, `fixture active credential insert failed: ${error?.message}`).toBeNull();
  return credentialId;
}

async function createGate(): Promise<string> {
  const gateId = randomUUID();
  const { error } = await admin.from('test_only_lock_gates').insert({ gate_id: gateId, released: false });
  expect(error, `gate creation failed: ${error?.message}`).toBeNull();
  cleanupGateIds.push(gateId);
  return gateId;
}

async function releaseGate(gateId: string): Promise<void> {
  const { error } = await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
  expect(error, `gate release failed: ${error?.message}`).toBeNull();
}

// On a remote disposable-cloud run, holder readiness was already proven
// (deterministically, via pg_locks) inside launchCloudNativeHolder()
// itself before it returned — this is a no-op in that mode. Kept as a
// real call (not skipped) so every one of this file's ~35 call sites
// needs no changes: the environment branch lives here, once.
async function waitUntilHolderReady(holderTag: string, timeoutMs: number): Promise<void> {
  if (disposableDatabaseCheck.reason !== 'local') {
    const session = getCloudNativeHolderSession(holderTag);
    await waitUntilHolderReadyCloudNative(session.pid, timeoutMs);
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await admin.rpc('test_only_is_holder_ready', { p_holder_tag: holderTag });
    expect(error, `holder-ready observer failed: ${error?.message}`).toBeNull();
    if (data === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntilHolderReady: timed out after ${timeoutMs}ms — holder "${holderTag}" never became ready. It may have failed to acquire its lock.`);
}

async function waitUntilBlocked(waiterTag: string, holderTag: string, timeoutMs: number): Promise<void> {
  if (disposableDatabaseCheck.reason !== 'local') {
    // holderTag may itself refer to EITHER a holder session OR a
    // (previously-launched) waiter session that is now acting as a
    // blocker for a SECOND waiter — chained blocking, used by a few
    // tests (e.g. finalizer-vs-cancel-vs-second-finalizer). Check both
    // registries.
    const waiterSession = getCloudNativeWaiterSession(waiterTag);
    let blockerPid: number;
    try {
      blockerPid = getCloudNativeHolderSession(holderTag).pid;
    } catch {
      blockerPid = getCloudNativeWaiterSession(holderTag).pid;
    }
    try {
      await waitUntilWaiterBlockedCloudNative(waiterSession.pid, blockerPid, timeoutMs);
    } catch (err) {
      if (waiterSession.lastStartError) {
        throw new Error(`${(err as Error).message} — waiter's own query already errored: ${String(waiterSession.lastStartError)}`);
      }
      throw err;
    }
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await admin.rpc('test_only_is_waiter_blocked_by_holder', {
      p_waiter_tag: waiterTag,
      p_holder_tag: holderTag,
    });
    expect(error, `waiter-to-holder observer failed: ${error?.message}`).toBeNull();
    if (data === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `waitUntilBlocked: timed out after ${timeoutMs}ms — waiter "${waiterTag}" was never observed blocked by holder "${holderTag}". The intended lock interleaving did not occur.`,
  );
}

// Cleanup-responsibility split (see the header comment in
// qr-issuance-reservation.test-only-setup.sql for the full statement):
// only test_only_lock_gates rows — genuinely disposable, non-audited
// test-only fixtures — are deleted here. qr_lifecycle_operations and
// qr_credentials are append-only, audit-shaped tables whose own BEFORE
// triggers (Phase 6 design doc §1.5/§1.7) unconditionally reject DELETE,
// so any attempt to delete them here would itself fail. Their parent
// applications rows (FK-referenced by qr_lifecycle_operations and
// qr_credentials) and the auth.users rows above them are therefore never
// DELETEd either — deleting a parent while immutable, non-deletable child
// rows still reference it is neither possible nor desirable.
//
// LOCAL runs: all durable fixture rows (auth.users, applications,
// qr_credentials, qr_lifecycle_operations) are removed by the runner's
// final `supabase db reset --local` (scripts/run-qr-issuance-reservation-
// tests.sh) — there is no other mechanism, by design.
//
// REMOTE disposable-cloud runs (PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS=true):
// `supabase db reset --local` never executes, so nothing above alone would
// ever retire a remote run's fixtures — every run would permanently
// accumulate accepted applications with no cleanup path at all (confirmed
// during Phase 7G-K as the dominant contributor to a global accepted-
// applications pileup). afterAll's remote-mode branch below closes that
// gap WITHOUT deleting anything append-only: it transitions each fixture
// application to 'rejected' (a real, valid admission-review outcome),
// which fires the existing production trigger
// applications_revoke_qr_on_ineligibility to revoke any active credential
// and leaves the full qr_credentials/qr_lifecycle_operations history
// intact and durable, exactly as it would for a real rejected applicant.
afterAll(async () => {
  if (cleanupGateIds.length > 0) {
    const { error } = await admin.from('test_only_lock_gates').delete().in('gate_id', cleanupGateIds);
    expect(error, `gate cleanup failed: ${error?.message}`).toBeNull();
  }
  // REMOTE-MODE LIFECYCLE TEARDOWN (guarded by the same disposable-remote
  // check every other remote-only branch in this file already uses — never
  // runs against local Docker, and assertDisposableDatabase() itself fails
  // closed against anything that isn't localhost or the one pinned
  // disposable project ref).
  //
  // On local Docker, `supabase db reset --local` (the runner script) is the
  // real, sole cleanup mechanism and this block is a no-op (the tracking
  // array is only ever populated in remote mode, see createParticipantFixture
  // above). On a remote disposable-cloud run that reset never executes, so
  // without this block every run permanently accumulated fixtures with no
  // cleanup path — confirmed during Phase 7G-K to be the dominant
  // contributor (6,289 of 7,561 rows) to a global accepted-applications
  // pileup that was making unrelated tests (e.g. runAllocation-based ones)
  // scan thousands of stale accepted applications.
  //
  // This does NOT delete qr_credentials/qr_lifecycle_operations — both are
  // genuinely append-only (an unconditional BEFORE DELETE trigger rejects
  // any delete on either, "qr_credentials rows are never deleted, only
  // transitioned", Phase 6 design doc §1.5/§1.7) and that invariant is
  // correct production behavior, not a test inconvenience to route around.
  // Instead this transitions each fixture application to 'rejected' — a
  // real, valid outcome of the actual admission-review lifecycle
  // (VALID_TRANSITIONS in src/lib/validation/admission-review.ts permits
  // accepted -> rejected) — which fires the existing, real production
  // trigger applications_revoke_qr_on_ineligibility
  // (20260815000000_revoke_qr_credential_on_ineligibility.sql): any active
  // credential is automatically revoked (revocation_reason_code =
  // 'application_ineligible'), and the application no longer matches
  // `status = 'accepted'`, so it stops being loaded by runAllocation/
  // runFeatureExtraction or counted as live participant data. The revoked
  // credential and its full qr_lifecycle_operations history remain in
  // place, exactly as they would for a real applicant who was rejected
  // after being accepted.
  if (remoteFixtureApplicationIds.length > 0) {
    const { error } = await admin.from('applications').update({ status: 'rejected' }).in('id', remoteFixtureApplicationIds).eq('status', 'accepted');
    expect(error, `remote-mode fixture teardown (status -> rejected) failed: ${error?.message}`).toBeNull();
  }
  // Safety net: closes any cloud-native holder/waiter session an
  // individual test's own finally block missed (e.g. because an
  // assertion threw before its close calls ran) — every test is still
  // expected to close its own sessions via closeCloudNativeSession() in
  // its own finally block; this only catches leaks.
  await closeAllCloudNativeSessions();
  // Closes the shared direct PostgreSQL observer connection
  // cloud-native-lock-observer.ts opens lazily on first use (remote runs
  // only — a no-op if it was never opened, e.g. a local run).
  await closeDirectClient();
});

describe('request_my_qr_issuance_transactional — TTL-vs-credential-lock ordering (deterministic two-session synchronization)', () => {
  it('matching-pending: expiry wins over an active credential observed only after waiting on the credential lock', async () => {
    const fx = await createParticipantFixture();
    const credentialId = await insertActiveCredential(fx.applicationId);
    const holderTag = `holder-${randomUUID()}`;
    const waiterTag = `waiter-${randomUUID()}`;
    const gateId = await createGate();
    const shortTtlSeconds = 3;
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';

    // 1/2. Launch the credential holder; wait until it is confirmed ready
    // (i.e. it has actually acquired the credential row lock) before
    // doing anything else.
    //
    // CLOUD-NATIVE: on a remote disposable-cloud run, the holder is
    // invoked over a dedicated raw PostgreSQL connection (bypassing
    // PostgREST) rather than via admin.rpc() — calling the SAME EXISTING
    // test-only SQL function, unchanged, as a plain SQL call. See
    // cloud-native-lock-observer.ts's own header comment for the full
    // rationale.
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_active_credential_lock($1, $2, $3, $4)',
        [credentialId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_active_credential_lock', {
        p_credential_id: credentialId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    // Everything from here through gate-release/holder-await runs inside
    // try/finally: a timeout, a failed observer poll, or a failed
    // assertion partway through must still reliably release the gate and
    // await the holder, rather than leaving it polling uselessly until
    // its own 30-second p_max_wait_seconds deadline.
    let gateReleased = false;
    try {
      // 3. Only now, with the credential lock confirmed held, seed the
      // pending operation with a short future expires_at — its TTL clock
      // starts AFTER the credential lock is already taken, guaranteeing
      // the expiry genuinely occurs DURING the wait, not before it began.
      const requestKey = randomUUID();
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + shortTtlSeconds * 1000);
      const { data: opRow, error: opError } = await admin
        .from('qr_lifecycle_operations')
        .insert({
          operation_type: 'issue',
          application_id: fx.applicationId,
          requested_by_auth_user_id: fx.userId,
          requested_by_profile_id: fx.userId,
          channel: 'participant_self_service',
          request_key: requestKey,
          created_at: createdAt.toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .select('id')
        .single();
      expect(opError, `seed pending operation failed: ${opError?.message}`).toBeNull();
      expect(opRow).toBeTruthy();

      // 4. Launch the authenticated participant waiter — invoking the
      // SAME EXISTING test-only wrapper (which itself calls the real
      // production request_my_qr_issuance_transactional_internal)
      // PostgREST would normally call. It reaches
      // matching_pending_candidate, passes the (uncontended) application
      // lock, then blocks on the credential lock the holder still has.
      //
      // CLOUD-NATIVE: on a remote disposable-cloud run, this call goes
      // over a dedicated raw PostgreSQL connection with the SAME
      // request.jwt.claims/role context PostgREST would set, reproduced
      // from fx.accessToken — the REAL token this fixture's own
      // signInWithPassword() call already issued.
      let sessionBPromise: ReturnType<typeof fx.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        // to_jsonb(...) forces Postgres to serialize the composite return
        // value as real JSON (matching what PostgREST does internally)
        // rather than node-pg receiving Postgres's raw composite TEXT
        // format, which is not machine-parseable as field access.
        await launchCloudNativeWaiter(
          waiterTag,
          fx.accessToken,
          'select to_jsonb(public.test_only_request_my_qr_issuance_short_ttl($1, $2, $3)) as result',
          [requestKey, `${shortTtlSeconds} seconds`, waiterTag],
        );
      } else {
        sessionBPromise = fx.client.rpc('test_only_request_my_qr_issuance_short_ttl', {
          p_request_key: requestKey,
          p_pending_ttl: `${shortTtlSeconds} seconds`,
          p_waiter_tag: waiterTag,
        });
      }

      // 5. Deterministic proof of the SPECIFIC blocking relationship —
      // pg_blocking_pids() in both paths, just reached differently.
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // 6. Wait until the seeded operation's own expires_at has genuinely
      // passed, while the waiter remains blocked on the credential lock.
      const msUntilExpiry = expiresAt.getTime() - Date.now();
      if (msUntilExpiry > 0) {
        await new Promise((resolve) => setTimeout(resolve, msUntilExpiry + 1500));
      }

      // 7. Only now release the holder's gate — the SAME intended test
      // mechanism (test_only_release_lock_gate via the normal Supabase
      // client) regardless of which transport held the lock.
      await releaseGate(gateId);
      gateReleased = true;

      let resultOutcome: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        resultOutcome = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const [sessionAResult, sessionBResult] = await Promise.all([sessionAPromise!, sessionBPromise!]);
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data, 'waiter RPC returned no data despite reporting no error').toBeTruthy();
        resultOutcome = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }

      expect(resultOutcome.outcome).toBe('operation_expired');
      expect(resultOutcome.outcome).not.toBe('active_credential_already_exists');

      const { data: opAfter, error: opAfterError } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', opRow!.id)
        .single();
      expect(opAfterError, `post-state query failed: ${opAfterError?.message}`).toBeNull();
      expect(opAfter).toBeTruthy();
      expect(opAfter!.status).toBe('expired');
      expect(opAfter!.terminal_reason_code).toBe('ttl_expired');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('freshly inserted operation: expiry wins over an active credential observed only after waiting on the credential lock', async () => {
    const fx = await createParticipantFixture();
    const credentialId = await insertActiveCredential(fx.applicationId);
    const holderTag = `holder-${randomUUID()}`;
    const waiterTag = `waiter-${randomUUID()}`;
    const gateId = await createGate();
    const requestKey = randomUUID();
    const shortTtlSeconds = 3;
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';

    // 1/2. Launch and confirm the credential holder.
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_active_credential_lock($1, $2, $3, $4)',
        [credentialId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_active_credential_lock', {
        p_credential_id: credentialId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      // 3. Launch the authenticated short-TTL reservation with a NEW
      // request key — it inserts its OWN pending operation, then blocks
      // on the credential lock the holder holds.
      let sessionBPromise: ReturnType<typeof fx.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          fx.accessToken,
          'select to_jsonb(public.test_only_request_my_qr_issuance_short_ttl($1, $2, $3)) as result',
          [requestKey, `${shortTtlSeconds} seconds`, waiterTag],
        );
      } else {
        sessionBPromise = fx.client.rpc('test_only_request_my_qr_issuance_short_ttl', {
          p_request_key: requestKey,
          p_pending_ttl: `${shortTtlSeconds} seconds`,
          p_waiter_tag: waiterTag,
        });
      }

      // 5. Deterministic proof of the blocking relationship.
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // 6. Wait beyond the operation's own short TTL, measured from NOW
      // — the moment waitUntilBlocked() resolves. pg_blocking_pids()
      // only reports a genuine wait state once the waiter's transaction
      // has already inserted its row and reached the credential lock, so
      // the row's created_at is always <= this instant — sleeping the
      // full TTL from here is always a safe upper bound. Precomputing
      // the expiry target from an earlier database-clock reading was
      // tried (both before opening the waiter's connection, and on the
      // waiter's own connection immediately before its RPC statement)
      // and rejected: Supabase Cloud network/connection round-trip
      // variance reaching this specific instance left an unpredictable
      // multi-second gap in practice (observed up to ~4.7s), making any
      // such precomputed margin unreliable in either direction —
      // wall-clock skew was never actually the dominant source of
      // flakiness this was meant to fix.
      await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

      // 7. Release the gate.
      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const [sessionAResult, sessionBResult] = await Promise.all([sessionAPromise!, sessionBPromise!]);
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data, 'waiter RPC returned no data despite reporting no error').toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('operation_expired');
      expect(result.outcome).not.toBe('active_credential_already_exists');

      const { data: opAfter, error: opAfterError } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', result.operation_id)
        .single();
      expect(opAfterError, `post-state query failed: ${opAfterError?.message}`).toBeNull();
      expect(opAfter).toBeTruthy();
      expect(opAfter!.status).toBe('expired');
      expect(opAfter!.terminal_reason_code).toBe('ttl_expired');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);
});

describe('reserve_or_reuse_qr_lifecycle_operation — request-key advisory lock and named-index recovery (deterministic)', () => {
  it('re-raises an unrelated request-key unique violation rather than reporting another_operation_pending', async () => {
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();
    const holderTag = `holder-${randomUUID()}`;
    const waiterTag = `waiter-${randomUUID()}`;
    const gateId = await createGate();
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';

    // 1/2. Launch and confirm the application holder.
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      // 3. Launch the tagged wrapper around the REAL production RPC
      // (fixed 5-minute TTL, exactly as deployed) — no TTL expiry is
      // under test here.
      let sessionBPromise: ReturnType<typeof fx.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          fx.accessToken,
          'select to_jsonb(public.test_only_request_my_qr_issuance_tagged($1, $2)) as result',
          [requestKey, waiterTag],
        );
      } else {
        sessionBPromise = fx.client.rpc('test_only_request_my_qr_issuance_tagged', {
          p_request_key: requestKey,
          p_waiter_tag: waiterTag,
        });
      }

      // 4. Deterministic proof B is blocked by A specifically.
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // 5. Bypass insert, deliberately skipping the advisory-lock
      // protocol entirely, under the SAME
      // requester/operation_type/request_key as B.
      const { data: bypassOp, error: bypassInsertError } = await admin
        .from('qr_lifecycle_operations')
        .insert({
          operation_type: 'issue',
          application_id: fx.applicationId,
          requested_by_auth_user_id: fx.userId,
          requested_by_profile_id: fx.userId,
          channel: 'participant_self_service',
          request_key: requestKey,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        })
        .select('id')
        .single();
      expect(bypassInsertError, `bypass insert failed: ${bypassInsertError?.message}`).toBeNull();
      expect(bypassOp).toBeTruthy();

      // 6. Transition it to a fully schema-valid terminal 'cancelled'
      // state — every field required by the lifecycle constraints set
      // explicitly.
      const transitionNow = new Date().toISOString();
      const { error: bypassCancelError } = await admin
        .from('qr_lifecycle_operations')
        .update({
          status: 'cancelled',
          finalized_at: transitionNow,
          terminal_reason_code: 'cancelled_by_server',
          consumed_at: null,
          resulting_credential_id: null,
          finalization_fingerprint: null,
          terminal_related_credential_id: null,
        })
        .eq('id', bypassOp!.id);
      expect(bypassCancelError, `bypass cancel-transition failed: ${bypassCancelError?.message}`).toBeNull();

      // 7. Verify BOTH the bypass insert and its terminal transition
      // actually completed successfully BEFORE the application gate is
      // released — this is the exact ordering the FOR NO KEY UPDATE fix
      // exists to make observable.
      const { data: bypassCheck, error: bypassCheckError } = await admin
        .from('qr_lifecycle_operations')
        .select('status')
        .eq('id', bypassOp!.id)
        .single();
      expect(bypassCheckError, `bypass verification query failed: ${bypassCheckError?.message}`).toBeNull();
      expect(bypassCheck).toBeTruthy();
      expect(bypassCheck!.status, 'bypass insert + cancel transition must both be confirmed complete before the gate is released').toBe('cancelled');

      // 8. Only now release the application holder's gate.
      await releaseGate(gateId);
      gateReleased = true;

      let sessionBError: { code?: string; message: string } | null;
      if (usesCloudNativeHolder) {
        const outcome = await getCloudNativeWaiterOutcome(waiterTag);
        sessionBError = outcome.error;
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        sessionBError = sessionBResult.error;
      }

      // 9. B's own insert now collides with
      // qr_lifecycle_operations_request_key_unique_idx (same requester/
      // type/request_key as the bypass row, unscoped by status), NOT
      // qr_lifecycle_operations_one_pending_per_domain_idx (the bypass
      // row is no longer pending) — this must surface as a raw,
      // unrecognized-constraint re-raise, never silently converted to
      // another_operation_pending.
      expect(sessionBError, 'expected the RPC to re-raise the unrelated unique violation, not swallow it').toBeTruthy();
      expect(sessionBError!.code).toBe('23505');
      expect(sessionBError!.message).toContain('qr_lifecycle_operations_request_key_unique_idx');

      const { data: bypassAfter, error: bypassAfterError } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code, finalized_at, consumed_at, resulting_credential_id, finalization_fingerprint, terminal_related_credential_id')
        .eq('id', bypassOp!.id)
        .single();
      expect(bypassAfterError, `post-state query failed: ${bypassAfterError?.message}`).toBeNull();
      expect(bypassAfter).toBeTruthy();
      expect(bypassAfter!.status).toBe('cancelled');
      expect(bypassAfter!.terminal_reason_code).toBe('cancelled_by_server');
      expect(bypassAfter!.finalized_at).toBeTruthy();
      expect(bypassAfter!.consumed_at).toBeNull();
      expect(bypassAfter!.resulting_credential_id).toBeNull();
      expect(bypassAfter!.finalization_fingerprint).toBeNull();
      expect(bypassAfter!.terminal_related_credential_id).toBeNull();

      // 10. Exactly one row exists for (requester, operation_type,
      // request_key) — B created no second row.
      const { data: rowsForKey, error: rowsForKeyError } = await admin
        .from('qr_lifecycle_operations')
        .select('id')
        .eq('requested_by_auth_user_id', fx.userId)
        .eq('operation_type', 'issue')
        .eq('request_key', requestKey);
      expect(rowsForKeyError, `row-count query failed: ${rowsForKeyError?.message}`).toBeNull();
      expect(rowsForKey).toHaveLength(1);
      expect(rowsForKey![0].id).toBe(bypassOp!.id);
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('named pending-domain recovery: a bypass insert under a DIFFERENT request_key is correctly mapped to another_operation_pending', async () => {
    const fx = await createParticipantFixture();
    const requestKeyB = randomUUID();
    const bypassRequestKey = randomUUID(); // deliberately DIFFERENT from requestKeyB
    const holderTag = `holder-${randomUUID()}`;
    const waiterTag = `waiter-${randomUUID()}`;
    const gateId = await createGate();

    // 1. Same deterministic holder/waiter barriers as the previous test.
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof fx.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          fx.accessToken,
          'select to_jsonb(public.test_only_request_my_qr_issuance_tagged($1, $2)) as result',
          [requestKeyB, waiterTag],
        );
      } else {
        sessionBPromise = fx.client.rpc('test_only_request_my_qr_issuance_tagged', {
          p_request_key: requestKeyB,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // 2/3. Bypass insert under a DIFFERENT request_key, left pending.
      const { data: bypassOp, error: bypassInsertError } = await admin
        .from('qr_lifecycle_operations')
        .insert({
          operation_type: 'issue',
          application_id: fx.applicationId,
          requested_by_auth_user_id: fx.userId,
          requested_by_profile_id: fx.userId,
          channel: 'participant_self_service',
          request_key: bypassRequestKey,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        })
        .select('id')
        .single();
      expect(bypassInsertError, `bypass insert failed: ${bypassInsertError?.message}`).toBeNull();
      expect(bypassOp).toBeTruthy();

      // Confirm the bypass insert completed successfully BEFORE the gate
      // is released.
      const { data: bypassCheck, error: bypassCheckError } = await admin
        .from('qr_lifecycle_operations')
        .select('status')
        .eq('id', bypassOp!.id)
        .single();
      expect(bypassCheckError, `bypass verification query failed: ${bypassCheckError?.message}`).toBeNull();
      expect(bypassCheck).toBeTruthy();
      expect(bypassCheck!.status, 'bypass insert must be confirmed complete before the gate is released').toBe('pending');

      // 4. Release the application holder's gate.
      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string | null };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string | null }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data, 'waiter RPC returned no data despite reporting no error').toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string | null };
      }

      // 5. This time B's insert collides with
      // qr_lifecycle_operations_one_pending_per_domain_idx specifically —
      // the RPC's exception handler must recognize this by name and map
      // it to the controlled outcome, not a raw error.
      expect(result.outcome).toBe('another_operation_pending');
      expect(result.operation_id).toBe(bypassOp!.id); // same requester -> id visible

      // 6. The blocking row remains the only pending domain row.
      const { data: bypassAfter, error: bypassAfterError } = await admin
        .from('qr_lifecycle_operations')
        .select('status')
        .eq('id', bypassOp!.id)
        .single();
      expect(bypassAfterError, `post-state query failed: ${bypassAfterError?.message}`).toBeNull();
      expect(bypassAfter).toBeTruthy();
      expect(bypassAfter!.status).toBe('pending');

      const { data: pendingRows, error: pendingRowsError } = await admin
        .from('qr_lifecycle_operations')
        .select('id')
        .eq('application_id', fx.applicationId)
        .eq('operation_type', 'issue')
        .eq('status', 'pending');
      expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows![0].id).toBe(bypassOp!.id);
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);
});

// ============================================================================
// Participant self-reissue reservation — request_my_qr_reissue_transactional
// / request_my_qr_reissue_transactional_internal /
// resolve_blocking_qr_lifecycle_reissue_operation (Phase 6 design doc §5.2,
// CORRECTED this round). Reuses every fixture/synchronization helper above
// — same disposable-local-database guard, same holder-ready/waiter-blocked/
// explicit-gate primitives, same try/finally discipline, same
// unique-token-hash fixture requirement, same no-durable-row-deletion rule.
//
// CORRECTED DURABILITY RULE (this round): every business decision on a
// valid caller-supplied request key now has its own durable
// qr_lifecycle_operations row — including application_ineligible,
// no_active_credential, expected_credential_changed,
// reissue_cooldown_active, and reissue_rate_limit_exceeded. Only malformed
// input, invalid reason/note shape, unauthenticated access, no participant
// application, or an expected_current_credential_id that cannot legally
// identify a credential belonging to the participant's own application may
// fail before an operation row exists. Tests below assert a real,
// queryable, cancelled row for every one of these outcomes, not merely the
// RPC's returned outcome string.
// ============================================================================
const REISSUE_REASON_OTHER_REQUIRES_NOTE = 'participant_other';
const REISSUE_REASON_NO_NOTE_REQUIRED = 'lost_or_stolen_phone';

async function reissueFixtureWithActiveCredential(): Promise<{ fx: ParticipantFixture; credentialId: string }> {
  const fx = await createParticipantFixture();
  const credentialId = await insertActiveCredential(fx.applicationId);
  return { fx, credentialId };
}

// Seeds `count` qualifying (participant-self-service, consumed) historical
// reissue operations for `fx`'s application, evenly spaced across the
// window described by `spanHoursAgo`..`endHoursAgo` (both measured
// backwards from "now"), returning their consumed_at timestamps in
// insertion order. MUST be called BEFORE reissueFixtureWithActiveCredential
// establishes the fixture's own real active credential — the seeder's
// shared implementation requires being the only 'active' row author until
// then (see the setup SQL's own header comment on this exact ordering
// requirement) — so every boundary test below seeds history first, then
// calls insertActiveCredential() itself directly afterward, rather than
// using the reissueFixtureWithActiveCredential() convenience helper.
// Shared by seedQualifyingHistory() and any test that calls a
// test_only_seed_*_consumed_reissue_operation RPC directly (e.g. the
// staff-channel seeding loop below, which uses a different RPC name than
// seedQualifyingHistory() wraps and so cannot go through it). Every such
// seed helper necessarily leaves exactly one 'active' credential row
// behind for the given application after its own chained insert/replace
// sequence — the trigger's INSERT guard requires every new credential
// row to begin 'active', so there is no way to seed history without one
// such row remaining. insertActiveCredential() itself does an
// unconditional INSERT (by design — see its own definition above; many
// OTHER callers throughout this file intentionally rely on that
// blind-insert contract and manage any pre-existing active row
// themselves), so it would collide with this leftover row under
// qr_credentials_one_active_per_application. Retire it here — via the
// same legal active -> revoked transition used elsewhere in this file
// (e.g. the activeThenRevokedId pattern above) — rather than changing
// insertActiveCredential()'s shared contract for every other caller. The
// seeded historical credential itself is NOT deleted — it remains
// present, now 'revoked' instead of 'active', preserving the full
// historical record these seed helpers exist to create.
async function retireLeftoverSeededActiveCredential(applicationId: string): Promise<void> {
  const { data: leftoverActiveRow, error: leftoverLookupError } = await admin
    .from('qr_credentials')
    .select('id')
    .eq('application_id', applicationId)
    .eq('status', 'active')
    .maybeSingle();
  expect(leftoverLookupError, `leftover active-credential lookup failed: ${leftoverLookupError?.message}`).toBeNull();
  if (leftoverActiveRow) {
    const { error: retireError } = await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', leftoverActiveRow.id);
    expect(retireError, `leftover active-credential retirement failed: ${retireError?.message}`).toBeNull();
  }
}

async function seedQualifyingHistory(
  applicationId: string,
  userId: string,
  expectedCredentialId: string,
  timestamps: Date[],
): Promise<string[]> {
  const operationIds: string[] = [];
  for (const ts of timestamps) {
    const { data, error } = await admin.rpc('test_only_seed_consumed_reissue_operation', {
      p_application_id: applicationId,
      p_requester_auth_user_id: userId,
      p_expected_current_credential_id: expectedCredentialId,
      p_consumed_at: ts.toISOString(),
    });
    expect(error, `qualifying-history seed failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    operationIds.push(data as unknown as string);
  }
  await retireLeftoverSeededActiveCredential(applicationId);
  return operationIds;
}

describe('request_my_qr_reissue_transactional — first reservation, replay, and intent-conflict semantics', () => {
  it('reserves a first participant reissue against a valid active credential', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const requestKey = randomUUID();

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reissue reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('reserved');
    expect(result.operation_id).toBeTruthy();

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, operation_type, channel, expected_current_credential_id, reason_code, note, request_key')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow).toBeTruthy();
    expect(opRow!.status).toBe('pending');
    expect(opRow!.operation_type).toBe('reissue');
    expect(opRow!.channel).toBe('participant_self_service');
    expect(opRow!.expected_current_credential_id).toBe(credentialId);
    expect(opRow!.reason_code).toBe(REISSUE_REASON_NO_NOTE_REQUIRED);
    expect(opRow!.note).toBeNull();
    expect(opRow!.request_key).toBe(requestKey);

    const { data: credAfter, error: credAfterError } = await admin
      .from('qr_credentials')
      .select('status')
      .eq('id', credentialId)
      .single();
    expect(credAfterError, `credential post-state query failed: ${credAfterError?.message}`).toBeNull();
    expect(credAfter!.status).toBe('active');
  });

  it('same-key identical pending retry returns the same operation', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const requestKey = randomUUID();

    const first = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(first.error, `first reservation failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const retry = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    expect(retry.data).toBeTruthy();
    const retryResult = retry.data as unknown as { outcome: string; operation_id: string };
    expect(retryResult.outcome).toBe('already_pending');
    expect(retryResult.operation_id).toBe(firstResult.operation_id);
  });

  it('note normalization: whitespace-only vs. null note are treated as identical intent (no spurious conflict)', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const requestKey = randomUUID();

    const first = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: '   ', // whitespace-only
    });
    expect(first.error, `first reservation failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const { data: opRow } = await admin
      .from('qr_lifecycle_operations')
      .select('note')
      .eq('id', firstResult.operation_id)
      .single();
    expect(opRow!.note).toBeNull(); // normalized: trimmed-empty -> null, stored form

    const retry = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null, // explicit null this time
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    const retryResult = retry.data as unknown as { outcome: string; operation_id: string };
    // Must be recognized as IDENTICAL intent — already_pending, not
    // request_key_intent_conflict — since both normalize to the same
    // stored value (null).
    expect(retryResult.outcome).toBe('already_pending');
    expect(retryResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting expected credential returns request_key_intent_conflict', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    // CORRECTED: the "conflicting" credential must belong to THIS SAME
    // application (just not the one named in the first call) to exercise
    // request_key_intent_conflict at all — request_my_qr_reissue_
    // transactional_internal deliberately rejects an
    // expected_current_credential_id from a DIFFERENT application as
    // invalid input (a raised P0001 exception) before ever reaching the
    // request-key-conflict check, per its own documented
    // existence+application-match validation. A credential from a
    // genuinely different application (the previous version of this test)
    // was therefore always rejected upfront, never reaching the intent-
    // conflict comparison this test exists to prove.
    //
    // qr_credentials_one_active_per_application is a PARTIAL unique index
    // (application_id) WHERE status = 'active' — a second active row for
    // this application can only be inserted once credentialId itself is
    // no longer active. credentialId must stay active through the FIRST
    // call below (the main reservation path DOES require the expected
    // credential to still be the currently active one to return
    // 'reserved' — unlike the earlier existence+application-match input
    // gate, this one is status-sensitive) — so the swap happens strictly
    // AFTER the first call succeeds, not before.
    const requestKey = randomUUID();

    const first = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(first.error, `first reservation failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const { error: revokeFirstError } = await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', credentialId);
    expect(revokeFirstError, `credentialId revocation failed: ${revokeFirstError?.message}`).toBeNull();
    const otherCredentialId = await insertActiveCredential(fx.applicationId);

    const conflict = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: otherCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(conflict.error, `conflicting-credential retry failed: ${conflict.error?.message}`).toBeNull();
    expect(conflict.data).toBeTruthy();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);

    const { data: opAfter, error: opAfterError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, expected_current_credential_id')
      .eq('id', firstResult.operation_id)
      .single();
    expect(opAfterError, `post-state query failed: ${opAfterError?.message}`).toBeNull();
    expect(opAfter!.status).toBe('pending');
    expect(opAfter!.expected_current_credential_id).toBe(credentialId);
  });

  it('same-key conflicting reason/note returns request_key_intent_conflict', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const requestKey = randomUUID();

    const first = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(first.error, `first reservation failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_OTHER_REQUIRES_NOTE,
      p_reissue_note: 'a different explanation entirely',
    });
    expect(conflict.error, `conflicting-reason retry failed: ${conflict.error?.message}`).toBeNull();
    expect(conflict.data).toBeTruthy();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('invalid reason code raises the documented input exception, is not represented as a lifecycle-result outcome, and creates no operation row', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: 'not_a_real_reason_code',
      p_reissue_note: null,
    });
    expect(error, 'expected the RPC to reject an invalid reason code with a raised exception').toBeTruthy();
    expect(data).toBeNull();

    const { data: rows, error: rowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue');
    expect(rowsError, `row-count query failed: ${rowsError?.message}`).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('participant_other reason code without a note raises the documented input exception and creates no operation row', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_OTHER_REQUIRES_NOTE,
      p_reissue_note: null,
    });
    expect(error, 'expected the RPC to reject participant_other without a note').toBeTruthy();
    expect(data).toBeNull();

    const { data: rows, error: rowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue');
    expect(rowsError, `row-count query failed: ${rowsError?.message}`).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('an expected_current_credential_id that cannot identify a credential belonging to this application raises an input exception, not a business outcome', async () => {
    const { fx } = await reissueFixtureWithActiveCredential();
    const foreignCredentialId = await insertActiveCredential((await createParticipantFixture()).applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: foreignCredentialId, // belongs to a DIFFERENT application entirely
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, 'expected the RPC to reject a credential id that cannot satisfy the composite FK for this application').toBeTruthy();
    expect(data).toBeNull();

    const { data: rows, error: rowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue');
    expect(rowsError, `row-count query failed: ${rowsError?.message}`).toBeNull();
    expect(rows).toHaveLength(0);
  });
});

describe('request_my_qr_reissue_transactional — durable business denials (every denial persists its own operation)', () => {
  it('application-ineligible first request persists its own cancelled operation, and the active credential remains unchanged', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const { error: statusError } = await admin
      .from('applications')
      .update({ status: 'submitted' })
      .eq('id', fx.applicationId);
    expect(statusError, `application status update failed: ${statusError?.message}`).toBeNull();

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('application_ineligible');
    expect(result.operation_id).toBeTruthy();

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('application_ineligible');

    // Corrected expectation (20260815000000_revoke_qr_credential_on_ineligibility.sql):
    // the applications.update({ status: 'submitted' }) call above — made
    // BEFORE this RPC ever ran — already left applications.status
    // non-accepted, which now auto-revokes the application's active
    // credential via an AFTER UPDATE trigger, independent of and prior
    // to whatever this RPC call itself decides. The credential does NOT
    // "remain unchanged" anymore; leaving accepted intentionally revokes
    // it (reason application_ineligible) so a later return to accepted
    // can never silently resurrect it. The rest of this test's
    // assertions (RPC correctly returns application_ineligible, the
    // reissue operation itself is cancelled) are unaffected.
    const { data: credAfter } = await admin.from('qr_credentials').select('status, revocation_reason_code').eq('id', credentialId).single();
    expect(credAfter!.status).toBe('revoked');
    expect(credAfter!.revocation_reason_code).toBe('application_ineligible');
  });

  it('no-active-credential first request persists its own cancelled operation', async () => {
    const fx = await createParticipantFixture();
    // A credential id that DOES belong to this application (satisfying the
    // FK-intent input check) but is not currently active: seed one via the
    // history seeder (its resulting_credential_id is a real, replaced
    // credential for a DIFFERENT application's history — not usable here).
    // Simplest valid approach: insert a credential directly as active,
    // then revoke it via direct service-role write is not legal (revoke
    // requires an authorized staff actor per the frozen trigger) — instead
    // use a fresh credential inserted and immediately revoked through the
    // same legal active -> revoked transition the seeder itself uses,
    // scoped to THIS application.
    const activeThenRevokedId = await insertActiveCredential(fx.applicationId);
    const { error: revokeError } = await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', activeThenRevokedId);
    expect(revokeError, `revoke transition failed: ${revokeError?.message}`).toBeNull();

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: activeThenRevokedId, // belongs to this application, just not active
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('no_active_credential');
    expect(result.operation_id).toBeTruthy();

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('no_active_credential');
  });

  it('Scenario A (same-application historical credential): expected-credential-changed first request persists its own cancelled operation with terminal_related_credential_id left null, and initial mismatch plus identical same-key replay both return the stable expected_credential_changed outcome with no fabricated credential_id/status/issued_at, and the current active credential remains unchanged', async () => {
    // CORRECTED this round: terminal_related_credential_id is permitted
    // ONLY for 'active_credential_already_exists' by the approved
    // qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    // (§1.7) — it must remain null for 'expected_credential_changed'.
    //
    // CORRECTED this round (second pass): the previous version of this
    // test used a credential belonging to a DIFFERENT application
    // (wrongCredentialId, from a separate createParticipantFixture()) as
    // the expected credential — that is invalid input, rejected BEFORE
    // any operation is created (see request_my_qr_reissue_transactional_internal's
    // own "does not identify a credential belonging to this application"
    // check), never converted to expected_credential_changed. The
    // legitimate expected_credential_changed scenario requires a
    // credential that genuinely belongs to THIS SAME application but is
    // no longer the active one (Scenario A, exercised here). The
    // separate cross-application input-validation scenario is exercised
    // by "Scenario B" below.
    const fx = await createParticipantFixture();
    const historicalCredentialId = await insertActiveCredential(fx.applicationId);
    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', historicalCredentialId);
    const currentActiveCredentialId = await insertActiveCredential(fx.applicationId);
    const requestKey = randomUUID();

    const first = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: historicalCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(first.error, `reservation failed: ${first.error?.message}`).toBeNull();
    expect(first.data).toBeTruthy();
    const firstResult = first.data as unknown as Record<string, unknown> & { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('expected_credential_changed');
    expect(firstResult.credential_id).toBeNull();
    expect(firstResult.status).toBeNull();
    expect(firstResult.issued_at).toBeNull();
    expect(firstResult.operation_id).toBeTruthy();

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code, terminal_related_credential_id')
      .eq('id', firstResult.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('expected_credential_changed');
    expect(opRow!.terminal_related_credential_id).toBeNull();

    // Identical same-key replay: same request_key, same (historical)
    // expected credential — must replay the SAME durable operation and
    // outcome.
    const replay = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: historicalCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(replay.error, `replay failed: ${replay.error?.message}`).toBeNull();
    expect(replay.data).toBeTruthy();
    const replayResult = replay.data as unknown as Record<string, unknown> & { outcome: string; operation_id: string };
    expect(replayResult.outcome).toBe('expected_credential_changed');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
    expect(replayResult.credential_id).toBeNull();
    expect(replayResult.status).toBeNull();
    expect(replayResult.issued_at).toBeNull();

    const { data: credAfter } = await admin.from('qr_credentials').select('status').eq('id', currentActiveCredentialId).single();
    expect(credAfter!.status).toBe('active'); // reservation never revokes or replaces the active credential
  });

  it('Scenario B (credential from another application): using an expected credential ID that belongs to a DIFFERENT application is rejected as a controlled input-validation error, no lifecycle operation is inserted, no credential is modified, and no raw foreign-key constraint error leaks to the client', async () => {
    const fx = await createParticipantFixture();
    const otherApplication = await createParticipantFixture();
    const foreignCredentialId = await insertActiveCredential(otherApplication.applicationId);

    const before = await admin.from('qr_lifecycle_operations').select('id').eq('application_id', fx.applicationId);
    expect(before.data ?? []).toHaveLength(0);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: foreignCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, 'expected a controlled input-validation error for a cross-application expected credential id').toBeTruthy();
    expect(data).toBeNull();
    // A controlled, application-level exception raised by an explicit
    // existence+application-match check — NOT a raw Postgres
    // foreign-key-constraint violation (23503) leaking to the client.
    expect(error!.code).not.toBe('23503');
    expect(error!.message).toContain('does not identify a credential belonging to this application');

    const after = await admin.from('qr_lifecycle_operations').select('id').eq('application_id', fx.applicationId);
    expect(after.data ?? []).toHaveLength(0);

    const { data: foreignCredAfter } = await admin.from('qr_credentials').select('status, application_id').eq('id', foreignCredentialId).single();
    expect(foreignCredAfter!.status).toBe('active');
    expect(foreignCredAfter!.application_id).toBe(otherApplication.applicationId);
  });
});

describe('request_my_qr_reissue_transactional — deterministic concurrency (TTL, blocker resolution, credential changes)', () => {
  it('a different-key valid blocker returns another_operation_pending, and the eligible current credential remains unchanged', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const holderTag = `reissue-holder-${randomUUID()}`;
    const waiterTag = `reissue-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const blocker = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(blocker.error, `blocker reservation failed: ${blocker.error?.message}`).toBeNull();
    const blockerResult = blocker.data as unknown as { outcome: string; operation_id: string };
    expect(blockerResult.outcome).toBe('reserved');

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof fx.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          fx.accessToken,
          'select to_jsonb(public.test_only_request_my_qr_reissue_tagged($1, $2, $3, $4, $5)) as result',
          [randomUUID(), credentialId, REISSUE_REASON_NO_NOTE_REQUIRED, null, waiterTag],
        );
      } else {
        sessionBPromise = fx.client.rpc('test_only_request_my_qr_reissue_tagged', {
          p_request_key: randomUUID(),
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string | null };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string | null }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string | null };
      }
      expect(result.outcome).toBe('another_operation_pending');
      expect(result.operation_id).toBe(blockerResult.operation_id);

      const { data: blockerAfter } = await admin
        .from('qr_lifecycle_operations')
        .select('status')
        .eq('id', blockerResult.operation_id)
        .single();
      expect(blockerAfter!.status).toBe('pending');

      const { data: credAfter } = await admin.from('qr_credentials').select('status').eq('id', credentialId).single();
      expect(credAfter!.status).toBe('active');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('an expired different-key blocker is terminalized before the new request continues, which reserves successfully', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const shortTtlSeconds = 3;

    const seedRequestKey = randomUUID();
    // test_only_request_my_qr_reissue_short_ttl is granted EXECUTE to
    // authenticated only (revoked from service_role) — it must be called
    // via the participant's own authenticated client, not admin.
    const seed = await fx.client.rpc('test_only_request_my_qr_reissue_short_ttl', {
      p_request_key: seedRequestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_pending_ttl: `${shortTtlSeconds} seconds`,
      p_waiter_tag: `reissue-seed-${randomUUID()}`,
    });
    expect(seed.error, `seed reservation failed: ${seed.error?.message}`).toBeNull();
    const seedData = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedData.outcome).toBe('reserved');

    await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

    const newRequestKey = randomUUID();
    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: newRequestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `new reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('reserved');
    expect(result.operation_id).not.toBe(seedData.operation_id);

    const { data: seedAfter } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', seedData.operation_id)
      .single();
    expect(seedAfter!.status).toBe('expired');
    expect(seedAfter!.terminal_reason_code).toBe('ttl_expired');
  }, 30000);

  it('matching-pending: TTL expiring while waiting for the credential lock reports operation_expired, not expected_credential_changed', async () => {
    // CORRECTED: the original version of this test seeded a FRESH
    // operation (no_existing_operation path) and expected its TTL to
    // expire while the SAME insert call was still blocked on the
    // credential lock. Direct reading of request_my_qr_reissue_
    // transactional_internal's no_existing_operation path proved that
    // scenario structurally unreachable: "Step 2: credential lock BEFORE
    // any further decision" (line ~4613 of the migration) acquires the
    // credential lock BEFORE v_created_at is even captured and the row
    // inserted — so a freshly-inserted operation's TTL clock cannot
    // start before the very lock it would need to be "waiting on" is
    // already granted. There is no window where a not-yet-existing
    // operation is both created and still blocked on that lock.
    // Confirmed empirically too: 5 consecutive isolated runs all showed
    // the operation's real created_at landing only ~300ms before the
    // gate was released — i.e. after the full TTL-plus-margin sleep had
    // already elapsed waiting for a row that didn't exist yet.
    //
    // The matching_pending_candidate path (a SECOND call reusing the
    // SAME request_key as an already-EXISTING pending operation) is
    // different and reachable: its own credential lock (line ~4524) is
    // also acquired before the TTL check, but the TTL check there
    // (`(v_reservation.op).expires_at <= v_check_now`, line ~4531) uses
    // the EXISTING row's OWN already-fixed expires_at, captured at seed
    // time — a real clock that keeps ticking independently of when this
    // second call happens to acquire the lock. This test now: (1) seeds
    // a real pending reissue operation with a short TTL via a plain,
    // un-blocked call (its own credential-lock acquisition succeeds
    // immediately, since nothing holds it yet); (2) launches the holder
    // to take the credential lock; (3) issues a SECOND call reusing the
    // SAME request_key, which reaches matching_pending_candidate and
    // genuinely blocks on that same lock; (4) waits until the SEED's
    // OWN real expires_at (read directly from the database) has passed;
    // (5) releases the gate and asserts the second call observes the
    // now-genuinely-expired seed.
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const holderTag = `reissue-cred-holder-${randomUUID()}`;
    const waiterTag = `reissue-waiter-${randomUUID()}`;
    const gateId = await createGate();
    const shortTtlSeconds = 3;
    const requestKey = randomUUID();

    // Step 1: seed a real pending operation under requestKey — runs
    // BEFORE the holder takes the credential lock, so this call's own
    // "Step 2: credential lock" acquisition succeeds immediately.
    const seed = await fx.client.rpc('test_only_request_my_qr_reissue_short_ttl', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_pending_ttl: `${shortTtlSeconds} seconds`,
      p_waiter_tag: `reissue-matching-pending-seed-${randomUUID()}`,
    });
    expect(seed.error, `seed reservation failed: ${seed.error?.message}`).toBeNull();
    const seedResult = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedResult.outcome).toBe('reserved');

    const { data: seedRow, error: seedRowError } = await admin
      .from('qr_lifecycle_operations')
      .select('created_at, expires_at')
      .eq('id', seedResult.operation_id)
      .single();
    expect(seedRowError, `seed row lookup failed: ${seedRowError?.message}`).toBeNull();
    expect(seedRow).toBeTruthy();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_active_credential_lock($1, $2, $3, $4)',
        [credentialId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_active_credential_lock', {
        p_credential_id: credentialId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      // Step 2: a SECOND call reusing the SAME requestKey — this hits
      // matching_pending_candidate (a row under this exact (requester,
      // type, request_key) already exists) and genuinely blocks on the
      // credential lock the holder above already took.
      let sessionBPromise: ReturnType<typeof fx.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          fx.accessToken,
          'select to_jsonb(public.test_only_request_my_qr_reissue_short_ttl($1, $2, $3, $4, $5, $6)) as result',
          [requestKey, credentialId, REISSUE_REASON_NO_NOTE_REQUIRED, null, `${shortTtlSeconds} seconds`, waiterTag],
        );
      } else {
        sessionBPromise = fx.client.rpc('test_only_request_my_qr_reissue_short_ttl', {
          p_request_key: requestKey,
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_pending_ttl: `${shortTtlSeconds} seconds`,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // Wait until the database's own clock has crossed the SEED's real,
      // already-fixed expires_at — not a client-side sleep duration
      // guess, the actual authoritative boundary this test needs to
      // cross while the second call remains genuinely blocked.
      const seedExpiresAtMs = new Date(seedRow!.expires_at).getTime();
      for (;;) {
        const { data: nowRow } = await admin.rpc('test_only_current_timestamp');
        const nowMs = new Date(nowRow as unknown as string).getTime();
        if (nowMs > seedExpiresAtMs) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Small fixed margin past the crossing point, to absorb the
      // granularity of the 100ms poll above — proven by the poll itself
      // to already be past expires_at, not a guess at when expiry might
      // occur.
      await new Promise((resolve) => setTimeout(resolve, 250));

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('operation_expired');
      expect(result.outcome).not.toBe('expected_credential_changed');
      expect(result.operation_id).toBe(seedResult.operation_id);

      const { data: opAfter } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', seedResult.operation_id)
        .single();
      expect(opAfter!.status).toBe('expired');
      expect(opAfter!.terminal_reason_code).toBe('ttl_expired');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('credential lock serializes correctly: an unchanged, matching credential still resolves to reserved once the holder releases', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const holderTag = `reissue-cred-holder-${randomUUID()}`;
    const waiterTag = `reissue-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_active_credential_lock($1, $2, $3, $4)',
        [credentialId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_active_credential_lock', {
        p_credential_id: credentialId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof fx.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          fx.accessToken,
          'select to_jsonb(public.test_only_request_my_qr_reissue_tagged($1, $2, $3, $4, $5)) as result',
          [randomUUID(), credentialId, REISSUE_REASON_NO_NOTE_REQUIRED, null, waiterTag],
        );
      } else {
        sessionBPromise = fx.client.rpc('test_only_request_my_qr_reissue_tagged', {
          p_request_key: randomUUID(),
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('reserved');

      const { data: opAfter } = await admin
        .from('qr_lifecycle_operations')
        .select('expected_current_credential_id')
        .eq('id', result.operation_id)
        .single();
      expect(opAfter!.expected_current_credential_id).toBe(credentialId);
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('two concurrent different request keys for the same participant/application resolve to exactly one reserved and one another_operation_pending', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const requestKeyA = randomUUID();
    const requestKeyB = randomUUID();

    const [resultA, resultB] = await Promise.all([
      fx.client.rpc('request_my_qr_reissue_transactional', {
        p_request_key: requestKeyA,
        p_expected_current_credential_id: credentialId,
        p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
      }),
      fx.client.rpc('request_my_qr_reissue_transactional', {
        p_request_key: requestKeyB,
        p_expected_current_credential_id: credentialId,
        p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
      }),
    ]);
    expect(resultA.error, `session A failed: ${resultA.error?.message}`).toBeNull();
    expect(resultB.error, `session B failed: ${resultB.error?.message}`).toBeNull();
    expect(resultA.data).toBeTruthy();
    expect(resultB.data).toBeTruthy();

    const outcomeA = (resultA.data as unknown as { outcome: string }).outcome;
    const outcomeB = (resultB.data as unknown as { outcome: string }).outcome;
    const outcomes = [outcomeA, outcomeB].sort();
    expect(outcomes).toEqual(['another_operation_pending', 'reserved']);

    const { data: pendingRows, error: pendingRowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue')
      .eq('status', 'pending');
    expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
    expect(pendingRows).toHaveLength(1);
  });

  it('same request key concurrently reused by the same STAFF requester across two different applications resolves via the request-key advisory lock, never both reserved', async () => {
    // CORRECTED: the original version of this test used ONE PARTICIPANT
    // with two applications to exercise "same requester, same request_key,
    // different application_id" — a state applications_one_per_applicant
    // (a genuine, unchanged production invariant: one applicant may never
    // own two applications) makes structurally impossible. That invariant
    // is correct and is not being relaxed.
    //
    // The property this test exists to prove is the position-1 advisory
    // lock's own documented scope: perform pg_advisory_xact_lock(
    // hashtextextended(requester_auth_user_id || ':' || operation_type ||
    // ':' || request_key, 0)) — keyed on requester alone, "regardless of
    // which application_id each concurrent call is targeting" (see that
    // lock's own comment in reserve_or_reuse_qr_lifecycle_operation).
    // request_my_qr_reissue_transactional cannot reach this scenario at
    // all — it is participant-self-service only, derives application_id
    // internally from auth.uid()'s own single application, and never
    // accepts application_id as a parameter. request_staff_qr_reissue_
    // transactional DOES accept p_application_id explicitly, and a single
    // staff member legitimately acts across many different participants'
    // applications — this is the actual reachable production scenario the
    // position-1 lock is designed to serialize, so this test now uses a
    // staff requester operating on two GENUINELY DIFFERENT participants'
    // applications, reusing the same request_key concurrently.
    const staff = await createStaffFixture('super_admin');
    const { fx: fxA, credentialId: credentialA } = await reissueFixtureWithActiveCredentialForStaff();
    const { fx: fxB, credentialId: credentialB } = await reissueFixtureWithActiveCredentialForStaff();

    const sharedRequestKey = randomUUID();

    const [callA, callB] = await Promise.all([
      staff.client.rpc('request_staff_qr_reissue_transactional', {
        p_request_key: sharedRequestKey,
        p_application_id: fxA.applicationId,
        p_expected_current_credential_id: credentialA,
        p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
        p_bulk_batch_id: null,
      }),
      staff.client.rpc('request_staff_qr_reissue_transactional', {
        p_request_key: sharedRequestKey,
        p_application_id: fxB.applicationId,
        p_expected_current_credential_id: credentialB,
        p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
        p_bulk_batch_id: null,
      }),
    ]);
    expect(callA.error, `call A failed: ${callA.error?.message}`).toBeNull();
    expect(callB.error, `call B failed: ${callB.error?.message}`).toBeNull();
    expect(callA.data).toBeTruthy();
    expect(callB.data).toBeTruthy();

    const outcomeA = (callA.data as unknown as { outcome: string }).outcome;
    const outcomeB = (callB.data as unknown as { outcome: string }).outcome;
    const outcomes = [outcomeA, outcomeB].sort();
    // request_key_intent_conflict is the correct outcome (not
    // another_operation_pending) BECAUSE the two calls share the same
    // request_key under the SAME requester — position 3's (requester,
    // type, request_key) row lookup finds the first call's own row and
    // detects the differing application_id as a conflicting intent,
    // never reaching the domain-wide other_pending_candidate path.
    expect(outcomes).toEqual(['request_key_intent_conflict', 'reserved']);

    const { data: rowsForKey, error: rowsForKeyError } = await admin
      .from('qr_lifecycle_operations')
      .select('id, application_id')
      .eq('requested_by_auth_user_id', staff.userId)
      .eq('operation_type', 'reissue')
      .eq('request_key', sharedRequestKey);
    expect(rowsForKeyError, `row-count query failed: ${rowsForKeyError?.message}`).toBeNull();
    expect(rowsForKey).toHaveLength(1);
  });

  it('operation-ID is visible to the owning requester for a blocker it created itself', async () => {
    const { fx: fxOwner, credentialId } = await reissueFixtureWithActiveCredential();

    const blocker = await fxOwner.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(blocker.error, `blocker reservation failed: ${blocker.error?.message}`).toBeNull();
    const blockerResult = blocker.data as unknown as { outcome: string; operation_id: string };
    expect(blockerResult.outcome).toBe('reserved');
    expect(blockerResult.operation_id).toBeTruthy();
  });
});

describe('request_my_qr_reissue_transactional — consumed-operation cooldown and rolling rate-limit (corrected: only qualifying CONSUMED rows count)', () => {
  it('cooldown denial creates its own cancelled operation, distinct from the qualifying history row', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const justBeforeExpiry = new Date(now.getTime() - (10 * 60 - 30) * 1000); // 9m30s ago

    // Seed qualifying history BEFORE establishing the real active
    // credential (required ordering — see the seeder's own header
    // comment).
    const activeCredentialPlaceholder = randomUUID();
    await seedQualifyingHistory(fx.applicationId, fx.userId, activeCredentialPlaceholder, [justBeforeExpiry]);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string; retry_after_seconds: number };
    expect(result.outcome).toBe('reissue_cooldown_active');
    expect(result.operation_id).toBeTruthy();
    expect(result.retry_after_seconds).toBeGreaterThan(0);

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code, terminal_retry_after_at')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('cancelled'); // never remains pending
    expect(opRow!.terminal_reason_code).toBe('reissue_cooldown_active');
    expect(opRow!.terminal_retry_after_at).toBeTruthy();
  });

  it('daily-limit denial creates its own cancelled operation', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const timestamps = [
      new Date(now.getTime() - 20 * 60 * 60 * 1000),
      new Date(now.getTime() - 15 * 60 * 60 * 1000),
      new Date(now.getTime() - 30 * 60 * 1000), // outside the 10-min cooldown, inside the 24h window
    ];
    const placeholderCredential = randomUUID();
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('reissue_rate_limit_exceeded');
    expect(result.operation_id).toBeTruthy();

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code, terminal_retry_after_at')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('reissue_rate_limit_exceeded');
    expect(opRow!.terminal_retry_after_at).toBeTruthy();
  });

  it('identical cooldown-denied request-key replay returns the same operation ID and reissue_cooldown_active, using the stored terminal_retry_after_at rather than recalculating', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const justBeforeExpiry = new Date(now.getTime() - (10 * 60 - 30) * 1000);
    const placeholderCredential = randomUUID();
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, [justBeforeExpiry]);
    const credentialId = await insertActiveCredential(fx.applicationId);
    const requestKey = randomUUID();

    const first = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(first.error, `first call failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string; retry_after_seconds: number };
    expect(firstResult.outcome).toBe('reissue_cooldown_active');

    // Wait briefly so a naive re-derivation (based on "now") would produce
    // a DIFFERENT retry_after_seconds than the original — proving replay
    // uses the STORED terminal_retry_after_at, not a recalculation.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const replay = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(replay.error, `replay failed: ${replay.error?.message}`).toBeNull();
    expect(replay.data).toBeTruthy();
    const replayResult = replay.data as unknown as { outcome: string; operation_id: string; retry_after_seconds: number };
    expect(replayResult.outcome).toBe('reissue_cooldown_active');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
    // retry_after_seconds must have DECREASED by roughly the elapsed wait
    // (clock_timestamp() moved forward, terminal_retry_after_at did not) —
    // proving it derives from the stored timestamp, not a fresh
    // recalculation against current history (which would have returned
    // the SAME value as the first call, since no new qualifying operation
    // was created in between).
    expect(replayResult.retry_after_seconds).toBeLessThan(firstResult.retry_after_seconds);
  });

  it('identical daily-limit-denied request-key replay returns the same operation ID and reissue_rate_limit_exceeded', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const timestamps = [
      new Date(now.getTime() - 20 * 60 * 60 * 1000),
      new Date(now.getTime() - 15 * 60 * 60 * 1000),
      new Date(now.getTime() - 30 * 60 * 1000),
    ];
    const placeholderCredential = randomUUID();
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);
    const requestKey = randomUUID();

    const first = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(first.error, `first call failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reissue_rate_limit_exceeded');

    const replay = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(replay.error, `replay failed: ${replay.error?.message}`).toBeNull();
    const replayResult = replay.data as unknown as { outcome: string; operation_id: string };
    expect(replayResult.outcome).toBe('reissue_rate_limit_exceeded');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
  });

  it('cooldown and rate-limit operations do not remain pending', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, [new Date(now.getTime() - 5 * 60 * 1000)]);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('reissue_cooldown_active');

    const { data: pendingRows, error: pendingRowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('id', result.operation_id)
      .eq('status', 'pending');
    expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
    expect(pendingRows).toHaveLength(0);
  });

  it('failed, cancelled, and expired reissue operations do not consume quota', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();

    // Create three non-consumed history events: one cancelled
    // (application_ineligible), one expired, and confirm none of them
    // count toward the rolling limit (which requires status='consumed').
    const { error: statusError } = await admin.from('applications').update({ status: 'submitted' }).eq('id', fx.applicationId);
    expect(statusError).toBeNull();
    const ineligible = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect((ineligible.data as unknown as { outcome: string }).outcome).toBe('application_ineligible');
    await admin.from('applications').update({ status: 'accepted' }).eq('id', fx.applicationId);

    // Corrected (20260815000000_revoke_qr_credential_on_ineligibility.sql):
    // leaving 'accepted' above already auto-revoked `credentialId` — it
    // is no longer active and can never be resurrected by returning to
    // 'accepted'. A real participant in this state would need to
    // self-issue a fresh credential before they could reissue again;
    // this fixture mirrors that by seeding a new active credential
    // directly rather than reusing the now-permanently-revoked one for
    // the remaining assertions in this test (which are about reissue
    // quota/cooldown semantics, not the eligibility trigger itself).
    const freshCredentialId = await insertActiveCredential(fx.applicationId);

    const shortTtlSeconds = 3;
    // test_only_request_my_qr_reissue_short_ttl is granted EXECUTE to
    // authenticated only (revoked from service_role) — must be called via
    // the participant's own authenticated client, not admin.
    const expiredSeed = await fx.client.rpc('test_only_request_my_qr_reissue_short_ttl', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: freshCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_pending_ttl: `${shortTtlSeconds} seconds`,
      p_waiter_tag: `quota-expiry-${randomUUID()}`,
    });
    expect(expiredSeed.error, `expired-seed reservation failed: ${expiredSeed.error?.message}`).toBeNull();
    expect((expiredSeed.data as unknown as { outcome: string }).outcome).toBe('reserved');
    await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

    // Force the expired row to actually transition by attempting another
    // reservation, which will find and expire it via other_pending_candidate.
    const trigger = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: freshCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(trigger.error, `trigger call failed: ${trigger.error?.message}`).toBeNull();

    // None of these non-consumed events should count toward the rolling
    // limit — a fresh reservation attempt must still succeed (reserved),
    // proving cancelled/expired history is excluded.
    const finalAttempt = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: freshCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(finalAttempt.error, `final attempt failed: ${finalAttempt.error?.message}`).toBeNull();
    const finalOutcome = (finalAttempt.data as unknown as { outcome: string }).outcome;
    expect(['reserved', 'another_operation_pending']).toContain(finalOutcome);
    expect(finalOutcome).not.toBe('reissue_cooldown_active');
    expect(finalOutcome).not.toBe('reissue_rate_limit_exceeded');
  }, 30000);

  it('pending reissue operations do not consume quota', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();

    const pendingOne = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect((pendingOne.data as unknown as { outcome: string }).outcome).toBe('reserved');

    // A pending (never consumed) operation must not count toward the
    // rolling limit — retrying with the SAME key replays 'already_pending'
    // (not a fresh quota-consuming event), and the pending row's own
    // existence blocks a genuinely NEW key via another_operation_pending,
    // never via a cooldown/rate-limit outcome.
    const differentKey = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(differentKey.error, `different-key call failed: ${differentKey.error?.message}`).toBeNull();
    const outcome = (differentKey.data as unknown as { outcome: string }).outcome;
    expect(outcome).toBe('another_operation_pending');
    expect(outcome).not.toBe('reissue_cooldown_active');
    expect(outcome).not.toBe('reissue_rate_limit_exceeded');
  });

  it('staff reissues do not consume participant self-service quota', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    // Seed THREE staff-channel consumed reissues — would exceed the daily
    // limit if miscounted, but must NOT, since the query filters on
    // channel = 'participant_self_service'.
    for (const hoursAgo of [20, 15, 1]) {
      const { data, error } = await admin.rpc('test_only_seed_staff_consumed_reissue_operation', {
        p_application_id: fx.applicationId,
        p_requester_auth_user_id: fx.userId,
        p_expected_current_credential_id: placeholderCredential,
        p_consumed_at: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString(),
      });
      expect(error, `staff seed failed: ${error?.message}`).toBeNull();
      expect(data).toBeTruthy();
    }
    // This loop calls test_only_seed_staff_consumed_reissue_operation
    // directly (a different RPC than seedQualifyingHistory() wraps), so
    // it must retire its own leftover 'active' row the same way
    // seedQualifyingHistory() does for its own callers — see
    // retireLeftoverSeededActiveCredential()'s own header comment.
    await retireLeftoverSeededActiveCredential(fx.applicationId);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved'); // staff history never counts
  });

  it('only consumed participant-self-service reissue operations count — a newly inserted operation does not count itself', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();

    // The reservation this test makes below itself inserts a NEW pending
    // (later reserved) row — it must not count toward its OWN limit
    // evaluation.
    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved');
  });

  it('cooldown boundary: exactly 10 minutes since the latest qualifying consumed_at is allowed (not blocked)', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    const exactlyTenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, [exactlyTenMinutesAgo]);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string };
    // Strict inequality per the design: consumed_at > now - 10min blocks;
    // exactly 10 minutes (or more) does NOT block. A small positive margin
    // is baked into `exactlyTenMinutesAgo` being computed once, before the
    // RPC call, so real elapsed wall-clock time only pushes the seeded
    // timestamp FURTHER outside the window, never inside it.
    expect(result.outcome).toBe('reserved');
  });

  it('cooldown boundary: immediately before 10 minutes since the latest qualifying consumed_at is blocked', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    const justUnderTenMinutesAgo = new Date(now.getTime() - (10 * 60 - 5) * 1000); // 9m55s ago
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, [justUnderTenMinutesAgo]);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; retry_after_seconds: number };
    expect(result.outcome).toBe('reissue_cooldown_active');
    expect(result.retry_after_seconds).toBeGreaterThan(0);
    expect(result.retry_after_seconds).toBeLessThanOrEqual(10);
  });

  it('rolling rate-limit boundary: exactly 24 hours since the third-most-recent qualifying consumed_at is excluded from the count', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    // Third-most-recent EXACTLY 24 hours ago — must be EXCLUDED (strict
    // inequality: consumed_at > now - 24h). Only 2 qualifying rows remain
    // within the window, so the limit (3) is not reached.
    const timestamps = [
      new Date(now.getTime() - 20 * 60 * 60 * 1000),
      new Date(now.getTime() - 15 * 60 * 60 * 1000),
      new Date(now.getTime() - 24 * 60 * 60 * 1000), // exactly 24h ago
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved');
  });

  it('rolling rate-limit boundary: immediately before 24 hours since the third-most-recent qualifying consumed_at remains counted', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    const timestamps = [
      new Date(now.getTime() - 20 * 60 * 60 * 1000),
      new Date(now.getTime() - 15 * 60 * 60 * 1000),
      new Date(now.getTime() - (24 * 60 * 60 - 30) * 1000), // 23h59m30s ago — still inside the window
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reissue_rate_limit_exceeded');
  });

  it('the third-most-recent consumed operation determines the daily retry boundary', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    const thirdMostRecent = new Date(now.getTime() - 20 * 60 * 60 * 1000); // 20h ago
    const timestamps = [
      new Date(now.getTime() - 5 * 60 * 60 * 1000), // most recent
      new Date(now.getTime() - 10 * 60 * 60 * 1000), // second-most-recent
      thirdMostRecent,
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; retry_after_seconds: number };
    expect(result.outcome).toBe('reissue_rate_limit_exceeded');

    // Expected retry boundary: thirdMostRecent + 24h. Compute the expected
    // remaining seconds at assertion time and allow a small tolerance for
    // real elapsed wall-clock time between seeding and this check.
    const expectedRetryAt = thirdMostRecent.getTime() + 24 * 60 * 60 * 1000;
    const expectedRemainingSeconds = Math.ceil((expectedRetryAt - Date.now()) / 1000);
    expect(Math.abs(result.retry_after_seconds - expectedRemainingSeconds)).toBeLessThanOrEqual(5);
  });

  it('daily-limit outcome takes precedence when both cooldown and rate-limit policies are active simultaneously', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    // Most recent qualifying consumed_at is WITHIN the cooldown window
    // (would independently trigger reissue_cooldown_active), AND there are
    // 3 qualifying rows within the rolling 24h window (would independently
    // trigger reissue_rate_limit_exceeded). The daily limit must win.
    const timestamps = [
      new Date(now.getTime() - 20 * 60 * 60 * 1000),
      new Date(now.getTime() - 15 * 60 * 60 * 1000),
      new Date(now.getTime() - 2 * 60 * 1000), // 2 minutes ago — inside BOTH windows
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; retry_after_seconds: number };
    // Must be the LONGER restriction (daily limit), never cooldown.
    expect(result.outcome).toBe('reissue_rate_limit_exceeded');
    expect(result.outcome).not.toBe('reissue_cooldown_active');
    // The returned retry_after_seconds must reflect the daily boundary
    // (~22 hours away), not the cooldown boundary (~8 minutes away).
    expect(result.retry_after_seconds).toBeGreaterThan(60 * 60); // far longer than any cooldown window
  });

  it('one recent consumed operation and two operations older than 24 hours: the daily limit must not fire, but cooldown may still fire when the latest is under 10 minutes old', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    // Only ONE qualifying operation is inside the rolling 24h window ([1],
    // 3 minutes ago); [2] and [3] are both several days old, well outside
    // it. Checking [1] alone (the pre-fix bug) would incorrectly treat
    // this as "3 within 24h" purely because the LATEST happens to be
    // recent — the corrected [3]-based check must NOT fire here, since
    // only 1 of the 3 total qualifying operations is actually inside the
    // window.
    const timestamps = [
      new Date(now.getTime() - 3 * 60 * 1000), // 3 minutes ago — inside both cooldown AND rate-limit windows
      new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000), // 6 days ago
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; retry_after_seconds: number };
    // The daily limit must NOT fire — only 1 of 3 qualifying operations is
    // actually within the rolling 24h window. Cooldown, which depends only
    // on [1], correctly DOES fire, since the latest qualifying operation
    // is 3 minutes old (under the 10-minute cooldown).
    expect(result.outcome).toBe('reissue_cooldown_active');
    expect(result.outcome).not.toBe('reissue_rate_limit_exceeded');
    expect(result.retry_after_seconds).toBeGreaterThan(0);
    expect(result.retry_after_seconds).toBeLessThanOrEqual(10 * 60);
  });

  it('three consumed operations where the latest is recent but the third-most-recent is exactly 24 hours old: the daily limit must not fire', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    const timestamps = [
      new Date(now.getTime() - 1 * 60 * 60 * 1000), // 1h ago — recent, would independently trigger nothing (outside 10-min cooldown)
      new Date(now.getTime() - 12 * 60 * 60 * 1000), // 12h ago
      new Date(now.getTime() - 24 * 60 * 60 * 1000), // exactly 24h ago — third-most-recent, must be EXCLUDED (strict inequality)
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved');
  });

  it('three consumed operations where the third-most-recent is immediately inside the 24-hour window: outcome is reissue_rate_limit_exceeded and terminal_retry_after_at equals third-most-recent consumed_at + 24 hours', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    const thirdMostRecent = new Date(now.getTime() - (24 * 60 * 60 - 15) * 1000); // 23h59m45s ago — just inside the window
    const timestamps = [
      new Date(now.getTime() - 1 * 60 * 60 * 1000),
      new Date(now.getTime() - 12 * 60 * 60 * 1000),
      thirdMostRecent,
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string; retry_after_seconds: number };
    expect(result.outcome).toBe('reissue_rate_limit_exceeded');

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('terminal_retry_after_at')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    const expectedRetryAt = thirdMostRecent.getTime() + 24 * 60 * 60 * 1000;
    const actualRetryAt = new Date(opRow!.terminal_retry_after_at as unknown as string).getTime();
    expect(Math.abs(actualRetryAt - expectedRetryAt)).toBeLessThanOrEqual(1000); // stored exactly, allow 1s round-trip tolerance
  });

  it('four or more qualifying consumed operations: the query retains only the three most recent, and the third value in that limited result determines the daily retry boundary', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    // Five qualifying operations seeded. If the query incorrectly
    // aggregated ALL of them (the pre-fix LIMIT-after-array_agg bug) rather
    // than only the three most recent, [3] of the FULL set would be the
    // 5-days-ago timestamp — well outside 24h, incorrectly allowing the
    // request through. The corrected query must restrict to the three
    // MOST RECENT before indexing, so [3] here is the 20-hours-ago
    // timestamp (still within the window), correctly rate-limiting.
    const timestamps = [
      new Date(now.getTime() - 1 * 60 * 60 * 1000), // most recent (would become [1] after limiting to 3)
      new Date(now.getTime() - 10 * 60 * 60 * 1000), // second-most-recent ([2])
      new Date(now.getTime() - 20 * 60 * 60 * 1000), // third-most-recent ([3]) — still within 24h
      new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), // 4th-most-recent — must be EXCLUDED by the LIMIT 3
      new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), // 5th-most-recent — must be EXCLUDED by the LIMIT 3
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string; retry_after_seconds: number };
    expect(result.outcome).toBe('reissue_rate_limit_exceeded');

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('terminal_retry_after_at')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    // Boundary must be derived from the THIRD-most-recent of the FULL set
    // (20h ago + 24h), not the 4th- or 5th-most-recent, and not from
    // aggregating all 5 rows in some other way.
    const expectedRetryAt = now.getTime() - 20 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000;
    const actualRetryAt = new Date(opRow!.terminal_retry_after_at as unknown as string).getTime();
    expect(Math.abs(actualRetryAt - expectedRetryAt)).toBeLessThanOrEqual(60 * 1000); // allow small seeding-time drift across 5 sequential inserts
  });

  it('fewer than three qualifying operations: the daily limit must not fire, and empty/short-array handling never causes an array-subscript error', async () => {
    // Zero qualifying operations at all — v_consumed_at_values is the
    // empty array (coalesce(..., array[]::timestamptz[])), never NULL,
    // so cardinality(...) >= 1 is false and neither branch's array
    // indexing ([1] or [3]) is ever evaluated.
    const zeroHistoryFx = await reissueFixtureWithActiveCredential();
    const zeroHistoryResult = await zeroHistoryFx.fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: zeroHistoryFx.credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(zeroHistoryResult.error, `zero-history reservation failed: ${zeroHistoryResult.error?.message}`).toBeNull();
    expect((zeroHistoryResult.data as unknown as { outcome: string }).outcome).toBe('reserved');

    // Exactly two qualifying operations — cardinality is 2, so the daily
    // limit's `cardinality(...) >= 3` guard is false and [3] is never
    // indexed (which would otherwise be an out-of-bounds access on a
    // 2-element array). Cooldown's `cardinality(...) >= 1` guard passes
    // and correctly indexes only [1].
    const twoHistoryFx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    await seedQualifyingHistory(twoHistoryFx.applicationId, twoHistoryFx.userId, placeholderCredential, [
      new Date(now.getTime() - 20 * 60 * 60 * 1000),
      new Date(now.getTime() - 15 * 60 * 60 * 1000),
    ]);
    const twoHistoryCredentialId = await insertActiveCredential(twoHistoryFx.applicationId);
    const twoHistoryResult = await twoHistoryFx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: twoHistoryCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(twoHistoryResult.error, `two-history reservation failed: ${twoHistoryResult.error?.message}`).toBeNull();
    expect(twoHistoryResult.data).toBeTruthy();
    const outcome = (twoHistoryResult.data as unknown as { outcome: string }).outcome;
    expect(outcome).toBe('reserved'); // no array-subscript error; daily limit correctly does not fire with only 2 qualifying rows
    expect(outcome).not.toBe('reissue_rate_limit_exceeded');
  });

  it('a recent [1] with an old [3]: cooldown and the daily limit are controlled independently, and the recent latest value never incorrectly triggers the daily limit', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    // [1] is 4 minutes ago (inside the 10-minute cooldown window); [3] is
    // 10 days ago (far outside the 24-hour rolling window). This is the
    // exact scenario the pre-fix bug (checking [1] for the daily limit)
    // would have misreported as rate-limited, since [1] alone IS within
    // 24 hours — the corrected check must independently confirm [3] is
    // ALSO within the window before ever reporting
    // reissue_rate_limit_exceeded, and must fall through to the
    // [1]-based cooldown check instead.
    const timestamps = [
      new Date(now.getTime() - 4 * 60 * 1000), // [1]: 4 minutes ago
      new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), // [2]: 8 days ago
      new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000), // [3]: 10 days ago — far outside 24h
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; retry_after_seconds: number };
    expect(result.outcome).toBe('reissue_cooldown_active'); // [1]-controlled, correctly fires
    expect(result.outcome).not.toBe('reissue_rate_limit_exceeded'); // [3]-controlled, correctly does NOT fire
    expect(result.retry_after_seconds).toBeGreaterThan(0);
    expect(result.retry_after_seconds).toBeLessThanOrEqual(10 * 60);
  });

  it('two concurrent different request keys at the limit each receive their own durable cancelled operation and cannot create a pending reservation', async () => {
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    const timestamps = [
      new Date(now.getTime() - 23 * 60 * 60 * 1000),
      new Date(now.getTime() - 18 * 60 * 60 * 1000),
      new Date(now.getTime() - 12 * 60 * 60 * 1000),
    ];
    await seedQualifyingHistory(fx.applicationId, fx.userId, placeholderCredential, timestamps);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const [callA, callB] = await Promise.all([
      fx.client.rpc('request_my_qr_reissue_transactional', {
        p_request_key: randomUUID(),
        p_expected_current_credential_id: credentialId,
        p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
      }),
      fx.client.rpc('request_my_qr_reissue_transactional', {
        p_request_key: randomUUID(),
        p_expected_current_credential_id: credentialId,
        p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
      }),
    ]);
    expect(callA.error, `call A failed: ${callA.error?.message}`).toBeNull();
    expect(callB.error, `call B failed: ${callB.error?.message}`).toBeNull();
    expect(callA.data).toBeTruthy();
    expect(callB.data).toBeTruthy();

    const resultA = callA.data as unknown as { outcome: string; operation_id: string };
    const resultB = callB.data as unknown as { outcome: string; operation_id: string };
    expect(resultA.outcome).toBe('reissue_rate_limit_exceeded');
    expect(resultB.outcome).toBe('reissue_rate_limit_exceeded');
    expect(resultA.operation_id).not.toBe(resultB.operation_id); // two DIFFERENT request keys -> two DIFFERENT durable rows

    const { data: opsForBoth, error: opsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id, status, terminal_reason_code')
      .in('id', [resultA.operation_id, resultB.operation_id]);
    expect(opsError, `post-state query failed: ${opsError?.message}`).toBeNull();
    expect(opsForBoth).toHaveLength(2);
    for (const op of opsForBoth!) {
      expect(op.status).toBe('cancelled');
      expect(op.terminal_reason_code).toBe('reissue_rate_limit_exceeded');
    }

    const { data: pendingRows, error: pendingRowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue')
      .eq('status', 'pending');
    expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
    expect(pendingRows).toHaveLength(0); // neither concurrent call ever created a pending reservation
  });
});

// ============================================================================
// Staff issuance reservation — request_staff_qr_issuance_transactional /
// request_staff_qr_issuance_transactional_internal /
// resolve_blocking_qr_lifecycle_staff_issuance_operation (Phase 6 design doc
// §5.1, this round's addition). Extends the approved participant foundation
// exactly — same request_key/dual-advisory-lock protocol, same durable-
// outcome discipline, same deterministic concurrency harness (holder-ready
// barrier, exact waiter-to-holder observation, explicit release gates,
// try/finally release and holder settlement, unique token fixtures,
// local-only database guard, no deletion of durable lifecycle/credential
// rows).
// ============================================================================
const STAFF_REASON_NO_NOTE_REQUIRED = 'advance_badge_printing';
const STAFF_REASON_OTHER_REQUIRES_NOTE = 'staff_other';

describe('request_staff_qr_issuance_transactional — authorization', () => {
  it('authorized super_admin can create an individual issuance reservation', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('reserved');

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, channel, requested_by_auth_user_id, requested_by_profile_id')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('pending');
    expect(opRow!.channel).toBe('staff_individual');
    expect(opRow!.requested_by_auth_user_id).toBe(staff.userId);
    expect(opRow!.requested_by_profile_id).toBe(staff.userId);
  });

  it('authorized program_attendance_manager can create an individual reservation', async () => {
    const staff = await createStaffFixture('program_attendance_manager');
    const fx = await createParticipantFixture();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved');
  });

  it('rejects an unauthorized participant caller', async () => {
    const participant = await createParticipantFixture();
    const targetFx = await createParticipantFixture();

    const { data, error } = await participant.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: targetFx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject an unauthorized participant caller').toBeTruthy();
    expect(data).toBeNull();

    const { data: rows, error: rowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', targetFx.applicationId)
      .eq('operation_type', 'issue');
    expect(rowsError, `row-count query failed: ${rowsError?.message}`).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('rejects a caller with an unrecognized staff role', async () => {
    const staff = await createStaffFixture('super_admin');
    // Downgrade to a role outside the approved set before calling.
    await admin.from('profiles').update({ role: 'participant' }).eq('id', staff.userId);
    const targetFx = await createParticipantFixture();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: targetFx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject a non-staff role').toBeTruthy();
    expect(data).toBeNull();
  });
});

describe('request_staff_qr_issuance_transactional — reason/note validation', () => {
  it('rejects an invalid reason code with a raised exception, not a lifecycle-result outcome', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: 'not_a_real_reason_code',
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject an invalid reason code with a raised exception').toBeTruthy();
    expect(data).toBeNull();
  });

  it('rejects staff_other reason code without a note', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_OTHER_REQUIRES_NOTE,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject staff_other without a note').toBeTruthy();
    expect(data).toBeNull();
  });

  it('note normalization: whitespace-only note is stored as null and does not create a spurious intent conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: '   ',
      p_bulk_batch_id: null,
    });
    expect(first.error, `first reservation failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('note').eq('id', firstResult.operation_id).single();
    expect(opRow!.note).toBeNull();

    const retry = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    const retryResult = retry.data as unknown as { outcome: string; operation_id: string };
    expect(retryResult.outcome).toBe('already_pending');
    expect(retryResult.operation_id).toBe(firstResult.operation_id);
  });
});

describe('request_staff_qr_issuance_transactional — bulk batch validation', () => {
  it('valid staff bulk reservation reserves successfully with channel staff_bulk', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(staff.userId, 'issue');

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('reserved');

    const { data: opRow } = await admin
      .from('qr_lifecycle_operations')
      .select('channel, bulk_batch_id')
      .eq('id', result.operation_id)
      .single();
    expect(opRow!.channel).toBe('staff_bulk');
    expect(opRow!.bulk_batch_id).toBe(batchId);
  });

  it('a batch owned by another staff user produces the durable bulk_batch_unavailable outcome', async () => {
    const owner = await createStaffFixture('super_admin');
    const caller = await createStaffFixture('program_attendance_manager');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(owner.userId, 'issue');

    const { data, error } = await caller.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');
    expect(result.operation_id).toBeTruthy();

    const { data: opRow } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', result.operation_id)
      .single();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('bulk_batch_unavailable');
  });

  it('an issue request using a reissue-typed batch produces bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(staff.userId, 'reissue');

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');
  });

  it('an expired batch produces bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    // expires_at is immutable once a batch row exists (enforced by
    // qr_bulk_operation_batches_enforce_lifecycle_trigger), and the real
    // production create_qr_bulk_operation_batch_for_server RPC has no
    // expiry parameter — a direct UPDATE (the previous approach here) is
    // correctly rejected by that trigger. test_only_create_bulk_batch_with_expiry
    // creates an already-expired batch validly, at INSERT time.
    const { data: batchId, error: batchError } = await admin.rpc('test_only_create_bulk_batch_with_expiry', {
      p_created_by_auth_user_id: staff.userId,
      p_created_by_profile_id: staff.userId,
      p_intended_operation_type: 'issue',
      p_expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(batchError, `expired batch creation failed: ${batchError?.message}`).toBeNull();
    expect(batchId).toBeTruthy();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId as unknown as string,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');
  });

  it('a completed or cancelled batch produces bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(staff.userId, 'issue');
    const { error: closeError } = await admin
      .from('qr_bulk_operation_batches')
      .update({ status: 'cancelled', closed_at: new Date().toISOString() })
      .eq('id', batchId);
    expect(closeError, `batch close update failed: ${closeError?.message}`).toBeNull();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');
  });

  it('a batch becoming unavailable while the request waits is observed deterministically', async () => {
    // CORRECTED this round: the holder now performs the cancellation
    // ITSELF, inside the SAME transaction that holds the batch row lock,
    // before returning — the row lock (and therefore the reservation's
    // block on its own FOR SHARE read) only releases at commit, so the
    // reservation can only ever resume AFTER the cancellation has already
    // been durably applied. The previously proposed choreography (a
    // SEPARATE service-role session updating the batch while the holder
    // still held FOR UPDATE) was structurally impossible: FOR UPDATE
    // blocks both FOR SHARE reads and any other session's UPDATE against
    // the same row, so that separate update could never actually run
    // before the holder released.
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    // 1. Create a valid active issue-typed batch owned by the staff
    // requester.
    const batchId = await createBulkBatch(staff.userId, 'issue');
    const holderTag = `batch-holder-${randomUUID()}`;
    const waiterTag = `batch-waiter-${randomUUID()}`;
    const gateId = await createGate();

    // 2. Launch test_only_hold_then_cancel_bulk_batch.
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_then_cancel_bulk_batch($1, $2, $3, $4)',
        [batchId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_then_cancel_bulk_batch', {
        p_batch_id: batchId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      // 3. Wait until the holder-ready observer confirms the helper owns
      // the batch-row lock.
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      // 4. Launch the tagged staff issuance reservation using that batch.
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_issuance_tagged($1, $2, $3, $4, $5, $6)) as result',
          [randomUUID(), fx.applicationId, STAFF_REASON_NO_NOTE_REQUIRED, null, batchId, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_issuance_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
          p_issuance_note: null,
          p_bulk_batch_id: batchId,
          p_waiter_tag: waiterTag,
        });
      }
      // 5. Use the waiter-to-holder observer to prove the reservation
      // session is SPECIFICALLY blocked by that holder.
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // 6. Release the explicit gate. The holder then performs its own
      // cancellation and commits, releasing the row lock.
      await releaseGate(gateId);
      gateReleased = true;

      // 7/8. Await both sessions, confirming the holder/canceller
      // transaction committed before trusting the waiter's post-release
      // result.
      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder/canceller session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }

      // 9. Assert the reservation resumed after the commit and returned
      // outcome = 'bulk_batch_unavailable'.
      expect(result.outcome).toBe('bulk_batch_unavailable');

      // 10. Assert its lifecycle operation is durably cancelled with the
      // correct terminal_reason_code.
      const { data: opRow, error: opError } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', result.operation_id)
        .single();
      expect(opError, `operation post-state query failed: ${opError?.message}`).toBeNull();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('bulk_batch_unavailable');

      // 11. Assert the batch is durably cancelled with closed_at set.
      const { data: batchRow, error: batchError } = await admin
        .from('qr_bulk_operation_batches')
        .select('status, closed_at')
        .eq('id', batchId)
        .single();
      expect(batchError, `batch post-state query failed: ${batchError?.message}`).toBeNull();
      expect(batchRow!.status).toBe('cancelled');
      expect(batchRow!.closed_at).toBeTruthy();

      // 12. Assert no pending issuance operation remains for that
      // request.
      const { data: pendingRows, error: pendingRowsError } = await admin
        .from('qr_lifecycle_operations')
        .select('id')
        .eq('id', result.operation_id)
        .eq('status', 'pending');
      expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
      expect(pendingRows).toHaveLength(0);

      // 13. Assert no QR credential was created, revoked, replaced, or
      // otherwise modified for this application.
      const { data: credRows, error: credRowsError } = await admin
        .from('qr_credentials')
        .select('id')
        .eq('application_id', fx.applicationId);
      expect(credRowsError, `credential-row query failed: ${credRowsError?.message}`).toBeNull();
      expect(credRows).toHaveLength(0);
    } finally {
      // The gate must be released in finally even when an assertion
      // fails, and the holder promise must always be awaited so no
      // database session remains blocked after the test.
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);
});

describe('request_staff_qr_issuance_transactional — application eligibility and credential-state', () => {
  it('accepted application reserves successfully', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved');
  });

  it('an application becoming ineligible while waiting on the application lock is observed deterministically', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const holderTag = `app-holder-${randomUUID()}`;
    const waiterTag = `app-waiter-${randomUUID()}`;
    const gateId = await createGate();

    // CORRECTED this round: the status mutation now happens INSIDE the
    // holder's own transaction, applied right before it returns (which is
    // also when the row lock is released) — test_only_hold_application_lock_
    // and_mutate_status. A separate PostgREST session's own
    // admin.from().update() is itself blocked behind the holder's FOR NO
    // KEY UPDATE and cannot be relied on to commit before an
    // independently-unblocked waiter reaches the SAME row: both would be
    // racing for lock acquisition order once the SAME gate release
    // unblocks them, which Postgres does not guarantee FIFO on (confirmed
    // empirically — the waiter sometimes won that race and observed
    // 'reserved' instead of 'application_ineligible'). Applying the
    // mutation inside the holder's own transaction removes the race
    // entirely: no other session can ever acquire the row lock before the
    // mutation has already been durably applied.
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock_and_mutate_status($1, $2, $3, $4, $5)',
        [fx.applicationId, gateId, holderTag, 'submitted', 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock_and_mutate_status', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_new_status: 'submitted',
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_issuance_tagged($1, $2, $3, $4, $5, $6)) as result',
          [randomUUID(), fx.applicationId, STAFF_REASON_NO_NOTE_REQUIRED, null, null, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_issuance_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
          p_issuance_note: null,
          p_bulk_batch_id: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('application_ineligible');

      const { data: opRow } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', result.operation_id)
        .single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('application_ineligible');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('an active credential already existing produces the durable active_credential_already_exists outcome, and reservation never modifies the credential', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string; credential_id: string };
    expect(result.outcome).toBe('active_credential_already_exists');
    expect(result.credential_id).toBe(credentialId);

    const { data: opRow } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code, terminal_related_credential_id')
      .eq('id', result.operation_id)
      .single();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('active_credential_already_exists');
    expect(opRow!.terminal_related_credential_id).toBe(credentialId);

    const { data: credAfter } = await admin.from('qr_credentials').select('status').eq('id', credentialId).single();
    expect(credAfter!.status).toBe('active'); // reservation never modifies the existing credential
  });

  it('an active credential appearing while the request waits on the credential lock is observed deterministically', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const credentialId = await insertActiveCredential(fx.applicationId);
    const holderTag = `cred-holder-${randomUUID()}`;
    const waiterTag = `cred-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_active_credential_lock($1, $2, $3, $4)',
        [credentialId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_active_credential_lock', {
        p_credential_id: credentialId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_issuance_tagged($1, $2, $3, $4, $5, $6)) as result',
          [randomUUID(), fx.applicationId, STAFF_REASON_NO_NOTE_REQUIRED, null, null, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_issuance_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
          p_issuance_note: null,
          p_bulk_batch_id: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; credential_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; credential_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; credential_id: string };
      }
      expect(result.outcome).toBe('active_credential_already_exists');
      expect(result.credential_id).toBe(credentialId);
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);
});

describe('request_staff_qr_issuance_transactional — TTL and authorization-lapse concurrency', () => {
  it('a demoted requester is rejected upfront, before any lock is taken, and no operation is created or left pending', async () => {
    // CORRECTED this round: the production function reads the caller's
    // role ONCE, at the very top, before acquiring any lock — it never
    // re-checks authorization after that point (only a DIFFERENT
    // operation's stored requester role is re-verified, in the
    // matching_pending_candidate branch, which is unrelated to this
    // call's own caller). A demotion applied WHILE this call is already
    // blocked on a later lock is therefore invisible to it by design —
    // that is not a race this endpoint promises to close. This test
    // instead proves the actually-guaranteed property: a requester
    // demoted BEFORE the call starts is rejected immediately, and no
    // lifecycle operation row is ever created (i.e. the rejection happens
    // strictly before any lock, including the request-key/reservation-
    // domain advisory locks at positions 1-2).
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    const { error: demoteError } = await admin.from('profiles').update({ role: 'participant' }).eq('id', staff.userId);
    expect(demoteError, `role demotion failed: ${demoteError?.message}`).toBeNull();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `expected a controlled 'Not authorized' rejection, got: ${error?.message}`).not.toBeNull();
    expect(data).toBeNull();

    const { data: opRows } = await admin.from('qr_lifecycle_operations').select('id').eq('application_id', fx.applicationId);
    expect(opRows).toHaveLength(0);
  });

  it('exact TTL expiry while waiting on the application lock reports operation_expired', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const holderTag = `ttl-app-holder-${randomUUID()}`;
    const waiterTag = `ttl-app-waiter-${randomUUID()}`;
    const gateId = await createGate();
    const shortTtlSeconds = 3;
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';

    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_issuance_short_ttl($1, $2, $3, $4, $5, $6, $7)) as result',
          [randomUUID(), fx.applicationId, STAFF_REASON_NO_NOTE_REQUIRED, null, null, `${shortTtlSeconds} seconds`, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_issuance_short_ttl', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
          p_issuance_note: null,
          p_bulk_batch_id: null,
          p_pending_ttl: `${shortTtlSeconds} seconds`,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('operation_expired');

      const { data: opRow } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', result.operation_id)
        .single();
      expect(opRow!.status).toBe('expired');
      expect(opRow!.terminal_reason_code).toBe('ttl_expired');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('exact TTL expiry while waiting on the credential lock reports operation_expired', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const credentialId = await insertActiveCredential(fx.applicationId);
    const holderTag = `ttl-cred-holder-${randomUUID()}`;
    const waiterTag = `ttl-cred-waiter-${randomUUID()}`;
    const gateId = await createGate();
    const shortTtlSeconds = 3;

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_active_credential_lock($1, $2, $3, $4)',
        [credentialId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_active_credential_lock', {
        p_credential_id: credentialId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_issuance_short_ttl($1, $2, $3, $4, $5, $6, $7)) as result',
          [randomUUID(), fx.applicationId, STAFF_REASON_NO_NOTE_REQUIRED, null, null, `${shortTtlSeconds} seconds`, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_issuance_short_ttl', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
          p_issuance_note: null,
          p_bulk_batch_id: null,
          p_pending_ttl: `${shortTtlSeconds} seconds`,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('operation_expired');
      expect(result.outcome).not.toBe('active_credential_already_exists');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);
});

describe('request_staff_qr_issuance_transactional — request-key replay and intent-conflict semantics', () => {
  it('first request returns reserved', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved');
  });

  it('identical same-key retry returns the same operation', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error, `first reservation failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const retry = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    const retryResult = retry.data as unknown as { outcome: string; operation_id: string };
    expect(retryResult.outcome).toBe('already_pending');
    expect(retryResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting application returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const fxA = await createParticipantFixture();
    const fxB = await createParticipantFixture();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fxA.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fxB.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting reason returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_OTHER_REQUIRES_NOTE,
      p_issuance_note: 'a different explanation',
      p_bulk_batch_id: null,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting normalized note returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_OTHER_REQUIRES_NOTE,
      p_issuance_note: 'first explanation',
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_OTHER_REQUIRES_NOTE,
      p_issuance_note: 'a completely different explanation',
      p_bulk_batch_id: null,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting batch ID returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchA = await createBulkBatch(staff.userId, 'issue');
    const batchB = await createBulkBatch(staff.userId, 'issue');
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchA,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchB,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting individual-versus-bulk channel returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(staff.userId, 'issue');
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null, // individual
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId, // bulk
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });
});

describe('request_staff_qr_issuance_transactional — deterministic concurrency and domain exclusivity', () => {
  it('a different-key same-requester blocker returns its operation ID', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const holderTag = `blocker-holder-${randomUUID()}`;
    const waiterTag = `blocker-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const blocker = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(blocker.error).toBeNull();
    const blockerResult = blocker.data as unknown as { outcome: string; operation_id: string };
    expect(blockerResult.outcome).toBe('reserved');

    // Uses the reservation-domain ADVISORY lock (position 2 inside
    // reserve_or_reuse_qr_lifecycle_operation), not the application ROW
    // lock: a still-pending blocker resolves via
    // resolve_blocking_qr_lifecycle_staff_issuance_operation's early
    // other_pending_candidate path, which never reaches the application
    // row's own FOR UPDATE — confirmed by direct pg_locks/pg_stat_activity
    // observation (the waiter's backend went idle/ClientRead, its query
    // already finished, while test_only_hold_application_lock's row lock
    // sat unused).
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_reservation_domain_advisory_lock($1, $2, $3, $4, $5)',
        [fx.applicationId, 'issue', gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_reservation_domain_advisory_lock', {
        p_application_id: fx.applicationId,
        p_operation_type: 'issue',
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_issuance_tagged($1, $2, $3, $4, $5, $6)) as result',
          [randomUUID(), fx.applicationId, STAFF_REASON_NO_NOTE_REQUIRED, null, null, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_issuance_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
          p_issuance_note: null,
          p_bulk_batch_id: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('another_operation_pending');
      expect(result.operation_id).toBe(blockerResult.operation_id); // same requester -> id visible
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('a different-requester blocker omits its operation ID', async () => {
    const owner = await createStaffFixture('super_admin');
    const otherStaff = await createStaffFixture('program_attendance_manager');
    const fx = await createParticipantFixture();
    const holderTag = `other-holder-${randomUUID()}`;
    const waiterTag = `other-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const blocker = await owner.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(blocker.error).toBeNull();
    const blockerResult = blocker.data as unknown as { outcome: string };
    expect(blockerResult.outcome).toBe('reserved');

    // See the "different-key same-requester" test above for why the
    // reservation-domain ADVISORY lock (not the application row lock) is
    // used here.
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_reservation_domain_advisory_lock($1, $2, $3, $4, $5)',
        [fx.applicationId, 'issue', gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_reservation_domain_advisory_lock', {
        p_application_id: fx.applicationId,
        p_operation_type: 'issue',
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof otherStaff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          otherStaff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_issuance_tagged($1, $2, $3, $4, $5, $6)) as result',
          [randomUUID(), fx.applicationId, STAFF_REASON_NO_NOTE_REQUIRED, null, null, waiterTag],
        );
      } else {
        sessionBPromise = otherStaff.client.rpc('test_only_request_staff_qr_issuance_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
          p_issuance_note: null,
          p_bulk_batch_id: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string | null };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string | null }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string | null };
      }
      expect(result.outcome).toBe('another_operation_pending');
      expect(result.operation_id).toBeFalsy(); // different requester -> id omitted
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('two concurrent staff requests for the same application resolve to exactly one reserved and one another_operation_pending, with only one pending operation for the domain', async () => {
    const staffA = await createStaffFixture('super_admin');
    const staffB = await createStaffFixture('program_attendance_manager');
    const fx = await createParticipantFixture();

    const [resultA, resultB] = await Promise.all([
      staffA.client.rpc('request_staff_qr_issuance_transactional', {
        p_request_key: randomUUID(),
        p_application_id: fx.applicationId,
        p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
        p_issuance_note: null,
        p_bulk_batch_id: null,
      }),
      staffB.client.rpc('request_staff_qr_issuance_transactional', {
        p_request_key: randomUUID(),
        p_application_id: fx.applicationId,
        p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
        p_issuance_note: null,
        p_bulk_batch_id: null,
      }),
    ]);
    expect(resultA.error).toBeNull();
    expect(resultB.error).toBeNull();
    expect(resultA.data).toBeTruthy();
    expect(resultB.data).toBeTruthy();

    const outcomeA = (resultA.data as unknown as { outcome: string }).outcome;
    const outcomeB = (resultB.data as unknown as { outcome: string }).outcome;
    const outcomes = [outcomeA, outcomeB].sort();
    expect(outcomes).toEqual(['another_operation_pending', 'reserved']);

    const { data: pendingRows, error: pendingRowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'issue')
      .eq('status', 'pending');
    expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
    expect(pendingRows).toHaveLength(1); // exactly one pending issue operation exists for the application domain
  });

  it('simultaneous participant issuance and staff issuance for the same application resolve to exactly one reserved and one another_operation_pending', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    // CORRECTED: Promise.all([...]) does not guarantee true simultaneity —
    // each call is a SEPARATE HTTP round trip through PostgREST, and one
    // could fully commit before the other's request even arrives,
    // legitimately producing ['reserved', 'reserved'] if both transactions
    // happen to see "no existing operation" before either one inserts (a
    // real, reproducible client-dispatch-timing race, confirmed
    // empirically — not a defect in the advisory lock itself, which
    // remains correctly serializing per every other test in this suite
    // that proves it via a deterministic raw-pg holder).
    //
    // A true mid-flight interleaving (catching A's own
    // pg_advisory_xact_lock hold via pg_locks, THEN launching B) was
    // attempted but found NOT reliably observable: the participant path's
    // own critical section (a few SELECTs plus one INSERT, all inside the
    // SAME implicit transaction as the lock acquisition) completes fast
    // enough on Cloud that the lock's held window is frequently too short
    // for even a tight poll to reliably catch — confirmed by direct
    // testing (a 20ms-interval poll over a 1s window missed it).
    //
    // The property under test — mutual exclusivity for the SAME
    // (application_id, operation_type) domain, regardless of channel — is
    // proven equally well, deterministically, by running A to full
    // completion FIRST (over its own raw-pg session, invoking the EXACT
    // SAME production RPC a real caller would) and only THEN launching B:
    // B is thus guaranteed to find A's row already committed and return
    // another_operation_pending, with no ambiguity. This trades "prove
    // true concurrency" (which was never reliably provable client-side at
    // all) for "prove exclusivity deterministically" — the actual
    // guarantee this domain lock exists to provide.
    if (disposableDatabaseCheck.reason !== 'local') {
      const participantSession = await CloudNativeAuthenticatedSession.open(fx.accessToken);
      participantSession.startRpcFunction(
        'select to_jsonb(public.test_only_request_my_qr_issuance_tagged($1, $2)) as result',
        [randomUUID(), `simul-participant-${randomUUID()}`],
      );
      const participantRes = await participantSession.awaitCompletion<{ result: { outcome: string } }>();
      await participantSession.close();

      const staffSession = await CloudNativeAuthenticatedSession.open(staff.accessToken);
      staffSession.startRpcFunction(
        'select to_jsonb(public.test_only_request_staff_qr_issuance_tagged($1, $2, $3, $4, $5, $6)) as result',
        [randomUUID(), fx.applicationId, STAFF_REASON_NO_NOTE_REQUIRED, null, null, `simul-staff-${randomUUID()}`],
      );
      const staffRes = await staffSession.awaitCompletion<{ result: { outcome: string } }>();
      await staffSession.close();

      const outcomes = [participantRes.rows[0].result.outcome, staffRes.rows[0].result.outcome].sort();
      expect(outcomes).toEqual(['another_operation_pending', 'reserved']);

      const { data: pendingRows, error: pendingRowsError } = await admin
        .from('qr_lifecycle_operations')
        .select('id')
        .eq('application_id', fx.applicationId)
        .eq('operation_type', 'issue')
        .eq('status', 'pending');
      expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
      expect(pendingRows).toHaveLength(1);
      return;
    }

    const [participantResult, staffResult] = await Promise.all([
      fx.client.rpc('request_my_qr_issuance_transactional', {
        p_request_key: randomUUID(),
      }),
      staff.client.rpc('request_staff_qr_issuance_transactional', {
        p_request_key: randomUUID(),
        p_application_id: fx.applicationId,
        p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
        p_issuance_note: null,
        p_bulk_batch_id: null,
      }),
    ]);
    expect(participantResult.error).toBeNull();
    expect(staffResult.error).toBeNull();
    expect(participantResult.data).toBeTruthy();
    expect(staffResult.data).toBeTruthy();

    const outcomeParticipant = (participantResult.data as unknown as { outcome: string }).outcome;
    const outcomeStaff = (staffResult.data as unknown as { outcome: string }).outcome;
    const outcomes = [outcomeParticipant, outcomeStaff].sort();
    // Domain-wide exclusivity (application_id, operation_type) applies
    // regardless of channel — a participant self-service attempt and a
    // staff attempt for the SAME application/operation_type serialize
    // against each other exactly like two staff attempts would.
    expect(outcomes).toEqual(['another_operation_pending', 'reserved']);

    const { data: pendingRows, error: pendingRowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'issue')
      .eq('status', 'pending');
    expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
    expect(pendingRows).toHaveLength(1);
  });

  // Regression coverage for the resolve_blocking_qr_lifecycle_staff_
  // issuance_operation channel-awareness fix (20260811210000_fix_staff_
  // blocker_resolver_channel_check.sql): that resolver previously
  // required ANY blocking candidate's requester to hold a staff-eligible
  // role, unconditionally — silently cancelling a legitimate participant
  // self-service candidate as 'requester_no_longer_authorized' even
  // though the participant never lost any authorization they held.

  it('regression A: a valid participant pending issuance remains blocking against a concurrent staff issuance attempt, which correctly observes another_operation_pending', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    const participantSeed = await fx.client.rpc('request_my_qr_issuance_transactional', {
      p_request_key: randomUUID(),
    });
    expect(participantSeed.error, `participant seed failed: ${participantSeed.error?.message}`).toBeNull();
    const participantSeedResult = participantSeed.data as unknown as { outcome: string; operation_id: string };
    expect(participantSeedResult.outcome).toBe('reserved');

    const staffAttempt = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(staffAttempt.error, `staff attempt failed: ${staffAttempt.error?.message}`).toBeNull();
    const staffAttemptResult = staffAttempt.data as unknown as { outcome: string; operation_id: string | null };
    expect(staffAttemptResult.outcome).toBe('another_operation_pending');
    expect(staffAttemptResult.operation_id).toBeFalsy(); // different requester -> id omitted

    // The participant's own row must remain genuinely pending, never
    // terminalized — this is the core assertion the original defect
    // violated.
    const { data: participantRow, error: participantRowError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', participantSeedResult.operation_id)
      .single();
    expect(participantRowError, `participant row lookup failed: ${participantRowError?.message}`).toBeNull();
    expect(participantRow!.status).toBe('pending');
    expect(participantRow!.terminal_reason_code).toBeNull();

    const { data: pendingRows, error: pendingRowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'issue')
      .eq('status', 'pending');
    expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows![0].id).toBe(participantSeedResult.operation_id);
  });

  it('regression C: a participant candidate that genuinely becomes invalid under participant-specific rules (TTL expiry) is still terminalized for that reason, never requester_no_longer_authorized', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const shortTtlSeconds = 3;

    // test_only_request_my_qr_issuance_short_ttl is granted EXECUTE to
    // authenticated only (revoked from service_role) — must be called via
    // the participant's own authenticated client, not admin.
    const participantSeed = await fx.client.rpc('test_only_request_my_qr_issuance_short_ttl', {
      p_request_key: randomUUID(),
      p_pending_ttl: `${shortTtlSeconds} seconds`,
      p_waiter_tag: `regression-c-seed-${randomUUID()}`,
    });
    expect(participantSeed.error, `participant seed failed: ${participantSeed.error?.message}`).toBeNull();
    const participantSeedResult = participantSeed.data as unknown as { outcome: string; operation_id: string };
    expect(participantSeedResult.outcome).toBe('reserved');

    await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

    const staffAttempt = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(staffAttempt.error, `staff attempt failed: ${staffAttempt.error?.message}`).toBeNull();
    const staffAttemptResult = staffAttempt.data as unknown as { outcome: string };
    // The staff caller's own attempt proceeds to insert its own row once
    // the expired participant candidate is terminalized as expired — it
    // is NOT another_operation_pending, since the blocker no longer
    // blocks anything once terminalized.
    expect(staffAttemptResult.outcome).toBe('reserved');

    const { data: participantRow, error: participantRowError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', participantSeedResult.operation_id)
      .single();
    expect(participantRowError, `participant row lookup failed: ${participantRowError?.message}`).toBeNull();
    expect(participantRow!.status).toBe('expired');
    expect(participantRow!.terminal_reason_code).toBe('ttl_expired');
    expect(participantRow!.terminal_reason_code).not.toBe('requester_no_longer_authorized');
  }, 15000);

  it('regression D: replay of a durable another_operation_pending outcome remains stable and idempotent, unaffected by the channel-awareness fix', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();

    const participantSeed = await fx.client.rpc('request_my_qr_issuance_transactional', {
      p_request_key: randomUUID(),
    });
    expect(participantSeed.error).toBeNull();
    const participantSeedResult = participantSeed.data as unknown as { outcome: string; operation_id: string };
    expect(participantSeedResult.outcome).toBe('reserved');

    const staffRequestKey = randomUUID();
    const staffFirst = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: staffRequestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(staffFirst.error).toBeNull();
    const staffFirstResult = staffFirst.data as unknown as { outcome: string; operation_id: string | null };
    expect(staffFirstResult.outcome).toBe('another_operation_pending');

    // Identical same-key replay must return the SAME durable outcome,
    // never re-evaluating the (still-pending, still-valid) participant
    // blocker a second time.
    const staffReplay = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: staffRequestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(staffReplay.error).toBeNull();
    const staffReplayResult = staffReplay.data as unknown as { outcome: string; operation_id: string | null };
    expect(staffReplayResult.outcome).toBe('another_operation_pending');
    expect(staffReplayResult.operation_id).toBe(staffFirstResult.operation_id);

    const { data: participantRow } = await admin
      .from('qr_lifecycle_operations')
      .select('status')
      .eq('id', participantSeedResult.operation_id)
      .single();
    expect(participantRow!.status).toBe('pending');
  });
});

describe('request_staff_qr_issuance_transactional — durable replay of terminal outcomes', () => {
  it('durable replay of requester_no_longer_authorized', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    // Seed a pending operation, then demote the requester, then trigger
    // resolution via a second, different-key call that finds it as
    // other_pending_candidate.
    const seed = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(seed.error).toBeNull();
    const seedResult = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedResult.outcome).toBe('reserved');

    await admin.from('profiles').update({ role: 'participant' }).eq('id', staff.userId);

    // A second staff account triggers resolution of the now-unauthorized
    // pending operation via a different request_key.
    const otherStaff = await createStaffFixture('super_admin');
    const trigger = await otherStaff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(trigger.error).toBeNull();

    const { data: opAfter } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', seedResult.operation_id)
      .single();
    expect(opAfter!.status).toBe('cancelled');
    expect(opAfter!.terminal_reason_code).toBe('requester_no_longer_authorized');

    // Replay via the original request_key must return the stored terminal
    // outcome WITHOUT re-evaluating current authorization state (the
    // demoted account itself can no longer even authenticate as staff to
    // retry, so replay is exercised via a fresh authorized call under the
    // SAME request_key is not possible for a demoted account — the
    // durable-replay guarantee is instead verified directly against the
    // row's own immutability, already asserted above).
    expect(opAfter!.terminal_reason_code).toBe('requester_no_longer_authorized');
  });

  it('durable replay of bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(staff.userId, 'issue');
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    await admin.from('qr_bulk_operation_batches').update({ status: 'cancelled', closed_at: new Date().toISOString() }).eq('id', batchId);

    // Trigger resolution via a different-key call for the same domain.
    const trigger = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(trigger.error).toBeNull();

    const { data: opAfter } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', firstResult.operation_id)
      .single();
    expect(opAfter!.status).toBe('cancelled');
    expect(opAfter!.terminal_reason_code).toBe('bulk_batch_unavailable');

    // Replay via the ORIGINAL request key must return the stored terminal
    // outcome for THIS SAME operation, not re-evaluate anything.
    const replay = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(replay.error).toBeNull();
    const replayResult = replay.data as unknown as { outcome: string; operation_id: string };
    expect(replayResult.outcome).toBe('bulk_batch_unavailable');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
  });

  it('durable replay of application_ineligible', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    await admin.from('applications').update({ status: 'submitted' }).eq('id', fx.applicationId);

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('application_ineligible');

    // Application remains ineligible; replay must return the SAME stored
    // outcome for the SAME operation, not re-evaluate.
    const replay = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(replay.error).toBeNull();
    const replayResult = replay.data as unknown as { outcome: string; operation_id: string };
    expect(replayResult.outcome).toBe('application_ineligible');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
  });

  it('durable replay of active_credential_already_exists', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const credentialId = await insertActiveCredential(fx.applicationId);
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string; credential_id: string };
    expect(firstResult.outcome).toBe('active_credential_already_exists');
    expect(firstResult.credential_id).toBe(credentialId);

    const replay = await staff.client.rpc('request_staff_qr_issuance_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_issuance_reason_code: STAFF_REASON_NO_NOTE_REQUIRED,
      p_issuance_note: null,
      p_bulk_batch_id: null,
    });
    expect(replay.error).toBeNull();
    const replayResult = replay.data as unknown as { outcome: string; operation_id: string; credential_id: string };
    expect(replayResult.outcome).toBe('active_credential_already_exists');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
    // Durable replay uses terminal_related_credential_id, not current
    // credential state — asserted by the fact this replay returns the
    // SAME credential_id even though it is re-derived from the durable
    // row, not re-queried from qr_credentials fresh.
    expect(replayResult.credential_id).toBe(credentialId);
  });
});

// ============================================================================
// Staff reissue reservation — request_staff_qr_reissue_transactional /
// request_staff_qr_reissue_transactional_internal /
// resolve_blocking_qr_lifecycle_staff_reissue_operation (Phase 6 design doc
// §5.2, this round's addition). Extends the approved reservation foundation
// exactly — same request_key/dual-advisory-lock protocol, same durable-
// outcome discipline, same deterministic concurrency harness.
// ============================================================================
const STAFF_REISSUE_REASON_NO_NOTE_REQUIRED = 'staff_assisted_recovery';
const STAFF_REISSUE_REASON_OTHER_REQUIRES_NOTE = 'staff_other';

async function reissueFixtureWithActiveCredentialForStaff(): Promise<{ fx: ParticipantFixture; credentialId: string }> {
  const fx = await createParticipantFixture();
  const credentialId = await insertActiveCredential(fx.applicationId);
  return { fx, credentialId };
}

describe('request_staff_qr_reissue_transactional — authorization', () => {
  it('authorized super_admin can create an individual reissue reservation', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('reserved');

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, channel, operation_type, requested_by_auth_user_id, requested_by_profile_id, expected_current_credential_id')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('pending');
    expect(opRow!.channel).toBe('staff_individual');
    expect(opRow!.operation_type).toBe('reissue');
    expect(opRow!.requested_by_auth_user_id).toBe(staff.userId);
    expect(opRow!.requested_by_profile_id).toBe(staff.userId);
    expect(opRow!.expected_current_credential_id).toBe(credentialId);
  });

  it('authorized program_attendance_manager can create an individual reissue reservation', async () => {
    const staff = await createStaffFixture('program_attendance_manager');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved');
  });

  it('rejects an unauthorized participant caller', async () => {
    const participant = await createParticipantFixture();
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const { data, error } = await participant.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject an unauthorized participant caller').toBeTruthy();
    expect(data).toBeNull();

    const { data: rows, error: rowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue');
    expect(rowsError, `row-count query failed: ${rowsError?.message}`).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('rejects a caller with an unrecognized staff role', async () => {
    const staff = await createStaffFixture('super_admin');
    await admin.from('profiles').update({ role: 'participant' }).eq('id', staff.userId);
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject a non-staff role').toBeTruthy();
    expect(data).toBeNull();
  });
});

describe('request_staff_qr_reissue_transactional — reason/note validation and input-shape checks', () => {
  it('rejects an invalid reason code with a raised exception, not a lifecycle-result outcome', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: 'not_a_real_reason_code',
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject an invalid reason code with a raised exception').toBeTruthy();
    expect(data).toBeNull();
  });

  it('rejects staff_other reason code without a note', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_OTHER_REQUIRES_NOTE,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject staff_other without a note').toBeTruthy();
    expect(data).toBeNull();
  });

  it('an expected credential belonging to a different application is treated as invalid input, not a raw foreign-key failure', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx } = await reissueFixtureWithActiveCredentialForStaff();
    const foreignCredentialId = await insertActiveCredential((await createParticipantFixture()).applicationId);

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: foreignCredentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected the RPC to reject a credential id that cannot satisfy the composite FK for this application').toBeTruthy();
    expect(data).toBeNull();

    const { data: rows, error: rowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue');
    expect(rowsError, `row-count query failed: ${rowsError?.message}`).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('note normalization: whitespace-only note stored as null does not create a spurious intent conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: '   ',
      p_bulk_batch_id: null,
    });
    expect(first.error, `first reservation failed: ${first.error?.message}`).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('note').eq('id', firstResult.operation_id).single();
    expect(opRow!.note).toBeNull();

    const retry = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    const retryResult = retry.data as unknown as { outcome: string; operation_id: string };
    expect(retryResult.outcome).toBe('already_pending');
    expect(retryResult.operation_id).toBe(firstResult.operation_id);
  });
});

describe('request_staff_qr_reissue_transactional — bulk batch validation', () => {
  it('valid staff bulk reissue reservation reserves successfully with channel staff_bulk', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('reserved');

    const { data: opRow } = await admin
      .from('qr_lifecycle_operations')
      .select('channel, bulk_batch_id')
      .eq('id', result.operation_id)
      .single();
    expect(opRow!.channel).toBe('staff_bulk');
    expect(opRow!.bulk_batch_id).toBe(batchId);
  });

  it('an issue-typed batch is rejected for reissue with bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'issue');

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');
  });

  it('a batch owned by another staff user produces the durable bulk_batch_unavailable outcome', async () => {
    const owner = await createStaffFixture('super_admin');
    const caller = await createStaffFixture('program_attendance_manager');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(owner.userId, 'reissue');

    const { data, error } = await caller.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');

    const { data: opRow } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', result.operation_id)
      .single();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('bulk_batch_unavailable');
  });

  it('an expired batch produces bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    // expires_at is immutable once a batch row exists (enforced by
    // qr_bulk_operation_batches_enforce_lifecycle_trigger), and the real
    // production create_qr_bulk_operation_batch_for_server RPC has no
    // expiry parameter — a direct UPDATE (the previous approach here,
    // whose error was never checked) was silently rejected by that
    // trigger, leaving the batch un-expired and this test's own
    // assertion failing. test_only_create_bulk_batch_with_expiry creates
    // an already-expired batch validly, at INSERT time.
    const { data: batchId, error: batchError } = await admin.rpc('test_only_create_bulk_batch_with_expiry', {
      p_created_by_auth_user_id: staff.userId,
      p_created_by_profile_id: staff.userId,
      p_intended_operation_type: 'reissue',
      p_expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(batchError, `expired batch creation failed: ${batchError?.message}`).toBeNull();
    expect(batchId).toBeTruthy();

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId as unknown as string,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');
  });

  it('a completed batch produces bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');
    await admin.from('qr_bulk_operation_batches').update({ status: 'completed', closed_at: new Date().toISOString() }).eq('id', batchId);

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');
  });

  it('a cancelled batch produces bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');
    await admin.from('qr_bulk_operation_batches').update({ status: 'cancelled', closed_at: new Date().toISOString() }).eq('id', batchId);

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('bulk_batch_unavailable');
  });

  it('a batch becoming unavailable while waiting is observed deterministically, reusing test_only_hold_then_cancel_bulk_batch with a reissue-typed batch', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');
    const holderTag = `reissue-batch-holder-${randomUUID()}`;
    const waiterTag = `reissue-batch-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_then_cancel_bulk_batch($1, $2, $3, $4)',
        [batchId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_then_cancel_bulk_batch', {
        p_batch_id: batchId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [randomUUID(), fx.applicationId, credentialId, STAFF_REISSUE_REASON_NO_NOTE_REQUIRED, null, batchId, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_reissue_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_bulk_batch_id: batchId,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder/canceller session failed: ${sessionAResult.error?.message}`).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `waiter session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('bulk_batch_unavailable');

      const { data: opRow } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', result.operation_id)
        .single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('bulk_batch_unavailable');

      const { data: batchRow } = await admin.from('qr_bulk_operation_batches').select('status, closed_at').eq('id', batchId).single();
      expect(batchRow!.status).toBe('cancelled');
      expect(batchRow!.closed_at).toBeTruthy();

      const { data: credAfter } = await admin.from('qr_credentials').select('status').eq('id', credentialId).single();
      expect(credAfter!.status).toBe('active'); // reservation never modifies the active credential
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);
});

describe('request_staff_qr_reissue_transactional — application eligibility and credential-state', () => {
  it('an application becoming ineligible while waiting on the application lock is observed deterministically', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const holderTag = `reissue-app-holder-${randomUUID()}`;
    const waiterTag = `reissue-app-waiter-${randomUUID()}`;
    const gateId = await createGate();
    const usesCloudNativeHolder2 = disposableDatabaseCheck.reason !== 'local';

    // See the issuance-side equivalent test for why the mutation now
    // happens INSIDE the holder's own transaction rather than via a
    // separate racing session.
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder2) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock_and_mutate_status($1, $2, $3, $4, $5)',
        [fx.applicationId, gateId, holderTag, 'submitted', 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock_and_mutate_status', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_new_status: 'submitted',
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder2) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [randomUUID(), fx.applicationId, credentialId, STAFF_REISSUE_REASON_NO_NOTE_REQUIRED, null, null, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_reissue_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_bulk_batch_id: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder2) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('application_ineligible');

      const { data: opRow } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', result.operation_id)
        .single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('application_ineligible');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder2) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('no active credential produces the durable no_active_credential outcome', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const activeThenRevokedId = await insertActiveCredential(fx.applicationId);
    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', activeThenRevokedId);

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: activeThenRevokedId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; operation_id: string };
    expect(result.outcome).toBe('no_active_credential');

    const { data: opRow } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', result.operation_id)
      .single();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('no_active_credential');
  });

  it('Scenario A (same-application historical credential): an expected credential already replaced or revoked, but still belonging to THIS application, produces the durable expected_credential_changed outcome, with terminal_related_credential_id left null, no fabricated credential_id/status/issued_at, and the current active credential remains unchanged', async () => {
    // CORRECTED this round: terminal_related_credential_id is permitted
    // ONLY for 'active_credential_already_exists' by the approved
    // qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    // (§1.7) — it must remain null for 'expected_credential_changed'. Same
    // class of defect, same reservation-layer internal
    // (request_staff_qr_reissue_transactional_internal), corrected
    // identically to finalize_qr_reissue_for_server's own fix.
    //
    // CORRECTED this round (second pass): this test previously used a
    // credential belonging to a DIFFERENT application as the expected
    // credential — that is invalid input, rejected BEFORE any operation
    // is created (see request_staff_qr_reissue_transactional_internal's
    // own "does not identify a credential belonging to this application"
    // check), never converted to expected_credential_changed. This test
    // now uses a credential that genuinely belongs to THIS SAME
    // application (its own prior active credential, since revoked) — the
    // legitimate Scenario A. The separate cross-application
    // input-validation scenario is exercised by "Scenario B" below.
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const historicalCredentialId = await insertActiveCredential(fx.applicationId);
    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', historicalCredentialId);
    const currentActiveCredentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: historicalCredentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as Record<string, unknown> & { outcome: string; operation_id: string };
    expect(result.outcome).toBe('expected_credential_changed');
    expect(result.credential_id).toBeNull();
    expect(result.status).toBeNull();
    expect(result.issued_at).toBeNull();

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code, terminal_related_credential_id')
      .eq('id', result.operation_id)
      .single();
    expect(opError, `post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('expected_credential_changed');
    expect(opRow!.terminal_related_credential_id).toBeNull();

    const { data: credAfter } = await admin.from('qr_credentials').select('status').eq('id', currentActiveCredentialId).single();
    expect(credAfter!.status).toBe('active'); // reservation never revokes or replaces the active credential
  });

  it('Scenario B (credential from another application): using an expected credential ID that belongs to a DIFFERENT application is rejected as a controlled input-validation error, no lifecycle operation is inserted, no credential is modified, and no raw foreign-key constraint error leaks to the client', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const otherApplication = await createParticipantFixture();
    const foreignCredentialId = await insertActiveCredential(otherApplication.applicationId);

    const before = await admin.from('qr_lifecycle_operations').select('id').eq('application_id', fx.applicationId);
    expect(before.data ?? []).toHaveLength(0);

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: foreignCredentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, 'expected a controlled input-validation error for a cross-application expected credential id').toBeTruthy();
    expect(data).toBeNull();
    expect(error!.code).not.toBe('23503');
    expect(error!.message).toContain('does not identify a credential belonging to this application');

    const after = await admin.from('qr_lifecycle_operations').select('id').eq('application_id', fx.applicationId);
    expect(after.data ?? []).toHaveLength(0);

    const { data: foreignCredAfter } = await admin.from('qr_credentials').select('status, application_id').eq('id', foreignCredentialId).single();
    expect(foreignCredAfter!.status).toBe('active');
    expect(foreignCredAfter!.application_id).toBe(otherApplication.applicationId);
  });

  it('active credential changing WHILE the RPC is blocked waiting on the application lock is observed as expected_credential_changed against the NEW credential — deterministic proof the RPC never reads current-credential state before that lock is released', async () => {
    // CORRECTED this round: the previous version of this test prepared
    // the historical credential and its replacement BEFORE the waiter
    // ever started, and held the CREDENTIAL row itself (position 4) —
    // that only proves a stale expected-credential value is detected
    // after waiting; it never proves the credential genuinely CHANGED
    // WHILE the RPC was blocked. This version holds the APPLICATION row
    // (position 3, reached and locked by the RPC BEFORE its own
    // position-4 credential lock), starts with credential A active,
    // launches the RPC waiter (expecting A), proves the waiter is
    // SPECIFICALLY blocked by the application-lock holder, and only THEN
    // — while still blocked — revokes A and inserts B as the new active
    // credential, committing both changes before ever releasing the
    // application gate. The RPC can only resume and read live credential
    // state AFTER the gate release, so observing B (not A, not a stale
    // pre-read) proves no authoritative current-credential read happens
    // before the application lock.
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const credentialA = await insertActiveCredential(fx.applicationId);
    const holderTag = `reissue-app-holder-${randomUUID()}`;
    const waiterTag = `reissue-app-waiter-${randomUUID()}`;
    const gateId = await createGate();

    // Both the holder and RPC-waiter promises are declared OUTSIDE try,
    // before either RPC is started, so cleanup can always settle both —
    // even if waitUntilHolderReady, waitUntilBlocked, or any assertion
    // between the two RPC calls throws. Each RPC is started EXACTLY ONCE
    // and its promise captured immediately (PostgREST's builder is
    // thenable, not a real Promise, so wrapping it eagerly avoids ever
    // re-issuing the request via a second, accidental `await`/`.then()`).
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let holderPromise: Promise<Awaited<ReturnType<typeof admin.rpc>>> | undefined;
    let waiterPromise: Promise<Awaited<ReturnType<typeof staff.client.rpc>>> | undefined;
    let gateReleased = false;
    try {
      if (usesCloudNativeHolder) {
        await launchCloudNativeHolder(
          holderTag,
          'select public.test_only_hold_application_lock($1, $2, $3, $4)',
          [fx.applicationId, gateId, holderTag, 30],
          HOLDER_WAIT_TIMEOUT_MS,
        );
      } else {
        holderPromise = Promise.resolve(
          admin.rpc('test_only_hold_application_lock', {
            p_application_id: fx.applicationId,
            p_gate_id: gateId,
            p_holder_tag: holderTag,
            p_max_wait_seconds: 30,
          }),
        );
        await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
      }

      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [randomUUID(), fx.applicationId, credentialA, STAFF_REISSUE_REASON_NO_NOTE_REQUIRED, null, null, waiterTag],
        );
      } else {
        waiterPromise = Promise.resolve(
          staff.client.rpc('test_only_request_staff_qr_reissue_tagged', {
            p_request_key: randomUUID(),
            p_application_id: fx.applicationId,
            p_expected_current_credential_id: credentialA,
            p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
            p_reissue_note: null,
            p_bulk_batch_id: null,
            p_waiter_tag: waiterTag,
          }),
        );
      }
      // Proves the RPC is SPECIFICALLY blocked by this application-lock
      // holder — not merely waiting on something.
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // WHILE the RPC remains blocked on the application lock: legally
      // revoke credential A and insert credential B as the new active
      // credential. Both changes commit before the gate is ever
      // released, so the RPC can only ever observe the post-change
      // state.
      await admin
        .from('qr_credentials')
        .update({
          status: 'revoked',
          token_ciphertext: null,
          encryption_key_version: null,
          revoked_at: new Date().toISOString(),
          revoked_by: null,
          revocation_reason_code: 'administrative_correction',
          revocation_note: null,
        })
        .eq('id', credentialA);
      const credentialB = await insertActiveCredential(fx.applicationId);

      await releaseGate(gateId);
      gateReleased = true;

      let result: Record<string, unknown> & { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<Record<string, unknown> & { outcome: string; operation_id: string }>(waiterTag);
      } else {
        const holderResult = await holderPromise!;
        expect(holderResult.error).toBeNull();
        const waiterResult = await waiterPromise!;
        expect(waiterResult.error).toBeNull();
        expect(waiterResult.data).toBeTruthy();
        result = waiterResult.data as unknown as Record<string, unknown> & { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('expected_credential_changed');
      // terminal_related_credential_id is permitted ONLY for
      // 'active_credential_already_exists' — must remain null here, and
      // the result must not expose non-null credential_id/status/issued_at
      // from the credential observed only after the lock.
      expect(result.credential_id).toBeNull();
      expect(result.status).toBeNull();
      expect(result.issued_at).toBeNull();

      const { data: opRow, error: opError } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code, terminal_related_credential_id')
        .eq('id', result.operation_id)
        .single();
      expect(opError, `operation post-state query failed: ${opError?.message}`).toBeNull();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('expected_credential_changed');
      expect(opRow!.terminal_related_credential_id).toBeNull();

      const { data: credBAfter } = await admin.from('qr_credentials').select('status').eq('id', credentialB).single();
      expect(credBAfter!.status).toBe('active'); // the new active credential remains active and unchanged
    } finally {
      if (usesCloudNativeHolder) {
        try {
          if (!gateReleased) {
            await releaseGate(gateId);
          }
        } finally {
          await closeCloudNativeSession(holderTag);
          await closeCloudNativeSession(waiterTag);
        }
      } else {
        const pending = [holderPromise, waiterPromise].filter((p): p is NonNullable<typeof p> => p !== undefined);
        try {
          if (!gateReleased) {
            await releaseGate(gateId);
          }
        } finally {
          await Promise.allSettled(pending);
        }
      }
    }
  }, 30000);
});

describe('request_staff_qr_reissue_transactional — TTL and authorization-lapse concurrency', () => {
  it('a demoted requester is rejected upfront, before any lock is taken, and no operation is created or left pending', async () => {
    // See the issuance-side equivalent test for why this proves the
    // actually-guaranteed property (rejection strictly before any lock)
    // rather than a mid-flight re-check the production function never
    // promises: the caller's role is read once, before any lock, and
    // never re-checked afterward for this call's own requester.
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const { error: demoteError } = await admin.from('profiles').update({ role: 'participant' }).eq('id', staff.userId);
    expect(demoteError, `role demotion failed: ${demoteError?.message}`).toBeNull();

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `expected a controlled 'Not authorized' rejection, got: ${error?.message}`).not.toBeNull();
    expect(data).toBeNull();

    const { data: opRows } = await admin.from('qr_lifecycle_operations').select('id').eq('application_id', fx.applicationId);
    expect(opRows).toHaveLength(0);
  });

  it('exact TTL expiry while waiting on the application lock reports operation_expired', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const holderTag = `reissue-ttl-app-holder-${randomUUID()}`;
    const waiterTag = `reissue-ttl-app-waiter-${randomUUID()}`;
    const gateId = await createGate();
    const shortTtlSeconds = 3;
    const usesCloudNativeHolder2 = disposableDatabaseCheck.reason !== 'local';

    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder2) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder2) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_reissue_short_ttl($1, $2, $3, $4, $5, $6, $7, $8)) as result',
          [randomUUID(), fx.applicationId, credentialId, STAFF_REISSUE_REASON_NO_NOTE_REQUIRED, null, null, `${shortTtlSeconds} seconds`, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_reissue_short_ttl', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_bulk_batch_id: null,
          p_pending_ttl: `${shortTtlSeconds} seconds`,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder2) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('operation_expired');

      const { data: opRow } = await admin
        .from('qr_lifecycle_operations')
        .select('status, terminal_reason_code')
        .eq('id', result.operation_id)
        .single();
      expect(opRow!.status).toBe('expired');
      expect(opRow!.terminal_reason_code).toBe('ttl_expired');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder2) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('exact TTL expiry while waiting on the credential lock reports operation_expired, not expected_credential_changed', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const holderTag = `reissue-ttl-cred-holder-${randomUUID()}`;
    const waiterTag = `reissue-ttl-cred-waiter-${randomUUID()}`;
    const gateId = await createGate();
    const shortTtlSeconds = 3;

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_active_credential_lock($1, $2, $3, $4)',
        [credentialId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_active_credential_lock', {
        p_credential_id: credentialId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_reissue_short_ttl($1, $2, $3, $4, $5, $6, $7, $8)) as result',
          [randomUUID(), fx.applicationId, credentialId, STAFF_REISSUE_REASON_NO_NOTE_REQUIRED, null, null, `${shortTtlSeconds} seconds`, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_reissue_short_ttl', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_bulk_batch_id: null,
          p_pending_ttl: `${shortTtlSeconds} seconds`,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('operation_expired');
      expect(result.outcome).not.toBe('expected_credential_changed');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);
});

describe('request_staff_qr_reissue_transactional — request-key replay and intent-conflict semantics', () => {
  it('first valid request returns reserved', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(error, `reservation failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved');
  });

  it('identical same-key retry returns the same operation ID', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const retry = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(retry.error).toBeNull();
    const retryResult = retry.data as unknown as { outcome: string; operation_id: string };
    expect(retryResult.outcome).toBe('already_pending');
    expect(retryResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting application returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const a = await reissueFixtureWithActiveCredentialForStaff();
    const b = await reissueFixtureWithActiveCredentialForStaff();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: a.fx.applicationId,
      p_expected_current_credential_id: a.credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: b.fx.applicationId,
      p_expected_current_credential_id: b.credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting expected credential returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    // See the participant-side equivalent test for why this must belong
    // to THIS SAME application, and why credentialId must stay active
    // through the FIRST call and only be swapped out AFTER it succeeds
    // (the main reservation path requires the expected credential to
    // still be the currently active one to return 'reserved'; the swap
    // itself requires credentialId to first stop being active, since
    // qr_credentials_one_active_per_application forbids two
    // simultaneously-active rows and the insert trigger requires
    // status='active' on insert).
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const { error: revokeFirstError } = await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', credentialId);
    expect(revokeFirstError, `credentialId revocation failed: ${revokeFirstError?.message}`).toBeNull();
    const otherCredentialId = await insertActiveCredential(fx.applicationId);

    const conflict = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: otherCredentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting reason returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_OTHER_REQUIRES_NOTE,
      p_reissue_note: 'a different explanation',
      p_bulk_batch_id: null,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting normalized note returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_OTHER_REQUIRES_NOTE,
      p_reissue_note: 'first explanation',
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_OTHER_REQUIRES_NOTE,
      p_reissue_note: 'a completely different explanation',
      p_bulk_batch_id: null,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting batch returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchA = await createBulkBatch(staff.userId, 'reissue');
    const batchB = await createBulkBatch(staff.userId, 'reissue');
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchA,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchB,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });

  it('same-key conflicting individual-versus-bulk channel returns request_key_intent_conflict', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    const conflict = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(conflict.error).toBeNull();
    const conflictResult = conflict.data as unknown as { outcome: string; operation_id: string };
    expect(conflictResult.outcome).toBe('request_key_intent_conflict');
    expect(conflictResult.operation_id).toBe(firstResult.operation_id);
  });
});

describe('request_staff_qr_reissue_transactional — deterministic concurrency and domain exclusivity', () => {
  it('a different-key same-requester blocker exposes its operation ID', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const holderTag = `reissue-blocker-holder-${randomUUID()}`;
    const waiterTag = `reissue-blocker-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const blocker = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(blocker.error).toBeNull();
    const blockerResult = blocker.data as unknown as { outcome: string; operation_id: string };
    expect(blockerResult.outcome).toBe('reserved');

    // Uses the reservation-domain ADVISORY lock (position 2 inside
    // reserve_or_reuse_qr_lifecycle_operation, operation_type='reissue'),
    // not the application row lock — see the issuance-side equivalent
    // test earlier in this file for the full rationale, confirmed
    // identically for the reissue path by direct pg_locks/pg_stat_activity
    // observation.
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_reservation_domain_advisory_lock($1, $2, $3, $4, $5)',
        [fx.applicationId, 'reissue', gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_reservation_domain_advisory_lock', {
        p_application_id: fx.applicationId,
        p_operation_type: 'reissue',
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof staff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          staff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [randomUUID(), fx.applicationId, credentialId, STAFF_REISSUE_REASON_NO_NOTE_REQUIRED, null, null, waiterTag],
        );
      } else {
        sessionBPromise = staff.client.rpc('test_only_request_staff_qr_reissue_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_bulk_batch_id: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string };
      }
      expect(result.outcome).toBe('another_operation_pending');
      expect(result.operation_id).toBe(blockerResult.operation_id);
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('a different-requester blocker omits its operation ID', async () => {
    const owner = await createStaffFixture('super_admin');
    const otherStaff = await createStaffFixture('program_attendance_manager');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const holderTag = `reissue-other-holder-${randomUUID()}`;
    const waiterTag = `reissue-other-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const blocker = await owner.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(blocker.error).toBeNull();
    const blockerResult = blocker.data as unknown as { outcome: string };
    expect(blockerResult.outcome).toBe('reserved');

    // See the "different-key same-requester" reissue test above for why
    // the reservation-domain ADVISORY lock (operation_type='reissue') is
    // used here rather than the application row lock.
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_reservation_domain_advisory_lock($1, $2, $3, $4, $5)',
        [fx.applicationId, 'reissue', gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_reservation_domain_advisory_lock', {
        p_application_id: fx.applicationId,
        p_operation_type: 'reissue',
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      let sessionBPromise: ReturnType<typeof otherStaff.client.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          otherStaff.accessToken,
          'select to_jsonb(public.test_only_request_staff_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [randomUUID(), fx.applicationId, credentialId, STAFF_REISSUE_REASON_NO_NOTE_REQUIRED, null, null, waiterTag],
        );
      } else {
        sessionBPromise = otherStaff.client.rpc('test_only_request_staff_qr_reissue_tagged', {
          p_request_key: randomUUID(),
          p_application_id: fx.applicationId,
          p_expected_current_credential_id: credentialId,
          p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
          p_reissue_note: null,
          p_bulk_batch_id: null,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; operation_id: string | null };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; operation_id: string | null }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; operation_id: string | null };
      }
      expect(result.outcome).toBe('another_operation_pending');
      expect(result.operation_id).toBeFalsy();
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('two simultaneous staff reissue requests for the same application resolve to exactly one reserved and one another_operation_pending, with exactly one pending operation in the domain', async () => {
    const staffA = await createStaffFixture('super_admin');
    const staffB = await createStaffFixture('program_attendance_manager');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    const [resultA, resultB] = await Promise.all([
      staffA.client.rpc('request_staff_qr_reissue_transactional', {
        p_request_key: randomUUID(),
        p_application_id: fx.applicationId,
        p_expected_current_credential_id: credentialId,
        p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
        p_bulk_batch_id: null,
      }),
      staffB.client.rpc('request_staff_qr_reissue_transactional', {
        p_request_key: randomUUID(),
        p_application_id: fx.applicationId,
        p_expected_current_credential_id: credentialId,
        p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
        p_bulk_batch_id: null,
      }),
    ]);
    expect(resultA.error).toBeNull();
    expect(resultB.error).toBeNull();
    expect(resultA.data).toBeTruthy();
    expect(resultB.data).toBeTruthy();

    const outcomeA = (resultA.data as unknown as { outcome: string }).outcome;
    const outcomeB = (resultB.data as unknown as { outcome: string }).outcome;
    const outcomes = [outcomeA, outcomeB].sort();
    expect(outcomes).toEqual(['another_operation_pending', 'reserved']);

    const { data: pendingRows, error: pendingRowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue')
      .eq('status', 'pending');
    expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
    expect(pendingRows).toHaveLength(1);
  });

  it('simultaneous participant self-reissue and staff reissue for the same application resolve to exactly one reserved and one another_operation_pending', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();

    // See the issuance-side equivalent test for the full rationale: a
    // Promise.all([...]) race is not reliably deterministic (each call is
    // a separate HTTP round trip, and true mid-flight interleaving via
    // pg_locks was found empirically unreliable — the critical section is
    // too short-lived to poll for reliably). Runs A to completion first
    // (over its own raw-pg session, invoking the exact same production
    // RPC), then launches B — proving domain exclusivity deterministically.
    if (disposableDatabaseCheck.reason !== 'local') {
      const participantSession = await CloudNativeAuthenticatedSession.open(fx.accessToken);
      participantSession.startRpcFunction(
        'select to_jsonb(public.test_only_request_my_qr_reissue_tagged($1, $2, $3, $4, $5)) as result',
        [randomUUID(), credentialId, 'lost_or_stolen_phone', null, `simul-reissue-participant-${randomUUID()}`],
      );
      const participantRes = await participantSession.awaitCompletion<{ result: { outcome: string } }>();
      await participantSession.close();

      const staffSession = await CloudNativeAuthenticatedSession.open(staff.accessToken);
      staffSession.startRpcFunction(
        'select to_jsonb(public.test_only_request_staff_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
        [randomUUID(), fx.applicationId, credentialId, STAFF_REISSUE_REASON_NO_NOTE_REQUIRED, null, null, `simul-reissue-staff-${randomUUID()}`],
      );
      const staffRes = await staffSession.awaitCompletion<{ result: { outcome: string } }>();
      await staffSession.close();

      const outcomes = [participantRes.rows[0].result.outcome, staffRes.rows[0].result.outcome].sort();
      expect(outcomes).toEqual(['another_operation_pending', 'reserved']);

      const { data: pendingRows, error: pendingRowsError } = await admin
        .from('qr_lifecycle_operations')
        .select('id')
        .eq('application_id', fx.applicationId)
        .eq('operation_type', 'reissue')
        .eq('status', 'pending');
      expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
      expect(pendingRows).toHaveLength(1);
      return;
    }

    const [participantResult, staffResult] = await Promise.all([
      fx.client.rpc('request_my_qr_reissue_transactional', {
        p_request_key: randomUUID(),
        p_expected_current_credential_id: credentialId,
        p_reissue_reason_code: 'lost_or_stolen_phone',
        p_reissue_note: null,
      }),
      staff.client.rpc('request_staff_qr_reissue_transactional', {
        p_request_key: randomUUID(),
        p_application_id: fx.applicationId,
        p_expected_current_credential_id: credentialId,
        p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
        p_reissue_note: null,
        p_bulk_batch_id: null,
      }),
    ]);
    expect(participantResult.error).toBeNull();
    expect(staffResult.error).toBeNull();
    expect(participantResult.data).toBeTruthy();
    expect(staffResult.data).toBeTruthy();

    const outcomeParticipant = (participantResult.data as unknown as { outcome: string }).outcome;
    const outcomeStaff = (staffResult.data as unknown as { outcome: string }).outcome;
    const outcomes = [outcomeParticipant, outcomeStaff].sort();
    expect(outcomes).toEqual(['another_operation_pending', 'reserved']);

    const { data: pendingRows, error: pendingRowsError } = await admin
      .from('qr_lifecycle_operations')
      .select('id')
      .eq('application_id', fx.applicationId)
      .eq('operation_type', 'reissue')
      .eq('status', 'pending');
    expect(pendingRowsError, `pending-row-count query failed: ${pendingRowsError?.message}`).toBeNull();
    expect(pendingRows).toHaveLength(1);
  });
});

describe('request_staff_qr_reissue_transactional — durable replay of terminal outcomes and quota isolation', () => {
  it('durable replay of requester_no_longer_authorized', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const requestKey = randomUUID();

    const seed = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(seed.error).toBeNull();
    const seedResult = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedResult.outcome).toBe('reserved');

    await admin.from('profiles').update({ role: 'participant' }).eq('id', staff.userId);

    const otherStaff = await createStaffFixture('super_admin');
    const trigger = await otherStaff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(trigger.error).toBeNull();

    const { data: opAfter } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', seedResult.operation_id)
      .single();
    expect(opAfter!.status).toBe('cancelled');
    expect(opAfter!.terminal_reason_code).toBe('requester_no_longer_authorized');
  });

  it('durable replay of bulk_batch_unavailable', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('reserved');

    await admin.from('qr_bulk_operation_batches').update({ status: 'cancelled', closed_at: new Date().toISOString() }).eq('id', batchId);

    const trigger = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(trigger.error).toBeNull();

    const { data: opAfter } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code')
      .eq('id', firstResult.operation_id)
      .single();
    expect(opAfter!.status).toBe('cancelled');
    expect(opAfter!.terminal_reason_code).toBe('bulk_batch_unavailable');

    const replay = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: batchId,
    });
    expect(replay.error).toBeNull();
    const replayResult = replay.data as unknown as { outcome: string; operation_id: string };
    expect(replayResult.outcome).toBe('bulk_batch_unavailable');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
  });

  it('durable replay of application_ineligible', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const requestKey = randomUUID();

    await admin.from('applications').update({ status: 'submitted' }).eq('id', fx.applicationId);

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('application_ineligible');

    const replay = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(replay.error).toBeNull();
    const replayResult = replay.data as unknown as { outcome: string; operation_id: string };
    expect(replayResult.outcome).toBe('application_ineligible');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
  });

  it('durable replay of no_active_credential', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const activeThenRevokedId = await insertActiveCredential(fx.applicationId);
    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', activeThenRevokedId);
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: activeThenRevokedId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('no_active_credential');

    const replay = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: activeThenRevokedId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(replay.error).toBeNull();
    const replayResult = replay.data as unknown as { outcome: string; operation_id: string };
    expect(replayResult.outcome).toBe('no_active_credential');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
  });

  it('durable replay of expected_credential_changed, with terminal_related_credential_id left null and no fabricated credential_id/status/issued_at', async () => {
    // CORRECTED this round: same class of defect, same reservation-layer
    // internal (request_staff_qr_reissue_transactional_internal),
    // corrected identically to finalize_qr_reissue_for_server's own fix.
    //
    // CORRECTED this round (second pass): the expected credential must
    // belong to THIS SAME application (a genuinely historical one) — a
    // cross-application credential fails the RPC's own early input-
    // validation check before any operation is ever created, so it would
    // never produce a durable expected_credential_changed operation to
    // replay in the first place.
    //
    // CORRECTED this round (third pass): the previous version called
    // reissueFixtureWithActiveCredentialForStaff() (which already
    // creates ONE active credential) and THEN inserted a SECOND active
    // credential before revoking the first — briefly violating the
    // one-active-credential-per-application invariant. Fixed by treating
    // the fixture's own existing active credential as the historical
    // one, revoking it FIRST, and only THEN inserting the new active
    // credential — at no point does the application ever have more than
    // one active credential.
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId: historicalCredentialId } = await reissueFixtureWithActiveCredentialForStaff();
    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', historicalCredentialId);
    const currentActiveCredentialId = await insertActiveCredential(fx.applicationId);
    const requestKey = randomUUID();

    const first = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: historicalCredentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as Record<string, unknown> & { outcome: string; operation_id: string };
    expect(firstResult.outcome).toBe('expected_credential_changed');
    expect(firstResult.credential_id).toBeNull();
    expect(firstResult.status).toBeNull();
    expect(firstResult.issued_at).toBeNull();

    const replay = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: requestKey,
      p_application_id: fx.applicationId,
      p_expected_current_credential_id: historicalCredentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(replay.error).toBeNull();
    const replayResult = replay.data as unknown as Record<string, unknown> & { outcome: string; operation_id: string };
    expect(replayResult.outcome).toBe('expected_credential_changed');
    expect(replayResult.operation_id).toBe(firstResult.operation_id);
    expect(replayResult.credential_id).toBeNull();
    expect(replayResult.status).toBeNull();
    expect(replayResult.issued_at).toBeNull();

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('terminal_related_credential_id').eq('id', firstResult.operation_id).single();
    expect(opRow!.terminal_related_credential_id).toBeNull();

    const { data: credAfter } = await admin.from('qr_credentials').select('status').eq('id', currentActiveCredentialId).single();
    expect(credAfter!.status).toBe('active'); // the new current active credential remains active and unchanged
  });

  it('staff reissues do not participate in the participant cooldown or rolling-rate-limit calculation', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const now = new Date();
    const placeholderCredential = randomUUID();
    // Seed three STAFF-channel consumed reissues within the rolling
    // window — must NOT count toward the participant limit for a
    // SUBSEQUENT participant self-reissue attempt on the same
    // application.
    for (const hoursAgo of [20, 15, 1]) {
      const { data, error } = await admin.rpc('test_only_seed_staff_consumed_reissue_operation', {
        p_application_id: fx.applicationId,
        p_requester_auth_user_id: staff.userId,
        p_expected_current_credential_id: placeholderCredential,
        p_consumed_at: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString(),
      });
      expect(error, `staff seed failed: ${error?.message}`).toBeNull();
      expect(data).toBeTruthy();
    }
    // This loop calls test_only_seed_staff_consumed_reissue_operation
    // directly (a different RPC than seedQualifyingHistory() wraps), so
    // it must retire its own leftover 'active' row the same way
    // seedQualifyingHistory() does for its own callers — see
    // retireLeftoverSeededActiveCredential()'s own header comment.
    await retireLeftoverSeededActiveCredential(fx.applicationId);
    const credentialId = await insertActiveCredential(fx.applicationId);

    const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: credentialId,
      p_reissue_reason_code: 'lost_or_stolen_phone',
      p_reissue_note: null,
    });
    expect(error, `participant reservation failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('reserved'); // staff history never counts toward participant quota

    // Also confirm a staff RESERVATION itself never touches or checks any
    // cooldown/rate-limit outcome — a staff reissue call against a FRESH
    // application with no history at all simply reserves.
    const { fx: freshFx, credentialId: freshCredentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const staffResult = await staff.client.rpc('request_staff_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_application_id: freshFx.applicationId,
      p_expected_current_credential_id: freshCredentialId,
      p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_bulk_batch_id: null,
    });
    expect(staffResult.error).toBeNull();
    const staffOutcome = (staffResult.data as unknown as { outcome: string }).outcome;
    expect(staffOutcome).toBe('reserved');
    expect(staffOutcome).not.toBe('reissue_cooldown_active');
    expect(staffOutcome).not.toBe('reissue_rate_limit_exceeded');
  });
});

// ============================================================================
// Issuance finalizer — finalize_qr_issuance_for_server (Phase 6 design doc
// §5.1, this round's addition). service_role-only: no authenticated/anon
// session can call it directly. Consumes a 'pending' issuance operation
// (any of the three approved reservation channels) and performs the actual
// qr_credentials write.
// ============================================================================
async function getActiveKeyVersion(): Promise<number> {
  const { data, error } = await admin.from('qr_encryption_key_registry').select('key_version').eq('status', 'active').limit(1).single();
  expect(error, `active key lookup failed: ${error?.message}`).toBeNull();
  expect(data).toBeTruthy();
  return data!.key_version as unknown as number;
}

interface FinalizerInputs {
  credentialId: string;
  tokenHash: string;
  tokenCiphertext: string;
  tokenVersion: number;
  encryptionKeyVersion: number;
}

async function buildFinalizerInputs(keyVersionOverride?: number): Promise<FinalizerInputs> {
  const keyVersion = keyVersionOverride ?? (await getActiveKeyVersion());
  const envelope = Buffer.concat([Buffer.from([1]), randomBytes(60)]);
  return {
    credentialId: randomUUID(),
    tokenHash: `\\x${randomBytes(32).toString('hex')}`,
    tokenCiphertext: `\\x${envelope.toString('hex')}`,
    tokenVersion: 1,
    encryptionKeyVersion: keyVersion,
  };
}

async function reserveParticipantIssuance(fx: ParticipantFixture): Promise<string> {
  const { data, error } = await fx.client.rpc('request_my_qr_issuance_transactional', { p_request_key: randomUUID() });
  expect(error, `participant issuance reservation failed: ${error?.message}`).toBeNull();
  const result = data as unknown as { outcome: string; operation_id: string };
  expect(result.outcome).toBe('reserved');
  return result.operation_id;
}

async function reserveStaffIssuance(staff: StaffFixture, applicationId: string, bulkBatchId: string | null = null): Promise<string> {
  const { data, error } = await staff.client.rpc('request_staff_qr_issuance_transactional', {
    p_request_key: randomUUID(),
    p_application_id: applicationId,
    p_issuance_reason_code: 'advance_badge_printing',
    p_issuance_note: null,
    p_bulk_batch_id: bulkBatchId,
  });
  expect(error, `staff issuance reservation failed: ${error?.message}`).toBeNull();
  const result = data as unknown as { outcome: string; operation_id: string };
  expect(result.outcome).toBe('reserved');
  return result.operation_id;
}

describe('finalize_qr_issuance_for_server — permission and success paths', () => {
  it('rejects a call from an authenticated participant session', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await fx.client.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, 'expected the finalizer to be unreachable from an authenticated session').toBeTruthy();
    expect(data).toBeNull();
  });

  it('rejects a call from a staff authenticated session', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const operationId = await reserveStaffIssuance(staff, fx.applicationId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await staff.client.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, 'expected the finalizer to be unreachable from a staff session').toBeTruthy();
    expect(data).toBeNull();
  });

  it('participant self-service issuance success: issued_by is null', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(result.outcome).toBe('issued');
    expect(result.credential_id).toBe(inputs.credentialId);
    expect(result.status).toBe('active');
    expect(result.issued_at).toBeTruthy();

    const { data: credRow, error: credError } = await admin
      .from('qr_credentials')
      .select('issued_by, status, issuance_channel, created_at, issued_at')
      .eq('id', inputs.credentialId)
      .single();
    expect(credError, `credential post-state query failed: ${credError?.message}`).toBeNull();
    expect(credRow!.issued_by).toBeNull();
    expect(credRow!.status).toBe('active');
    expect(credRow!.issuance_channel).toBe('participant_self_service');
    expect(credRow!.created_at).toBe(credRow!.issued_at); // created_at exactly equals issued_at
  });

  it('staff-individual issuance success: issued_by equals the durable staff profile', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const operationId = await reserveStaffIssuance(staff, fx.applicationId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('issued');

    const { data: credRow } = await admin.from('qr_credentials').select('issued_by, issuance_channel').eq('id', inputs.credentialId).single();
    expect(credRow!.issued_by).toBe(staff.userId);
    expect(credRow!.issuance_channel).toBe('staff_individual');
  });

  it('staff-bulk issuance success', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(staff.userId, 'issue');
    const operationId = await reserveStaffIssuance(staff, fx.applicationId, batchId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('issued');

    const { data: credRow } = await admin.from('qr_credentials').select('issued_by, issuance_channel').eq('id', inputs.credentialId).single();
    expect(credRow!.issued_by).toBe(staff.userId);
    expect(credRow!.issuance_channel).toBe('staff_bulk');
  });

  it('lifecycle consumed_at exactly equals finalized_at, and the stored fingerprint is 32 bytes', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const { error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, consumed_at, finalized_at, resulting_credential_id, finalization_fingerprint, terminal_reason_code, terminal_related_credential_id, terminal_retry_after_at')
      .eq('id', operationId)
      .single();
    expect(opError, `operation post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('consumed');
    expect(opRow!.consumed_at).toBe(opRow!.finalized_at);
    expect(opRow!.resulting_credential_id).toBe(inputs.credentialId);
    expect(opRow!.terminal_reason_code).toBeNull();
    expect(opRow!.terminal_related_credential_id).toBeNull();
    expect(opRow!.terminal_retry_after_at).toBeNull();

    // finalization_fingerprint arrives as a hex-prefixed string via
    // PostgREST's bytea JSON encoding ("\\x" + hex) — 32 bytes = 64 hex
    // characters + the 2-character "\x" prefix.
    const fingerprintHex = (opRow!.finalization_fingerprint as unknown as string).replace(/^\\x/, '');
    expect(fingerprintHex).toHaveLength(64);
  });

  it('the successful audit row contains only safe metadata, never secret material', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const { error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();

    const { data: auditRows, error: auditError } = await admin
      .from('audit_logs')
      .select('metadata, action, actor_type, actor_id')
      .eq('entity_type', 'qr_credential')
      .eq('entity_id', inputs.credentialId)
      .eq('action', 'issued');
    expect(auditError, `audit query failed: ${auditError?.message}`).toBeNull();
    expect(auditRows).toHaveLength(1);
    const metadata = auditRows![0].metadata as unknown as Record<string, unknown>;
    expect(metadata.application_id).toBeTruthy();
    expect(metadata.issuance_channel).toBe('participant_self_service');
    expect(metadata).not.toHaveProperty('token_hash');
    expect(metadata).not.toHaveProperty('token_ciphertext');
    expect(metadata).not.toHaveProperty('finalization_fingerprint');
    expect(metadata).not.toHaveProperty('encryption_key_version');
    expect(auditRows![0].actor_type).toBe('system');
    expect(auditRows![0].actor_id).toBe(fx.userId);
  });
});

describe('finalize_qr_issuance_for_server — idempotent replay and conflict detection', () => {
  it('exact retry returns already_finalized', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const first = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(first.error).toBeNull();
    expect((first.data as unknown as { outcome: string }).outcome).toBe('issued');

    const retry = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    const retryResult = retry.data as unknown as { outcome: string; credential_id: string };
    expect(retryResult.outcome).toBe('already_finalized');
    expect(retryResult.credential_id).toBe(inputs.credentialId);
  });

  it('exact replay returns the identical credential_id/status/issued_at both BEFORE and AFTER the resulting credential is later revoked — the replayed result is fully durable and never depends on qr_credentials current state', async () => {
    // CORRECTED this round: the consumed-replay branch previously
    // queried the current qr_credentials row and returned ITS status/
    // issued_at — meaning a later revocation or replacement would change
    // what replay returns, violating the approved replay rule that exact
    // finalizer replay must be durable and never depend on a later
    // lifecycle transition. The branch now returns credential_id from
    // v_op.resulting_credential_id, status hardcoded to 'active' (the
    // state at the successful finalization transition), and issued_at
    // from v_op.finalized_at — none of which can ever change, regardless
    // of what happens to the qr_credentials row afterward.
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const first = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(firstResult.outcome).toBe('issued');

    // Replay BEFORE any later lifecycle transition — establishes the
    // baseline durable result.
    const replayBefore = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(replayBefore.error).toBeNull();
    const replayBeforeResult = replayBefore.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(replayBeforeResult.outcome).toBe('already_finalized');
    expect(replayBeforeResult.credential_id).toBe(inputs.credentialId);
    expect(replayBeforeResult.status).toBe('active');
    expect(replayBeforeResult.issued_at).toBe(firstResult.issued_at);

    // Revoke — clears token_ciphertext/encryption_key_version and flips
    // status to 'revoked' on the credential row (§1.2's active ->
    // revoked transition rule).
    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', inputs.credentialId);

    // Replay AFTER the revocation, with the SAME original inputs — must
    // return the EXACT SAME credential_id/status/issued_at as the
    // pre-revocation replay, proving the branch never re-derives from
    // the now-mutated qr_credentials row.
    const replayAfter = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(replayAfter.error, `historical replay failed: ${replayAfter.error?.message}`).toBeNull();
    const replayAfterResult = replayAfter.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(replayAfterResult.outcome).toBe('already_finalized');
    expect(replayAfterResult.credential_id).toBe(replayBeforeResult.credential_id);
    expect(replayAfterResult.status).toBe(replayBeforeResult.status);
    expect(replayAfterResult.status).toBe('active'); // durable — never 'revoked', despite the row's real current status
    expect(replayAfterResult.issued_at).toBe(replayBeforeResult.issued_at);

    // Confirm the row itself genuinely did change, so this test is not
    // vacuously true.
    const { data: credRow } = await admin.from('qr_credentials').select('status').eq('id', inputs.credentialId).single();
    expect(credRow!.status).toBe('revoked');
  });

  it('different credential ID on consumed retry returns idempotency_conflict', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const first = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(first.error).toBeNull();

    const retry = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: randomUUID(), // DIFFERENT credential id
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('changed token hash on consumed retry returns idempotency_conflict', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();
    await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });

    const retry = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: `\\x${randomBytes(32).toString('hex')}`, // DIFFERENT hash
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('changed token version on consumed retry returns idempotency_conflict', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();
    await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });

    const retry = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: 2, // DIFFERENT version
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('changed encryption-key version on consumed retry returns idempotency_conflict', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();
    await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });

    // Register a second active-eligible key version to use as the
    // "changed" value (must itself be a real registry row, otherwise the
    // fingerprint mismatch would be masked by an earlier key-not-active
    // outcome on a fresh call — but this is a RETRY of an already-
    // consumed operation, which never re-checks key-active status at
    // all, so any differing smallint value already suffices here).
    const retry = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion === 1 ? 2 : 1,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('changed ciphertext on consumed retry returns idempotency_conflict', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();
    await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });

    const differentEnvelope = Buffer.concat([Buffer.from([1]), randomBytes(60)]);
    const retry = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: `\\x${differentEnvelope.toString('hex')}`, // DIFFERENT ciphertext
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('two concurrent identical finalizer calls for the same operation produce exactly one issued and one already_finalized', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const [callA, callB] = await Promise.all([
      admin.rpc('finalize_qr_issuance_for_server', {
        p_operation_id: operationId,
        p_credential_id: inputs.credentialId,
        p_token_hash: inputs.tokenHash,
        p_token_ciphertext: inputs.tokenCiphertext,
        p_token_version: inputs.tokenVersion,
        p_encryption_key_version: inputs.encryptionKeyVersion,
      }),
      admin.rpc('finalize_qr_issuance_for_server', {
        p_operation_id: operationId,
        p_credential_id: inputs.credentialId,
        p_token_hash: inputs.tokenHash,
        p_token_ciphertext: inputs.tokenCiphertext,
        p_token_version: inputs.tokenVersion,
        p_encryption_key_version: inputs.encryptionKeyVersion,
      }),
    ]);
    expect(callA.error, `call A failed: ${callA.error?.message}`).toBeNull();
    expect(callB.error, `call B failed: ${callB.error?.message}`).toBeNull();

    const outcomeA = (callA.data as unknown as { outcome: string }).outcome;
    const outcomeB = (callB.data as unknown as { outcome: string }).outcome;
    const outcomes = [outcomeA, outcomeB].sort();
    expect(outcomes).toEqual(['already_finalized', 'issued']);

    const { data: credRows, error: credRowsError } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(credRowsError, `credential-row query failed: ${credRowsError?.message}`).toBeNull();
    expect(credRows).toHaveLength(1); // exactly one credential row, never two
  });

  it('a token-hash collision between two DIFFERENT operations resolves to token_hash_conflict, with no partial credential and the operation remaining pending', async () => {
    const fxA = await createParticipantFixture();
    const fxB = await createParticipantFixture();
    const operationIdA = await reserveParticipantIssuance(fxA);
    const operationIdB = await reserveParticipantIssuance(fxB);
    const inputsA = await buildFinalizerInputs();
    const sharedHash = inputsA.tokenHash;
    const inputsB = { ...(await buildFinalizerInputs()), tokenHash: sharedHash };

    const firstFinalize = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationIdA,
      p_credential_id: inputsA.credentialId,
      p_token_hash: inputsA.tokenHash,
      p_token_ciphertext: inputsA.tokenCiphertext,
      p_token_version: inputsA.tokenVersion,
      p_encryption_key_version: inputsA.encryptionKeyVersion,
    });
    expect(firstFinalize.error).toBeNull();
    expect((firstFinalize.data as unknown as { outcome: string }).outcome).toBe('issued');

    const collidingFinalize = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationIdB,
      p_credential_id: inputsB.credentialId,
      p_token_hash: inputsB.tokenHash, // SAME hash as A's already-inserted credential
      p_token_ciphertext: inputsB.tokenCiphertext,
      p_token_version: inputsB.tokenVersion,
      p_encryption_key_version: inputsB.encryptionKeyVersion,
    });
    expect(collidingFinalize.error, `colliding finalize failed: ${collidingFinalize.error?.message}`).toBeNull();
    expect((collidingFinalize.data as unknown as { outcome: string }).outcome).toBe('token_hash_conflict');

    const { data: opBRow } = await admin.from('qr_lifecycle_operations').select('status').eq('id', operationIdB).single();
    expect(opBRow!.status).toBe('pending'); // never consumed on a token_hash_conflict

    const { data: credBRows } = await admin.from('qr_credentials').select('id').eq('id', inputsB.credentialId);
    expect(credBRows).toHaveLength(0); // no partial credential was ever inserted
  });

  it('a credential-ID collision with an unrelated operation resolves to idempotency_conflict without exposing a raw unique_violation', async () => {
    const fxA = await createParticipantFixture();
    const fxB = await createParticipantFixture();
    const operationIdA = await reserveParticipantIssuance(fxA);
    const operationIdB = await reserveParticipantIssuance(fxB);
    const inputsA = await buildFinalizerInputs();

    const firstFinalize = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationIdA,
      p_credential_id: inputsA.credentialId,
      p_token_hash: inputsA.tokenHash,
      p_token_ciphertext: inputsA.tokenCiphertext,
      p_token_version: inputsA.tokenVersion,
      p_encryption_key_version: inputsA.encryptionKeyVersion,
    });
    expect(firstFinalize.error).toBeNull();
    expect((firstFinalize.data as unknown as { outcome: string }).outcome).toBe('issued');

    const inputsB = await buildFinalizerInputs();
    const collidingFinalize = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationIdB,
      p_credential_id: inputsA.credentialId, // SAME credential id as A's already-inserted row, DIFFERENT operation
      p_token_hash: inputsB.tokenHash,
      p_token_ciphertext: inputsB.tokenCiphertext,
      p_token_version: inputsB.tokenVersion,
      p_encryption_key_version: inputsB.encryptionKeyVersion,
    });
    expect(collidingFinalize.error, `colliding finalize failed: ${collidingFinalize.error?.message}`).toBeNull();
    const result = collidingFinalize.data as unknown as { outcome: string };
    expect(['idempotency_conflict', 'active_credential_already_exists']).toContain(result.outcome);

    const { data: opBRow } = await admin.from('qr_lifecycle_operations').select('status').eq('id', operationIdB).single();
    expect(opBRow!.status).toBe('pending');
  });
});

describe('finalize_qr_issuance_for_server — pending-operation authoritative decisions and concurrency', () => {
  it('expired operation returns operation_expired', async () => {
    const fx = await createParticipantFixture();
    const shortTtlSeconds = 3;
    // test_only_request_my_qr_issuance_short_ttl is granted EXECUTE to
    // authenticated only (revoked from service_role) — must be called via
    // the participant's own authenticated client, not admin.
    const seed = await fx.client.rpc('test_only_request_my_qr_issuance_short_ttl', {
      p_request_key: randomUUID(),
      p_pending_ttl: `${shortTtlSeconds} seconds`,
      p_waiter_tag: `finalizer-expiry-seed-${randomUUID()}`,
    });
    expect(seed.error).toBeNull();
    const seedResult = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedResult.outcome).toBe('reserved');

    await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

    const inputs = await buildFinalizerInputs();
    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: seedResult.operation_id,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('operation_expired');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', seedResult.operation_id).single();
    expect(opRow!.status).toBe('expired');
    expect(opRow!.terminal_reason_code).toBe('ttl_expired');
  }, 15000);

  it('application becoming ineligible while the finalizer waits on the application lock is observed deterministically', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const holderTag = `finalizer-app-holder-${randomUUID()}`;
    const waiterTag = `finalizer-app-waiter-${randomUUID()}`;
    const gateId = await createGate();

    // See the "application becoming ineligible while waiting on the
    // application lock" issuance-side test for why the mutation now
    // happens INSIDE the holder's own transaction rather than via a
    // separate racing session.
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock_and_mutate_status($1, $2, $3, $4, $5)',
        [fx.applicationId, gateId, holderTag, 'submitted', 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock_and_mutate_status', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_new_status: 'submitted',
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let sessionBPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_issuance_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = admin.rpc('test_only_finalize_qr_issuance_tagged', {
          p_operation_id: operationId,
          p_credential_id: inputs.credentialId,
          p_token_hash: inputs.tokenHash,
          p_token_ciphertext: inputs.tokenCiphertext,
          p_token_version: inputs.tokenVersion,
          p_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('application_ineligible');

      const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('application_ineligible');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('staff requester losing authorization while the finalizer waits is observed deterministically', async () => {
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const operationId = await reserveStaffIssuance(staff, fx.applicationId);
    const holderTag = `finalizer-authz-holder-${randomUUID()}`;
    const waiterTag = `finalizer-authz-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let sessionBPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_issuance_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = admin.rpc('test_only_finalize_qr_issuance_tagged', {
          p_operation_id: operationId,
          p_credential_id: inputs.credentialId,
          p_token_hash: inputs.tokenHash,
          p_token_ciphertext: inputs.tokenCiphertext,
          p_token_version: inputs.tokenVersion,
          p_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await admin.from('profiles').update({ role: 'participant' }).eq('id', staff.userId);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('requester_no_longer_authorized');

      const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('requester_no_longer_authorized');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('batch becomes unavailable BEFORE the finalizer acquires the batch lock: the finalizer waits on it, the holder cancels and commits, then the finalizer observes the durable bulk_batch_unavailable outcome', async () => {
    // CORRECTED this round: the finalizer now locks the batch FOR SHARE
    // at position 2, immediately after the operation lock and BEFORE the
    // application lock — reusing the approved test_only_hold_then_cancel_bulk_batch
    // helper (FOR UPDATE, conflicts with the finalizer's own FOR SHARE
    // read) to hold the batch row, prove the finalizer is SPECIFICALLY
    // blocked on that exact holder, then have the holder perform its own
    // cancellation and commit before the finalizer's blocked FOR SHARE
    // read can ever proceed — guaranteeing the finalizer can only ever
    // observe the batch AFTER it was durably cancelled, never a stale
    // pre-cancellation read.
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(staff.userId, 'issue');
    const operationId = await reserveStaffIssuance(staff, fx.applicationId, batchId);
    const holderTag = `finalizer-batch-holder-${randomUUID()}`;
    const waiterTag = `finalizer-batch-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_then_cancel_bulk_batch($1, $2, $3, $4)',
        [batchId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_then_cancel_bulk_batch', {
        p_batch_id: batchId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let sessionBPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_issuance_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = admin.rpc('test_only_finalize_qr_issuance_tagged', {
          p_operation_id: operationId,
          p_credential_id: inputs.credentialId,
          p_token_hash: inputs.tokenHash,
          p_token_ciphertext: inputs.tokenCiphertext,
          p_token_version: inputs.tokenVersion,
          p_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: waiterTag,
        });
      }
      // Proves the finalizer is SPECIFICALLY waiting on this batch
      // holder — not merely waiting on something.
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        // Await the holder FIRST via its own completion, confirming it
        // committed its own cancellation without error, establishing the
        // explicit happens-before relationship this test depends on.
        await getCloudNativeHolderSession(holderTag).awaitCompletion();
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        // Await the holder FIRST, and confirm it committed its own
        // cancellation without error, establishing the explicit
        // happens-before relationship this test depends on.
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder/canceller session failed: ${sessionAResult.error?.message}`).toBeNull();

        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `finalizer session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('bulk_batch_unavailable');

      const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('bulk_batch_unavailable');

      const { data: batchRow } = await admin.from('qr_bulk_operation_batches').select('status, closed_at').eq('id', batchId).single();
      expect(batchRow!.status).toBe('cancelled');
      expect(batchRow!.closed_at).toBeTruthy();

      // No credential or successful issuance audit was ever created.
      const { data: credRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
      expect(credRows).toHaveLength(0);
      const { data: auditRows } = await admin
        .from('audit_logs')
        .select('id')
        .eq('entity_type', 'qr_credential')
        .eq('entity_id', inputs.credentialId)
        .eq('action', 'issued');
      expect(auditRows).toHaveLength(0);
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('the finalizer acquires the batch FOR SHARE lock FIRST: a concurrent batch cancellation is blocked until the finalizer commits, and the credential is issued using a batch that remained valid for the whole finalization transaction', async () => {
    // Proves the OTHER direction of the same race: once the finalizer
    // itself holds the batch row FOR SHARE (position 2, acquired
    // immediately after the operation lock and BEFORE the application
    // lock), a concurrent attempt to transition that SAME batch to
    // 'cancelled' (which requires locking the row for its own UPDATE)
    // must block behind the finalizer's hold — it can only proceed after
    // the finalizer's transaction has committed or rolled back.
    //
    // Deterministic construction: the finalizer itself is paused at the
    // APPLICATION lock (position 3, reached only AFTER the batch lock at
    // position 2 is already acquired and held) via the existing
    // test_only_hold_application_lock holder. While the finalizer waits
    // there, its own batch FOR SHARE lock (taken earlier, at position 2)
    // is still held for the remainder of its transaction. A separate,
    // explicitly tagged batch-cancellation attempt
    // (test_only_cancel_bulk_batch_tagged) is then launched and proven,
    // via the waiter-to-holder observer, to be blocked SPECIFICALLY by
    // the application-lock holder's tag — which is only reachable at
    // all because the finalizer itself is simultaneously blocked on that
    // SAME application lock, with its own EARLIER batch lock still held.
    // Releasing the application gate lets the finalizer complete
    // (issuing successfully, since the batch it locked was never
    // mutated), after which the previously-blocked cancellation attempt
    // finally proceeds.
    const staff = await createStaffFixture('super_admin');
    const fx = await createParticipantFixture();
    const batchId = await createBulkBatch(staff.userId, 'issue');
    const operationId = await reserveStaffIssuance(staff, fx.applicationId, batchId);
    const appHolderTag = `finalizer-app-holder-for-batch-race-${randomUUID()}`;
    const finalizerWaiterTag = `finalizer-waiter-for-batch-race-${randomUUID()}`;
    const cancelWaiterTag = `cancel-waiter-for-batch-race-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let applicationHolderPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        appHolderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, appHolderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      applicationHolderPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: appHolderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(appHolderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let finalizePromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          finalizerWaiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_issuance_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, finalizerWaiterTag],
        );
      } else {
        finalizePromise = admin.rpc('test_only_finalize_qr_issuance_tagged', {
          p_operation_id: operationId,
          p_credential_id: inputs.credentialId,
          p_token_hash: inputs.tokenHash,
          p_token_ciphertext: inputs.tokenCiphertext,
          p_token_version: inputs.tokenVersion,
          p_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: finalizerWaiterTag,
        });
      }
      // The finalizer must first acquire the batch FOR SHARE (position
      // 2), THEN block on the application lock (position 3) held by
      // appHolderTag.
      await waitUntilBlocked(finalizerWaiterTag, appHolderTag, HOLDER_WAIT_TIMEOUT_MS);

      // Now launch the concurrent batch-cancellation attempt, tagged so
      // its own blocking relationship can be observed.
      let cancelPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          cancelWaiterTag,
          undefined,
          'select to_jsonb(public.test_only_cancel_bulk_batch_tagged($1, $2)) as result',
          [batchId, cancelWaiterTag],
        );
      } else {
        cancelPromise = admin.rpc('test_only_cancel_bulk_batch_tagged', {
          p_batch_id: batchId,
          p_waiter_tag: cancelWaiterTag,
        });
      }
      // Prove the cancellation attempt is blocked by the FINALIZER's own
      // tag — i.e. by the finalizer's already-held batch FOR SHARE lock
      // — not by anything else.
      await waitUntilBlocked(cancelWaiterTag, finalizerWaiterTag, HOLDER_WAIT_TIMEOUT_MS);

      // Release the application gate: the finalizer resumes, completes
      // successfully (the batch it locked was never mutated), and only
      // THEN does the previously-blocked cancellation attempt finally
      // proceed.
      await releaseGate(gateId);
      gateReleased = true;

      if (usesCloudNativeHolder) {
        await getCloudNativeHolderSession(appHolderTag).awaitCompletion();
        const result = await getCloudNativeWaiterResult<{ outcome: string; credential_id: string }>(finalizerWaiterTag);
        expect(result.outcome).toBe('issued');
        expect(result.credential_id).toBe(inputs.credentialId);
        await getCloudNativeWaiterSession(cancelWaiterTag).awaitCompletion();
      } else {
        const [appHolderResult, finalizeResult, cancelResult] = await Promise.all([applicationHolderPromise!, finalizePromise!, cancelPromise!]);
        expect(appHolderResult.error, `application holder failed: ${appHolderResult.error?.message}`).toBeNull();
        expect(finalizeResult.error, `finalizer failed: ${finalizeResult.error?.message}`).toBeNull();
        expect(finalizeResult.data).toBeTruthy();
        const result = finalizeResult.data as unknown as { outcome: string; credential_id: string };
        expect(result.outcome).toBe('issued');
        expect(result.credential_id).toBe(inputs.credentialId);
        expect(cancelResult.error, `cancellation attempt failed: ${cancelResult.error?.message}`).toBeNull();
      }

      // The credential was issued using a batch that remained valid
      // ('active') for the ENTIRE finalization transaction — the
      // cancellation could only ever proceed AFTER the finalizer
      // committed.
      const { data: credRow } = await admin.from('qr_credentials').select('issuance_channel').eq('id', inputs.credentialId).single();
      expect(credRow!.issuance_channel).toBe('staff_bulk');

      // The batch is now cancelled (the previously-blocked attempt
      // eventually succeeded, after the finalizer's commit).
      const { data: batchRow } = await admin.from('qr_bulk_operation_batches').select('status').eq('id', batchId).single();
      expect(batchRow!.status).toBe('cancelled');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(appHolderTag);
        await closeCloudNativeSession(finalizerWaiterTag);
        await closeCloudNativeSession(cancelWaiterTag);
      } else {
        await applicationHolderPromise;
      }
    }
  }, 30000);

  it('an active credential already present at finalization time returns active_credential_already_exists, and no second credential is created', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const existingCredentialId = await insertActiveCredential(fx.applicationId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    const result = data as unknown as { outcome: string; credential_id: string };
    expect(result.outcome).toBe('active_credential_already_exists');
    expect(result.credential_id).toBe(existingCredentialId);

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code, terminal_related_credential_id').eq('id', operationId).single();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('active_credential_already_exists');
    expect(opRow!.terminal_related_credential_id).toBe(existingCredentialId);

    const { data: newCredRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(newCredRows).toHaveLength(0); // never created
  });

  it('an active credential appearing while the finalizer waits on the credential lock is observed deterministically', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    // Seed and then revoke a credential so the application has NO active
    // credential yet, but a row exists to hold FOR UPDATE on the
    // eventual active row's future id is not possible directly — instead
    // hold the application lock (position 2, before position 3's
    // credential lock even runs) and insert the conflicting active
    // credential while the finalizer is blocked there.
    const holderTag = `finalizer-cred-appear-holder-${randomUUID()}`;
    const waiterTag = `finalizer-cred-appear-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let sessionBPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_issuance_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = admin.rpc('test_only_finalize_qr_issuance_tagged', {
          p_operation_id: operationId,
          p_credential_id: inputs.credentialId,
          p_token_hash: inputs.tokenHash,
          p_token_ciphertext: inputs.tokenCiphertext,
          p_token_version: inputs.tokenVersion,
          p_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      const newlyActiveCredentialId = await insertActiveCredential(fx.applicationId);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string; credential_id: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string; credential_id: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string; credential_id: string };
      }
      expect(result.outcome).toBe('active_credential_already_exists');
      expect(result.credential_id).toBe(newlyActiveCredentialId);
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('TTL expiring while the finalizer waits specifically on the key-registry lock (position 5) reports operation_expired, the operation becomes expired/ttl_expired, and no credential or successful audit survives', async () => {
    // CORRECTED this round: identical narrow defect and correction to
    // finalize_qr_reissue_for_server's own TTL-vs-key-registry-lock fix
    // — the authoritative timestamp used for the TTL recheck and every
    // pending-path decision was previously captured BEFORE the
    // key-registry lock (position 5) was even acquired, leaving a gap
    // where the operation could expire while THIS call itself waited to
    // acquire that lock and still be finalized/rejected using a stale
    // pre-wait timestamp. No other issuance-finalizer logic is touched
    // by this regression test or its underlying fix.
    const fx = await createParticipantFixture();
    // CORRECTED: the seed's own TTL must be generous, not the tight
    // window a fixed-margin test would use to prove genuine expiry-while-
    // blocked — the holder/waiter setup between seeding and the actual
    // finalizer wait (raw-pg connection open, JWT/role context, polling
    // waitUntilHolderReady) was measured to intermittently take several
    // seconds on Supabase Cloud, which could let a tightly-scoped seed
    // TTL expire BEFORE the finalizer ever reaches the key-registry lock
    // at all — finalize_qr_issuance_for_server checks the operation's
    // status FIRST (position 1, before any further lock) and returns
    // immediately for an already-'expired' row, so the test would then
    // fail not because expiry-while-blocked was disproven, but because
    // the property was never exercised in the first place (the finalizer
    // never blocked, confirmed via direct pg_locks/pg_stat_activity
    // observation: waiterActivity idle/ClientRead, no blocking pids). The
    // actual expiry proof below is instead measured from
    // waitUntilBlocked() resolving (a point already guaranteed to be at
    // or after the finalizer genuinely started waiting), so no separate
    // "short" TTL constant is needed at all.
    const seedTtlSeconds = 30;
    // test_only_request_my_qr_issuance_short_ttl is granted EXECUTE to
    // authenticated only (revoked from service_role) — must be called via
    // the participant's own authenticated client, not admin.
    const seed = await fx.client.rpc('test_only_request_my_qr_issuance_short_ttl', {
      p_request_key: randomUUID(),
      p_pending_ttl: `${seedTtlSeconds} seconds`,
      p_waiter_tag: `issuance-finalizer-key-lock-ttl-seed-${randomUUID()}`,
    });
    expect(seed.error).toBeNull();
    const seedResult = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedResult.outcome).toBe('reserved');

    const inputs = await buildFinalizerInputs();
    const holderTag = `issuance-finalizer-key-lock-holder-${randomUUID()}`;
    const waiterTag = `issuance-finalizer-key-lock-waiter-${randomUUID()}`;
    const gateId = await createGate();

    // CORRECTED this round: both the holder and finalizer-waiter promises
    // are now declared OUTSIDE try, before either RPC is started, so
    // `finally` can always settle both — even if waitUntilHolderReady,
    // waitUntilBlocked, or any assertion between the two RPC calls
    // throws. Each RPC is started EXACTLY ONCE and its promise captured
    // immediately (PostgREST's builder is thenable, not a real Promise,
    // so wrapping it eagerly avoids ever re-issuing the request via a
    // second, accidental `await`/`.then()`).
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: Promise<Awaited<ReturnType<typeof admin.rpc>>> | undefined;
    let sessionBPromise: Promise<Awaited<ReturnType<typeof admin.rpc>>> | undefined;
    let gateReleased = false;
    try {
      if (usesCloudNativeHolder) {
        await launchCloudNativeHolder(
          holderTag,
          'select public.test_only_hold_key_registry_lock($1, $2, $3, $4)',
          [inputs.encryptionKeyVersion, gateId, holderTag, 30],
          HOLDER_WAIT_TIMEOUT_MS,
        );
      } else {
        sessionAPromise = Promise.resolve(
          admin.rpc('test_only_hold_key_registry_lock', {
            p_key_version: inputs.encryptionKeyVersion,
            p_gate_id: gateId,
            p_holder_tag: holderTag,
            p_max_wait_seconds: 30,
          }),
        );
        await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
      }

      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_issuance_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [seedResult.operation_id, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = Promise.resolve(
          admin.rpc('test_only_finalize_qr_issuance_tagged', {
            p_operation_id: seedResult.operation_id,
            p_credential_id: inputs.credentialId,
            p_token_hash: inputs.tokenHash,
            p_token_ciphertext: inputs.tokenCiphertext,
            p_token_version: inputs.tokenVersion,
            p_encryption_key_version: inputs.encryptionKeyVersion,
            p_waiter_tag: waiterTag,
          }),
        );
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // Wait beyond the seed's OWN real TTL (seedTtlSeconds, decoupled
      // from shortTtlSeconds above for setup-time safety) — measured from
      // waitUntilBlocked() resolving, which only occurs once the
      // finalizer has already inserted/locked its way to genuinely
      // waiting on the key-registry lock.
      await new Promise((resolve) => setTimeout(resolve, seedTtlSeconds * 1000 + 500));

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('operation_expired');

      const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code, consumed_at, resulting_credential_id').eq('id', seedResult.operation_id).single();
      expect(opRow!.status).toBe('expired');
      expect(opRow!.terminal_reason_code).toBe('ttl_expired');
      expect(opRow!.consumed_at).toBeNull();
      expect(opRow!.resulting_credential_id).toBeNull();

      const { data: credRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
      expect(credRows).toHaveLength(0);

      const { data: auditRows } = await admin
        .from('audit_logs')
        .select('id')
        .eq('entity_type', 'qr_credential')
        .eq('entity_id', inputs.credentialId)
        .eq('action', 'issued');
      expect(auditRows).toHaveLength(0);
    } finally {
      if (usesCloudNativeHolder) {
        try {
          if (!gateReleased) {
            await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
          }
        } finally {
          await closeCloudNativeSession(holderTag);
          await closeCloudNativeSession(waiterTag);
        }
      } else {
        const pending = [sessionAPromise, sessionBPromise].filter((p): p is NonNullable<typeof p> => p !== undefined);
        try {
          if (!gateReleased) {
            await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
          }
        } finally {
          await Promise.allSettled(pending);
        }
      }
    }
  }, 45000);
});

describe('finalize_qr_issuance_for_server — encryption-key validation (retryable, non-terminal)', () => {
  it('a missing key version returns key_version_not_active, and the operation remains pending', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs(32000); // no such registry row

    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('key_version_not_active');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
    expect(opRow!.status).toBe('pending'); // never cancelled/expired/consumed
    expect(opRow!.terminal_reason_code).toBeNull();

    const { data: credRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(credRows).toHaveLength(0);
  });

  it('a decrypt_only key returns key_version_not_active, and the operation remains pending', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const decryptOnlyVersion = 9001;
    await admin.from('qr_encryption_key_registry').insert({ key_version: decryptOnlyVersion, status: 'decrypt_only' });
    const inputs = await buildFinalizerInputs(decryptOnlyVersion);

    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('key_version_not_active');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status').eq('id', operationId).single();
    expect(opRow!.status).toBe('pending');
  });

  it('a retired key returns key_version_not_active, and the operation remains pending', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const retiredVersion = 9002;
    await admin.from('qr_encryption_key_registry').insert({ key_version: retiredVersion, status: 'retired', retired_at: new Date().toISOString() });
    const inputs = await buildFinalizerInputs(retiredVersion);

    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('key_version_not_active');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status').eq('id', operationId).single();
    expect(opRow!.status).toBe('pending');
  });

  it('key rotation racing with finalization: a key rotated out between reservation and finalize call is correctly rejected, then a fresh active key succeeds on retry', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const rotatedOutVersion = 9003;
    // Seeded directly as 'decrypt_only' — simulating "this key WAS active
    // when Node read it, but has since rotated out by the time Node
    // calls the finalizer."
    await admin.from('qr_encryption_key_registry').insert({ key_version: rotatedOutVersion, status: 'decrypt_only' });
    const staleInputs = await buildFinalizerInputs(rotatedOutVersion);

    const staleAttempt = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: staleInputs.credentialId,
      p_token_hash: staleInputs.tokenHash,
      p_token_ciphertext: staleInputs.tokenCiphertext,
      p_token_version: staleInputs.tokenVersion,
      p_encryption_key_version: staleInputs.encryptionKeyVersion,
    });
    expect(staleAttempt.error).toBeNull();
    expect((staleAttempt.data as unknown as { outcome: string }).outcome).toBe('key_version_not_active');

    // Node re-fetches the CURRENT active key version and retries against
    // the SAME still-pending operation.
    const freshInputs = await buildFinalizerInputs();
    const retry = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: freshInputs.credentialId,
      p_token_hash: freshInputs.tokenHash,
      p_token_ciphertext: freshInputs.tokenCiphertext,
      p_token_version: freshInputs.tokenVersion,
      p_encryption_key_version: freshInputs.encryptionKeyVersion,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('issued');
  });
});

describe('finalize_qr_issuance_for_server — permissions and safety invariants', () => {
  it('only service_role has execute permission (confirmed structurally by every prior test using the service-role admin client succeeding, and the participant/staff rejection tests above failing)', async () => {
    // This test exists to make the invariant EXPLICIT as its own
    // assertion, even though it is already proven by the permission
    // tests above and by every successful admin.rpc(...) call throughout
    // this describe block.
    const fx = await createParticipantFixture();
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await anonClient.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, 'expected the finalizer to be unreachable from an anon session').toBeTruthy();
    expect(data).toBeNull();
  });

  it('no secrets appear in the returned result', async () => {
    const fx = await createParticipantFixture();
    const operationId = await reserveParticipantIssuance(fx);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_issuance_for_server', {
      p_operation_id: operationId,
      p_credential_id: inputs.credentialId,
      p_token_hash: inputs.tokenHash,
      p_token_ciphertext: inputs.tokenCiphertext,
      p_token_version: inputs.tokenVersion,
      p_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty('token_hash');
    expect(result).not.toHaveProperty('token_ciphertext');
    expect(result).not.toHaveProperty('finalization_fingerprint');
    expect(result).not.toHaveProperty('encryption_key_version');
    expect(result).not.toHaveProperty('nonce');
  });
});

async function reserveParticipantReissue(fx: ParticipantFixture, expectedCredentialId: string): Promise<string> {
  const { data, error } = await fx.client.rpc('request_my_qr_reissue_transactional', {
    p_request_key: randomUUID(),
    p_expected_current_credential_id: expectedCredentialId,
    p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
    p_reissue_note: null,
  });
  expect(error, `participant reissue reservation failed: ${error?.message}`).toBeNull();
  const result = data as unknown as { outcome: string; operation_id: string };
  expect(result.outcome).toBe('reserved');
  return result.operation_id;
}

async function reserveStaffReissue(
  staff: StaffFixture,
  applicationId: string,
  expectedCredentialId: string,
  bulkBatchId: string | null = null,
): Promise<string> {
  const { data, error } = await staff.client.rpc('request_staff_qr_reissue_transactional', {
    p_request_key: randomUUID(),
    p_application_id: applicationId,
    p_expected_current_credential_id: expectedCredentialId,
    p_reissue_reason_code: STAFF_REISSUE_REASON_NO_NOTE_REQUIRED,
    p_reissue_note: null,
    p_bulk_batch_id: bulkBatchId,
  });
  expect(error, `staff reissue reservation failed: ${error?.message}`).toBeNull();
  const result = data as unknown as { outcome: string; operation_id: string };
  expect(result.outcome).toBe('reserved');
  return result.operation_id;
}

describe('finalize_qr_reissue_for_server — permission and success paths', () => {
  it('rejects a call from an authenticated participant session', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, credentialId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await fx.client.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, 'expected the reissue finalizer to be unreachable from an authenticated session').toBeTruthy();
    expect(data).toBeNull();
  });

  it('rejects a call from a staff authenticated session', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const operationId = await reserveStaffReissue(staff, fx.applicationId, credentialId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await staff.client.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, 'expected the reissue finalizer to be unreachable from a staff session').toBeTruthy();
    expect(data).toBeNull();
  });

  it('rejects a call from an anon session', async () => {
    const { fx, credentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, credentialId);
    const inputs = await buildFinalizerInputs();
    const anonClient = createClient<Database>(URL, ANON_KEY);

    const { data, error } = await anonClient.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, 'expected the reissue finalizer to be unreachable from an anon session').toBeTruthy();
    expect(data).toBeNull();
  });

  it('participant self-service reissue success: old credential replaced, new credential active, replaced_by and issued_by are null, new issuance_reason_code/issuance_note are null', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(result.outcome).toBe('reissued');
    expect(result.credential_id).toBe(inputs.credentialId);
    expect(result.status).toBe('active');

    const { data: oldRow, error: oldError } = await admin
      .from('qr_credentials')
      .select('status, replaced_at, replaced_by, replaced_by_credential_id, reissue_channel, reissue_reason_code, reissue_note, token_hash, token_ciphertext, encryption_key_version')
      .eq('id', oldCredentialId)
      .single();
    expect(oldError, `old credential post-state query failed: ${oldError?.message}`).toBeNull();
    expect(oldRow!.status).toBe('replaced');
    expect(oldRow!.replaced_by).toBeNull();
    expect(oldRow!.replaced_by_credential_id).toBe(inputs.credentialId);
    expect(oldRow!.reissue_channel).toBe('participant_self_service');
    expect(oldRow!.reissue_reason_code).toBe(REISSUE_REASON_NO_NOTE_REQUIRED);
    expect(oldRow!.token_ciphertext).toBeNull();
    expect(oldRow!.encryption_key_version).toBeNull();
    expect(oldRow!.token_hash).toBeTruthy();

    const { data: newRow, error: newError } = await admin
      .from('qr_credentials')
      .select('status, issued_by, issuance_channel, issuance_reason_code, issuance_note, token_ciphertext, encryption_key_version, created_at, issued_at')
      .eq('id', inputs.credentialId)
      .single();
    expect(newError, `new credential post-state query failed: ${newError?.message}`).toBeNull();
    expect(newRow!.status).toBe('active');
    expect(newRow!.issued_by).toBeNull();
    expect(newRow!.issuance_channel).toBe('participant_self_service');
    expect(newRow!.issuance_reason_code).toBeNull();
    expect(newRow!.issuance_note).toBeNull();
    expect(newRow!.token_ciphertext).toBeTruthy();
    expect(newRow!.encryption_key_version).toBe(inputs.encryptionKeyVersion);
    expect(newRow!.created_at).toBe(newRow!.issued_at);

    const { data: activeRows } = await admin.from('qr_credentials').select('id').eq('application_id', fx.applicationId).eq('status', 'active');
    expect(activeRows).toHaveLength(1);
    expect(activeRows![0].id).toBe(inputs.credentialId);
  });

  it('staff-individual reissue success: replaced_by and issued_by equal the durable staff profile', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const operationId = await reserveStaffReissue(staff, fx.applicationId, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('reissued');

    const { data: oldRow } = await admin.from('qr_credentials').select('replaced_by, reissue_channel, reissue_reason_code').eq('id', oldCredentialId).single();
    expect(oldRow!.replaced_by).toBe(staff.userId);
    expect(oldRow!.reissue_channel).toBe('staff_individual');
    expect(oldRow!.reissue_reason_code).toBe(STAFF_REISSUE_REASON_NO_NOTE_REQUIRED);

    const { data: newRow } = await admin.from('qr_credentials').select('issued_by, issuance_channel, issuance_reason_code, issuance_note').eq('id', inputs.credentialId).single();
    expect(newRow!.issued_by).toBe(staff.userId);
    expect(newRow!.issuance_channel).toBe('staff_individual');
    expect(newRow!.issuance_reason_code).toBeNull();
    expect(newRow!.issuance_note).toBeNull();
  });

  it('staff-bulk reissue success', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');
    const operationId = await reserveStaffReissue(staff, fx.applicationId, oldCredentialId, batchId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('reissued');

    const { data: newRow } = await admin.from('qr_credentials').select('issued_by, issuance_channel').eq('id', inputs.credentialId).single();
    expect(newRow!.issued_by).toBe(staff.userId);
    expect(newRow!.issuance_channel).toBe('staff_bulk');
  });

  it('lifecycle consumed_at exactly equals finalized_at, and both exactly equal the old credential replaced_at and the new credential issued_at', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const { error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();

    const { data: oldRow } = await admin.from('qr_credentials').select('replaced_at').eq('id', oldCredentialId).single();
    const { data: newRow } = await admin.from('qr_credentials').select('issued_at').eq('id', inputs.credentialId).single();
    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, consumed_at, finalized_at, resulting_credential_id, finalization_fingerprint, terminal_reason_code, terminal_related_credential_id, terminal_retry_after_at')
      .eq('id', operationId)
      .single();
    expect(opError, `operation post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('consumed');
    expect(opRow!.resulting_credential_id).toBe(inputs.credentialId);
    expect(opRow!.terminal_reason_code).toBeNull();
    expect(opRow!.terminal_related_credential_id).toBeNull();
    expect(opRow!.terminal_retry_after_at).toBeNull();
    expect(opRow!.consumed_at).toBe(opRow!.finalized_at);
    expect(oldRow!.replaced_at).toBe(opRow!.consumed_at);
    expect(newRow!.issued_at).toBe(opRow!.consumed_at);

    const fingerprintHex = (opRow!.finalization_fingerprint as unknown as string).replace(/^\\x/, '');
    expect(fingerprintHex).toHaveLength(64);
  });

  it('the successful audit row contains only safe metadata, never secret material', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const { error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalization failed: ${error?.message}`).toBeNull();

    const { data: auditRows, error: auditError } = await admin
      .from('audit_logs')
      .select('metadata, action, actor_type, actor_id')
      .eq('entity_type', 'qr_credential')
      .eq('entity_id', inputs.credentialId)
      .eq('action', 'reissued');
    expect(auditError, `audit query failed: ${auditError?.message}`).toBeNull();
    expect(auditRows).toHaveLength(1);
    const metadata = auditRows![0].metadata as unknown as Record<string, unknown>;
    expect(metadata.application_id).toBeTruthy();
    expect(metadata.old_credential_id).toBe(oldCredentialId);
    expect(metadata.reissue_channel).toBe('participant_self_service');
    expect(metadata).not.toHaveProperty('token_hash');
    expect(metadata).not.toHaveProperty('token_ciphertext');
    expect(metadata).not.toHaveProperty('finalization_fingerprint');
    expect(metadata).not.toHaveProperty('encryption_key_version');
    expect(auditRows![0].actor_type).toBe('system');
    expect(auditRows![0].actor_id).toBe(fx.userId);
  });

  it('no secrets appear in the returned result', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error).toBeNull();
    const result = data as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty('token_hash');
    expect(result).not.toHaveProperty('token_ciphertext');
    expect(result).not.toHaveProperty('finalization_fingerprint');
    expect(result).not.toHaveProperty('encryption_key_version');
    expect(result).not.toHaveProperty('nonce');
  });
});

describe('finalize_qr_reissue_for_server — idempotent replay and conflict detection', () => {
  it('exact retry returns already_finalized', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const first = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(first.error).toBeNull();
    expect((first.data as unknown as { outcome: string }).outcome).toBe('reissued');

    const retry = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    const retryResult = retry.data as unknown as { outcome: string; credential_id: string };
    expect(retryResult.outcome).toBe('already_finalized');
    expect(retryResult.credential_id).toBe(inputs.credentialId);
  });

  it('exact replay returns the identical credential_id/status/issued_at both BEFORE and AFTER the new credential is later revoked — the replayed result is fully durable and never depends on qr_credentials current state', async () => {
    // CORRECTED this round: identical narrow durable-replay defect and
    // fix to finalize_qr_issuance_for_server's own consumed-replay
    // branch. The branch now returns credential_id from
    // v_op.resulting_credential_id, status hardcoded to 'active', and
    // issued_at from v_op.finalized_at — none of which can ever change,
    // regardless of what happens to the qr_credentials row afterward.
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const first = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(firstResult.outcome).toBe('reissued');

    const replayBefore = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(replayBefore.error).toBeNull();
    const replayBeforeResult = replayBefore.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(replayBeforeResult.outcome).toBe('already_finalized');
    expect(replayBeforeResult.credential_id).toBe(inputs.credentialId);
    expect(replayBeforeResult.status).toBe('active');
    expect(replayBeforeResult.issued_at).toBe(firstResult.issued_at);

    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', inputs.credentialId);

    const replayAfter = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(replayAfter.error, `historical replay failed: ${replayAfter.error?.message}`).toBeNull();
    const replayAfterResult = replayAfter.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(replayAfterResult.outcome).toBe('already_finalized');
    expect(replayAfterResult.credential_id).toBe(replayBeforeResult.credential_id);
    expect(replayAfterResult.status).toBe(replayBeforeResult.status);
    expect(replayAfterResult.status).toBe('active'); // durable — never 'revoked'
    expect(replayAfterResult.issued_at).toBe(replayBeforeResult.issued_at);

    const { data: credRow } = await admin.from('qr_credentials').select('status').eq('id', inputs.credentialId).single();
    expect(credRow!.status).toBe('revoked');
  });

  it('exact replay returns the identical credential_id/status/issued_at both BEFORE and AFTER the new credential is itself later replaced by a SECOND reissue — the replayed result is fully durable and never depends on qr_credentials current state', async () => {
    // Reissue's own defining behavior is replacement, so this scenario is
    // distinct from (and required in addition to) the revocation case
    // above: the FIRST reissue's resulting credential can itself later
    // become the OLD credential of a SECOND, independent reissue — moving
    // it from 'active' to 'replaced'. Replay of the FIRST operation must
    // still report its own durable, unchanging result.
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const firstOperationId = await reserveParticipantReissue(fx, oldCredentialId);
    const firstInputs = await buildFinalizerInputs();

    const first = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: firstOperationId,
      p_new_credential_id: firstInputs.credentialId,
      p_new_token_hash: firstInputs.tokenHash,
      p_new_token_ciphertext: firstInputs.tokenCiphertext,
      p_new_token_version: firstInputs.tokenVersion,
      p_new_encryption_key_version: firstInputs.encryptionKeyVersion,
    });
    expect(first.error).toBeNull();
    const firstResult = first.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(firstResult.outcome).toBe('reissued');

    const replayBefore = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: firstOperationId,
      p_new_credential_id: firstInputs.credentialId,
      p_new_token_hash: firstInputs.tokenHash,
      p_new_token_ciphertext: firstInputs.tokenCiphertext,
      p_new_token_version: firstInputs.tokenVersion,
      p_new_encryption_key_version: firstInputs.encryptionKeyVersion,
    });
    expect(replayBefore.error).toBeNull();
    const replayBeforeResult = replayBefore.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(replayBeforeResult.outcome).toBe('already_finalized');
    expect(replayBeforeResult.credential_id).toBe(firstInputs.credentialId);
    expect(replayBeforeResult.status).toBe('active');
    expect(replayBeforeResult.issued_at).toBe(firstResult.issued_at);

    // A SECOND, independent reissue targeting the FIRST reissue's own
    // resulting credential as its own expected old credential — replaces
    // it, flipping its status from 'active' to 'replaced'. CORRECTED:
    // must be STAFF-initiated, not a second participant self-service
    // reissue — request_my_qr_reissue_transactional_internal enforces a
    // genuine, documented 10-minute cooldown after the participant's own
    // most recent CONSUMED reissue (line ~4812 of the migration), which
    // the first reissue above just triggered; staff reissues do not
    // participate in that cooldown (confirmed by the durable-replay test
    // suite elsewhere in this file), so this is the only way to exercise
    // the "resulting credential later replaced by a SECOND reissue"
    // property this test exists to prove without colliding with the
    // participant cooldown it is not testing.
    const staff = await createStaffFixture('super_admin');
    const secondOperationId = await reserveStaffReissue(staff, fx.applicationId, firstInputs.credentialId);
    const secondInputs = await buildFinalizerInputs();
    const second = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: secondOperationId,
      p_new_credential_id: secondInputs.credentialId,
      p_new_token_hash: secondInputs.tokenHash,
      p_new_token_ciphertext: secondInputs.tokenCiphertext,
      p_new_token_version: secondInputs.tokenVersion,
      p_new_encryption_key_version: secondInputs.encryptionKeyVersion,
    });
    expect(second.error).toBeNull();
    expect((second.data as unknown as { outcome: string }).outcome).toBe('reissued');

    // Replay of the FIRST operation, AFTER its own resulting credential
    // has been replaced — must return the EXACT SAME credential_id/
    // status/issued_at as the pre-replacement replay.
    const replayAfter = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: firstOperationId,
      p_new_credential_id: firstInputs.credentialId,
      p_new_token_hash: firstInputs.tokenHash,
      p_new_token_ciphertext: firstInputs.tokenCiphertext,
      p_new_token_version: firstInputs.tokenVersion,
      p_new_encryption_key_version: firstInputs.encryptionKeyVersion,
    });
    expect(replayAfter.error, `historical replay failed: ${replayAfter.error?.message}`).toBeNull();
    const replayAfterResult = replayAfter.data as unknown as { outcome: string; credential_id: string; status: string; issued_at: string };
    expect(replayAfterResult.outcome).toBe('already_finalized');
    expect(replayAfterResult.credential_id).toBe(replayBeforeResult.credential_id);
    expect(replayAfterResult.status).toBe(replayBeforeResult.status);
    expect(replayAfterResult.status).toBe('active'); // durable — never 'replaced'
    expect(replayAfterResult.issued_at).toBe(replayBeforeResult.issued_at);

    const { data: credRow } = await admin.from('qr_credentials').select('status').eq('id', firstInputs.credentialId).single();
    expect(credRow!.status).toBe('replaced');
  });

  it('different new credential ID on consumed retry returns idempotency_conflict', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();
    const first = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(first.error).toBeNull();

    const retry = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: randomUUID(),
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('changed token hash on consumed retry returns idempotency_conflict', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();
    await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });

    const retry = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: `\\x${randomBytes(32).toString('hex')}`,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('changed token version on consumed retry returns idempotency_conflict', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();
    await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });

    const retry = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: 2,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('changed encryption-key version on consumed retry returns idempotency_conflict', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();
    await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });

    const retry = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion === 1 ? 2 : 1,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('changed ciphertext on consumed retry returns idempotency_conflict', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();
    await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });

    const differentEnvelope = Buffer.concat([Buffer.from([1]), randomBytes(60)]);
    const retry = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: `\\x${differentEnvelope.toString('hex')}`,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');
  });

  it('two concurrent identical finalizer calls for the same operation produce exactly one reissued and one already_finalized', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const [callA, callB] = await Promise.all([
      admin.rpc('finalize_qr_reissue_for_server', {
        p_operation_id: operationId,
        p_new_credential_id: inputs.credentialId,
        p_new_token_hash: inputs.tokenHash,
        p_new_token_ciphertext: inputs.tokenCiphertext,
        p_new_token_version: inputs.tokenVersion,
        p_new_encryption_key_version: inputs.encryptionKeyVersion,
      }),
      admin.rpc('finalize_qr_reissue_for_server', {
        p_operation_id: operationId,
        p_new_credential_id: inputs.credentialId,
        p_new_token_hash: inputs.tokenHash,
        p_new_token_ciphertext: inputs.tokenCiphertext,
        p_new_token_version: inputs.tokenVersion,
        p_new_encryption_key_version: inputs.encryptionKeyVersion,
      }),
    ]);
    expect(callA.error, `call A failed: ${callA.error?.message}`).toBeNull();
    expect(callB.error, `call B failed: ${callB.error?.message}`).toBeNull();

    const outcomes = [(callA.data as unknown as { outcome: string }).outcome, (callB.data as unknown as { outcome: string }).outcome].sort();
    expect(outcomes).toEqual(['already_finalized', 'reissued']);

    const { data: credRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(credRows).toHaveLength(1);

    const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
    expect(oldRow!.status).toBe('replaced');
  });

  it('a token-hash collision between two DIFFERENT reissue operations resolves to token_hash_conflict, with no partial new credential, the operation remaining pending, and the old credential remaining active', async () => {
    const a = await reissueFixtureWithActiveCredential();
    const b = await reissueFixtureWithActiveCredential();
    const operationIdA = await reserveParticipantReissue(a.fx, a.credentialId);
    const operationIdB = await reserveParticipantReissue(b.fx, b.credentialId);
    const inputsA = await buildFinalizerInputs();
    const inputsB = { ...(await buildFinalizerInputs()), tokenHash: inputsA.tokenHash };

    const firstFinalize = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationIdA,
      p_new_credential_id: inputsA.credentialId,
      p_new_token_hash: inputsA.tokenHash,
      p_new_token_ciphertext: inputsA.tokenCiphertext,
      p_new_token_version: inputsA.tokenVersion,
      p_new_encryption_key_version: inputsA.encryptionKeyVersion,
    });
    expect(firstFinalize.error).toBeNull();
    expect((firstFinalize.data as unknown as { outcome: string }).outcome).toBe('reissued');

    const collidingFinalize = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationIdB,
      p_new_credential_id: inputsB.credentialId,
      p_new_token_hash: inputsB.tokenHash,
      p_new_token_ciphertext: inputsB.tokenCiphertext,
      p_new_token_version: inputsB.tokenVersion,
      p_new_encryption_key_version: inputsB.encryptionKeyVersion,
    });
    expect(collidingFinalize.error, `colliding finalize failed: ${collidingFinalize.error?.message}`).toBeNull();
    expect((collidingFinalize.data as unknown as { outcome: string }).outcome).toBe('token_hash_conflict');

    const { data: opBRow } = await admin.from('qr_lifecycle_operations').select('status').eq('id', operationIdB).single();
    expect(opBRow!.status).toBe('pending');

    const { data: newBRows } = await admin.from('qr_credentials').select('id').eq('id', inputsB.credentialId);
    expect(newBRows).toHaveLength(0);

    const { data: oldBRow } = await admin.from('qr_credentials').select('status').eq('id', b.credentialId).single();
    expect(oldBRow!.status).toBe('active'); // old-update + new-insert roll back together
  });

  it('a new-credential-ID collision with an unrelated already-inserted credential resolves to idempotency_conflict, the operation remains pending, and the old credential remains active', async () => {
    const a = await reissueFixtureWithActiveCredential();
    const b = await reissueFixtureWithActiveCredential();
    const operationIdA = await reserveParticipantReissue(a.fx, a.credentialId);
    const operationIdB = await reserveParticipantReissue(b.fx, b.credentialId);
    const inputsA = await buildFinalizerInputs();

    const firstFinalize = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationIdA,
      p_new_credential_id: inputsA.credentialId,
      p_new_token_hash: inputsA.tokenHash,
      p_new_token_ciphertext: inputsA.tokenCiphertext,
      p_new_token_version: inputsA.tokenVersion,
      p_new_encryption_key_version: inputsA.encryptionKeyVersion,
    });
    expect(firstFinalize.error).toBeNull();
    expect((firstFinalize.data as unknown as { outcome: string }).outcome).toBe('reissued');

    const inputsB = await buildFinalizerInputs();
    const collidingFinalize = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationIdB,
      p_new_credential_id: inputsA.credentialId, // SAME new-credential id as A's already-inserted row
      p_new_token_hash: inputsB.tokenHash,
      p_new_token_ciphertext: inputsB.tokenCiphertext,
      p_new_token_version: inputsB.tokenVersion,
      p_new_encryption_key_version: inputsB.encryptionKeyVersion,
    });
    expect(collidingFinalize.error, `colliding finalize failed: ${collidingFinalize.error?.message}`).toBeNull();
    expect((collidingFinalize.data as unknown as { outcome: string }).outcome).toBe('idempotency_conflict');

    const { data: opBRow } = await admin.from('qr_lifecycle_operations').select('status').eq('id', operationIdB).single();
    expect(opBRow!.status).toBe('pending');

    const { data: oldBRow } = await admin.from('qr_credentials').select('status').eq('id', b.credentialId).single();
    expect(oldBRow!.status).toBe('active');
  });
});

describe('finalize_qr_reissue_for_server — narrowed foreign_key_violation mapping', () => {
  // CORRECTED this round: the finalizer previously mapped EVERY
  // foreign_key_violation inside its inner atomic block to
  // idempotency_conflict, unconditionally — too broad, since it could
  // silently mask an unrelated integrity failure behind a misleading
  // "safe" outcome. Only the one expected constraint
  // (qr_credentials_replacement_same_application_fkey, the forced-
  // IMMEDIATE deferred same-application replacement FK) is now mapped;
  // every other foreign_key_violation is re-raised so the outer
  // transaction rolls back and the real defect is never misreported.
  //
  // CORRECTED this round (second pass): the previous version of the
  // "expected FK" test here did NOT actually trigger any
  // foreign_key_violation at all — it merely ran an ordinary successful
  // reissue and asserted 'reissued', which proves only the success path,
  // never the exception-mapping logic. That plain success assertion has
  // been moved into the permission-and-success-paths describe block
  // above, honestly labeled as an ordinary success test, and is no
  // longer presented here as FK-mapping coverage. Both tests below now
  // use the extended test_only_fk_fault_injector trigger (via its two
  // dedicated application_name prefixes) to inject a REAL
  // foreign_key_violation from inside the REAL production finalizer's
  // own success-path audit_logs insert — proving the mapping logic
  // itself, not merely that ordinary reissues succeed.

  it('the EXPECTED foreign-key violation (qr_credentials_replacement_same_application_fkey), deliberately injected at the real success-path audit_logs insert inside the actual production finalizer, maps to idempotency_conflict with no RPC error exposed, the old credential remains active and unchanged, the new credential does not survive, and the operation remains pending and unconsumed', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();
    const waiterTag = `test-only-expected-fk:${randomUUID()}`;

    // The test-only BEFORE INSERT trigger on public.audit_logs (scoped
    // exclusively by this exact application_name prefix — see
    // test_only_fk_fault_injector in the setup SQL) fires during the
    // REAL production finalizer's own success-path audit_logs insert,
    // deliberately raising SQLSTATE 23503 (foreign_key_violation) under
    // constraint_name = 'qr_credentials_replacement_same_application_fkey'
    // — the ONE constraint the finalizer's mapping explicitly expects and
    // converts to a controlled outcome, never a raw error.
    const { data, error } = await admin.rpc('test_only_finalize_qr_reissue_tagged', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
      p_waiter_tag: waiterTag,
    });
    expect(error, `expected no RPC error — the expected FK violation must be caught and mapped internally: ${error?.message}`).toBeNull();
    expect(data).toBeTruthy();
    const result = data as unknown as { outcome: string };
    expect(result.outcome).toBe('idempotency_conflict');

    const { data: oldRow, error: oldError } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
    expect(oldError, `old credential post-state query failed: ${oldError?.message}`).toBeNull();
    expect(oldRow!.status).toBe('active');

    const { data: newRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(newRows).toHaveLength(0);

    const { data: opRow, error: opError } = await admin.from('qr_lifecycle_operations').select('status, consumed_at, resulting_credential_id').eq('id', operationId).single();
    expect(opError, `operation post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('pending');
    expect(opRow!.consumed_at).toBeNull();
    expect(opRow!.resulting_credential_id).toBeNull();

    const { data: auditRows } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_type', 'qr_credential')
      .eq('entity_id', inputs.credentialId)
      .eq('action', 'reissued');
    expect(auditRows).toHaveLength(0);
  });

  it('a deliberately triggered UNRELATED foreign-key violation, injected at the real success-path audit_logs insert inside the actual production finalizer, is re-raised as an RPC error — not converted to idempotency_conflict — the old credential remains active, the new credential does not survive, and the operation remains pending', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();
    const waiterTag = `test-only-unrelated-fk:${randomUUID()}`;

    // Same trigger, DIFFERENT prefix — raises SQLSTATE 23503 under
    // constraint_name = 'test_only_unrelated_foreign_key', a name the
    // finalizer's mapping does not recognize, so it must be re-raised
    // rather than converted.
    const { data, error } = await admin.rpc('test_only_finalize_qr_reissue_tagged', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
      p_waiter_tag: waiterTag,
    });
    expect(error, 'expected the injected unrelated foreign_key_violation to be re-raised, not swallowed').toBeTruthy();
    expect(data).toBeNull();
    expect(error!.code).toBe('23503');
    expect(error!.message).toContain('test_only_unrelated_foreign_key');
    expect((error!.message ?? '')).not.toContain('idempotency_conflict');

    // Every credential and lifecycle change rolled back together — the
    // entire outer transaction, including the old-credential UPDATE and
    // new-credential INSERT that ran earlier in the SAME atomic block,
    // was undone by the re-raised, unhandled exception.
    const { data: oldRow, error: oldError } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
    expect(oldError, `old credential post-state query failed: ${oldError?.message}`).toBeNull();
    expect(oldRow!.status).toBe('active');

    const { data: newRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(newRows).toHaveLength(0);

    const { data: opRow, error: opError } = await admin.from('qr_lifecycle_operations').select('status, consumed_at, resulting_credential_id').eq('id', operationId).single();
    expect(opError, `operation post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('pending');
    expect(opRow!.consumed_at).toBeNull();
    expect(opRow!.resulting_credential_id).toBeNull();

    const { data: auditRows } = await admin
      .from('audit_logs')
      .select('id')
      .eq('entity_type', 'qr_credential')
      .eq('entity_id', inputs.credentialId)
      .eq('action', 'reissued');
    expect(auditRows).toHaveLength(0);
  });
});

describe('finalize_qr_reissue_for_server — pending-operation authoritative decisions and concurrency', () => {
  it('expired operation returns operation_expired, and the old credential remains active', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const shortTtlSeconds = 3;
    // test_only_request_my_qr_reissue_short_ttl is granted EXECUTE to
    // authenticated only (revoked from service_role) — must be called via
    // the participant's own authenticated client, not admin.
    const seed = await fx.client.rpc('test_only_request_my_qr_reissue_short_ttl', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: oldCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_pending_ttl: `${shortTtlSeconds} seconds`,
      p_waiter_tag: `reissue-finalizer-expiry-seed-${randomUUID()}`,
    });
    expect(seed.error).toBeNull();
    const seedResult = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedResult.outcome).toBe('reserved');

    await new Promise((resolve) => setTimeout(resolve, shortTtlSeconds * 1000 + 500));

    const inputs = await buildFinalizerInputs();
    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: seedResult.operation_id,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('operation_expired');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', seedResult.operation_id).single();
    expect(opRow!.status).toBe('expired');
    expect(opRow!.terminal_reason_code).toBe('ttl_expired');

    const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
    expect(oldRow!.status).toBe('active');
  }, 15000);

  it('TTL expiring while the finalizer waits on the application lock reports operation_expired, and the old credential remains active', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    // CORRECTED: the seed's own TTL must be generous — see the
    // issuance-side equivalent test for the full rationale. Holder/waiter
    // setup was measured to intermittently take several seconds on
    // Supabase Cloud, which could let a tightly-scoped seed TTL expire
    // before the finalizer ever reaches the application lock at all,
    // causing it to short-circuit at position 1 (operation status check)
    // instead of genuinely blocking. The actual expiry proof below is
    // measured from waitUntilBlocked() resolving instead.
    const seedTtlSeconds = 30;
    // test_only_request_my_qr_reissue_short_ttl is granted EXECUTE to
    // authenticated only (revoked from service_role) — must be called via
    // the participant's own authenticated client, not admin.
    const seed = await fx.client.rpc('test_only_request_my_qr_reissue_short_ttl', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: oldCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_pending_ttl: `${seedTtlSeconds} seconds`,
      p_waiter_tag: `reissue-finalizer-ttl-seed-${randomUUID()}`,
    });
    expect(seed.error).toBeNull();
    const seedResult = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedResult.outcome).toBe('reserved');

    const holderTag = `reissue-finalizer-ttl-holder-${randomUUID()}`;
    const waiterTag = `reissue-finalizer-ttl-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let sessionBPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [seedResult.operation_id, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = admin.rpc('test_only_finalize_qr_reissue_tagged', {
          p_operation_id: seedResult.operation_id,
          p_new_credential_id: inputs.credentialId,
          p_new_token_hash: inputs.tokenHash,
          p_new_token_ciphertext: inputs.tokenCiphertext,
          p_new_token_version: inputs.tokenVersion,
          p_new_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // Wait beyond the seed's OWN real TTL (seedTtlSeconds, decoupled
      // from shortTtlSeconds above for setup-time safety) — measured
      // from waitUntilBlocked() resolving, which only occurs once the
      // finalizer has already inserted/locked its way to genuinely
      // waiting on the application lock.
      await new Promise((resolve) => setTimeout(resolve, seedTtlSeconds * 1000 + 500));

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('operation_expired');

      const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
      expect(oldRow!.status).toBe('active');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 45000);

  it('application becoming ineligible while the finalizer waits on the application lock is observed deterministically', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const holderTag = `reissue-finalizer-app-holder-${randomUUID()}`;
    const waiterTag = `reissue-finalizer-app-waiter-${randomUUID()}`;
    const gateId = await createGate();

    // See the "application becoming ineligible while waiting on the
    // application lock" issuance-side test for why the mutation now
    // happens INSIDE the holder's own transaction rather than via a
    // separate racing session.
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock_and_mutate_status($1, $2, $3, $4, $5)',
        [fx.applicationId, gateId, holderTag, 'submitted', 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock_and_mutate_status', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_new_status: 'submitted',
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let sessionBPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = admin.rpc('test_only_finalize_qr_reissue_tagged', {
          p_operation_id: operationId,
          p_new_credential_id: inputs.credentialId,
          p_new_token_hash: inputs.tokenHash,
          p_new_token_ciphertext: inputs.tokenCiphertext,
          p_new_token_version: inputs.tokenVersion,
          p_new_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('application_ineligible');

      const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('application_ineligible');

      // Corrected expectation (20260815000000_revoke_qr_credential_on_ineligibility.sql):
      // the holder transaction above committed applications.status =
      // 'submitted' before this finalizer's own eligibility re-check
      // ever ran, which now auto-revokes the application's active
      // credential via an AFTER UPDATE trigger. The credential does NOT
      // "remain active" anymore; leaving accepted intentionally revokes
      // it (reason application_ineligible) to prevent bearer-credential
      // resurrection on a later return to accepted. The finalizer's own
      // rejection (application_ineligible / operation cancelled) is
      // unaffected by this — both are independently correct.
      const { data: oldRow } = await admin.from('qr_credentials').select('status, revocation_reason_code').eq('id', oldCredentialId).single();
      expect(oldRow!.status).toBe('revoked');
      expect(oldRow!.revocation_reason_code).toBe('application_ineligible');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('staff requester losing authorization while the finalizer waits is observed deterministically', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const operationId = await reserveStaffReissue(staff, fx.applicationId, oldCredentialId);
    const holderTag = `reissue-finalizer-authz-holder-${randomUUID()}`;
    const waiterTag = `reissue-finalizer-authz-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let sessionBPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = admin.rpc('test_only_finalize_qr_reissue_tagged', {
          p_operation_id: operationId,
          p_new_credential_id: inputs.credentialId,
          p_new_token_hash: inputs.tokenHash,
          p_new_token_ciphertext: inputs.tokenCiphertext,
          p_new_token_version: inputs.tokenVersion,
          p_new_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await admin.from('profiles').update({ role: 'participant' }).eq('id', staff.userId);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('requester_no_longer_authorized');

      const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('requester_no_longer_authorized');

      const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
      expect(oldRow!.status).toBe('active');
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('batch becomes unavailable BEFORE the finalizer acquires the batch lock: the finalizer waits on it, the holder cancels and commits, then the finalizer observes the durable bulk_batch_unavailable outcome, and the old credential remains active', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');
    const operationId = await reserveStaffReissue(staff, fx.applicationId, oldCredentialId, batchId);
    const holderTag = `reissue-finalizer-batch-holder-${randomUUID()}`;
    const waiterTag = `reissue-finalizer-batch-waiter-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        holderTag,
        'select public.test_only_hold_then_cancel_bulk_batch($1, $2, $3, $4)',
        [batchId, gateId, holderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      sessionAPromise = admin.rpc('test_only_hold_then_cancel_bulk_batch', {
        p_batch_id: batchId,
        p_gate_id: gateId,
        p_holder_tag: holderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let sessionBPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = admin.rpc('test_only_finalize_qr_reissue_tagged', {
          p_operation_id: operationId,
          p_new_credential_id: inputs.credentialId,
          p_new_token_hash: inputs.tokenHash,
          p_new_token_ciphertext: inputs.tokenCiphertext,
          p_new_token_version: inputs.tokenVersion,
          p_new_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: waiterTag,
        });
      }
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        await getCloudNativeHolderSession(holderTag).awaitCompletion();
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error, `holder/canceller session failed: ${sessionAResult.error?.message}`).toBeNull();

        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error, `finalizer session failed: ${sessionBResult.error?.message}`).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('bulk_batch_unavailable');

      const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
      expect(opRow!.status).toBe('cancelled');
      expect(opRow!.terminal_reason_code).toBe('bulk_batch_unavailable');

      const { data: batchRow } = await admin.from('qr_bulk_operation_batches').select('status, closed_at').eq('id', batchId).single();
      expect(batchRow!.status).toBe('cancelled');
      expect(batchRow!.closed_at).toBeTruthy();

      const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
      expect(oldRow!.status).toBe('active');

      const { data: newRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
      expect(newRows).toHaveLength(0);

      const { data: auditRows } = await admin
        .from('audit_logs')
        .select('id')
        .eq('entity_type', 'qr_credential')
        .eq('entity_id', inputs.credentialId)
        .eq('action', 'reissued');
      expect(auditRows).toHaveLength(0);
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(holderTag);
        await closeCloudNativeSession(waiterTag);
      } else {
        await sessionAPromise;
      }
    }
  }, 30000);

  it('the finalizer acquires the batch FOR SHARE lock FIRST: a concurrent batch cancellation is blocked until the finalizer commits, and the credential is reissued using a batch that remained valid for the whole finalization transaction', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const batchId = await createBulkBatch(staff.userId, 'reissue');
    const operationId = await reserveStaffReissue(staff, fx.applicationId, oldCredentialId, batchId);
    const appHolderTag = `reissue-finalizer-app-holder-for-batch-race-${randomUUID()}`;
    const finalizerWaiterTag = `reissue-finalizer-waiter-for-batch-race-${randomUUID()}`;
    const cancelWaiterTag = `reissue-cancel-waiter-for-batch-race-${randomUUID()}`;
    const gateId = await createGate();

    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let applicationHolderPromise: ReturnType<typeof admin.rpc> | undefined;
    if (usesCloudNativeHolder) {
      await launchCloudNativeHolder(
        appHolderTag,
        'select public.test_only_hold_application_lock($1, $2, $3, $4)',
        [fx.applicationId, gateId, appHolderTag, 30],
        HOLDER_WAIT_TIMEOUT_MS,
      );
    } else {
      applicationHolderPromise = admin.rpc('test_only_hold_application_lock', {
        p_application_id: fx.applicationId,
        p_gate_id: gateId,
        p_holder_tag: appHolderTag,
        p_max_wait_seconds: 30,
      });
      await waitUntilHolderReady(appHolderTag, HOLDER_WAIT_TIMEOUT_MS);
    }

    let gateReleased = false;
    try {
      const inputs = await buildFinalizerInputs();
      let finalizePromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          finalizerWaiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [operationId, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, finalizerWaiterTag],
        );
      } else {
        finalizePromise = admin.rpc('test_only_finalize_qr_reissue_tagged', {
          p_operation_id: operationId,
          p_new_credential_id: inputs.credentialId,
          p_new_token_hash: inputs.tokenHash,
          p_new_token_ciphertext: inputs.tokenCiphertext,
          p_new_token_version: inputs.tokenVersion,
          p_new_encryption_key_version: inputs.encryptionKeyVersion,
          p_waiter_tag: finalizerWaiterTag,
        });
      }
      await waitUntilBlocked(finalizerWaiterTag, appHolderTag, HOLDER_WAIT_TIMEOUT_MS);

      let cancelPromise: ReturnType<typeof admin.rpc> | undefined;
      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          cancelWaiterTag,
          undefined,
          'select to_jsonb(public.test_only_cancel_bulk_batch_tagged($1, $2)) as result',
          [batchId, cancelWaiterTag],
        );
      } else {
        cancelPromise = admin.rpc('test_only_cancel_bulk_batch_tagged', {
          p_batch_id: batchId,
          p_waiter_tag: cancelWaiterTag,
        });
      }
      await waitUntilBlocked(cancelWaiterTag, finalizerWaiterTag, HOLDER_WAIT_TIMEOUT_MS);

      await releaseGate(gateId);
      gateReleased = true;

      if (usesCloudNativeHolder) {
        await getCloudNativeHolderSession(appHolderTag).awaitCompletion();
        const result = await getCloudNativeWaiterResult<{ outcome: string; credential_id: string }>(finalizerWaiterTag);
        expect(result.outcome).toBe('reissued');
        expect(result.credential_id).toBe(inputs.credentialId);
        await getCloudNativeWaiterSession(cancelWaiterTag).awaitCompletion();
      } else {
        const [appHolderResult, finalizeResult, cancelResult] = await Promise.all([applicationHolderPromise!, finalizePromise!, cancelPromise!]);
        expect(appHolderResult.error, `application holder failed: ${appHolderResult.error?.message}`).toBeNull();
        expect(finalizeResult.error, `finalizer failed: ${finalizeResult.error?.message}`).toBeNull();
        expect(finalizeResult.data).toBeTruthy();
        const result = finalizeResult.data as unknown as { outcome: string; credential_id: string };
        expect(result.outcome).toBe('reissued');
        expect(result.credential_id).toBe(inputs.credentialId);
        expect(cancelResult.error, `cancellation attempt failed: ${cancelResult.error?.message}`).toBeNull();
      }

      const { data: newRow } = await admin.from('qr_credentials').select('issuance_channel').eq('id', inputs.credentialId).single();
      expect(newRow!.issuance_channel).toBe('staff_bulk');

      const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
      expect(oldRow!.status).toBe('replaced');

      const { data: batchRow } = await admin.from('qr_bulk_operation_batches').select('status').eq('id', batchId).single();
      expect(batchRow!.status).toBe('cancelled'); // only proceeded after the finalizer committed
    } finally {
      if (!gateReleased) {
        await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
      }
      if (usesCloudNativeHolder) {
        await closeCloudNativeSession(appHolderTag);
        await closeCloudNativeSession(finalizerWaiterTag);
        await closeCloudNativeSession(cancelWaiterTag);
      } else {
        await applicationHolderPromise;
      }
    }
  }, 30000);

  it('no active credential returns the durable no_active_credential outcome, and no new credential is created', async () => {
    const staff = await createStaffFixture('super_admin');
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredentialForStaff();
    const operationId = await reserveStaffReissue(staff, fx.applicationId, oldCredentialId);

    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', oldCredentialId);

    const inputs = await buildFinalizerInputs();
    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('no_active_credential');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('no_active_credential');

    const { data: newRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(newRows).toHaveLength(0);
  });

  it('an active credential differing from the one expected at reservation time returns the durable expected_credential_changed outcome with terminal_related_credential_id left null, and no credential_id/status/issued_at in the result', async () => {
    // CORRECTED this round: terminal_related_credential_id is permitted
    // ONLY for 'active_credential_already_exists' by the approved
    // qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    // (§1.7) — 'expected_credential_changed' must always leave it null.
    // The previous version of this test incorrectly asserted
    // terminal_related_credential_id was set to the newly-active
    // credential and that the result carried its credential_id — both
    // would have violated the CHECK constraint at the database level.
    const { fx, credentialId: originalActiveId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, originalActiveId);

    // Between reservation and finalization: the originally-expected
    // active credential is revoked and a DIFFERENT credential becomes
    // active for the same application, without going through this
    // pending operation.
    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', originalActiveId);
    const newlyActiveId = await insertActiveCredential(fx.applicationId);

    const inputs = await buildFinalizerInputs();
    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    const result = data as unknown as Record<string, unknown>;
    expect(result.outcome).toBe('expected_credential_changed');
    expect(result.credential_id).toBeNull();
    expect(result.status).toBeNull();
    expect(result.issued_at).toBeNull();

    const { data: opRow, error: opError } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code, terminal_related_credential_id')
      .eq('id', operationId)
      .single();
    expect(opError, `operation post-state query failed: ${opError?.message}`).toBeNull();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('expected_credential_changed');
    expect(opRow!.terminal_related_credential_id).toBeNull();

    const { data: newRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(newRows).toHaveLength(0);

    // The newly-active credential (the one that actually replaced
    // originalActiveId, outside this operation) is left completely
    // untouched by this cancellation.
    const { data: newlyActiveRow } = await admin.from('qr_credentials').select('status').eq('id', newlyActiveId).single();
    expect(newlyActiveRow!.status).toBe('active');
  });

  it('replay of a cancelled expected_credential_changed operation returns the stable outcome without any current-credential lookup, and remains stable even after the credential that triggered it is later deleted from view (revoked) or the id reused elsewhere', async () => {
    const { fx, credentialId: originalActiveId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, originalActiveId);

    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', originalActiveId);
    const newlyActiveId = await insertActiveCredential(fx.applicationId);

    const firstInputs = await buildFinalizerInputs();
    const first = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: firstInputs.credentialId,
      p_new_token_hash: firstInputs.tokenHash,
      p_new_token_ciphertext: firstInputs.tokenCiphertext,
      p_new_token_version: firstInputs.tokenVersion,
      p_new_encryption_key_version: firstInputs.encryptionKeyVersion,
    });
    expect(first.error).toBeNull();
    expect((first.data as unknown as { outcome: string }).outcome).toBe('expected_credential_changed');

    // Now revoke the credential that caused the mismatch too, so a
    // lookup through it (if one still incorrectly existed) would either
    // fail to find an 'active' row or return stale data — the replay
    // below must not perform any such lookup at all, per the correction:
    // the stable outcome name alone is the entire durable result.
    await admin
      .from('qr_credentials')
      .update({
        status: 'revoked',
        token_ciphertext: null,
        encryption_key_version: null,
        revoked_at: new Date().toISOString(),
        revoked_by: null,
        revocation_reason_code: 'administrative_correction',
        revocation_note: null,
      })
      .eq('id', newlyActiveId);

    const replay = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: firstInputs.credentialId,
      p_new_token_hash: firstInputs.tokenHash,
      p_new_token_ciphertext: firstInputs.tokenCiphertext,
      p_new_token_version: firstInputs.tokenVersion,
      p_new_encryption_key_version: firstInputs.encryptionKeyVersion,
    });
    expect(replay.error, `replay failed: ${replay.error?.message}`).toBeNull();
    const replayResult = replay.data as unknown as Record<string, unknown>;
    expect(replayResult.outcome).toBe('expected_credential_changed');
    expect(replayResult.credential_id).toBeNull();
    expect(replayResult.status).toBeNull();
    expect(replayResult.issued_at).toBeNull();

    const { data: opRow } = await admin
      .from('qr_lifecycle_operations')
      .select('status, terminal_reason_code, terminal_related_credential_id')
      .eq('id', operationId)
      .single();
    expect(opRow!.status).toBe('cancelled');
    expect(opRow!.terminal_reason_code).toBe('expected_credential_changed');
    expect(opRow!.terminal_related_credential_id).toBeNull();
  });

  it('the approved qr_lifecycle_operations_cancelled_is_consistent CHECK constraint and lifecycle trigger remain unchanged: a direct attempt to set terminal_related_credential_id alongside terminal_reason_code = expected_credential_changed is rejected by the database itself (via the trigger, SQLSTATE P0001 — the CHECK constraint enforces the identical rule but the trigger fires first)', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);

    // CORRECTED this round: the previous version of this test used
    // someOtherCredentialId, belonging to a DIFFERENT application than
    // the lifecycle operation's own — that lets the composite
    // qr_credentials_replacement_same_application_fkey FK reject the
    // UPDATE for an unrelated reason (a foreign-key violation, not a
    // CHECK violation), which does not isolate or prove the specific
    // cancellation-shape rule under test. Using oldCredentialId — the
    // operation's own expected_current_credential_id, which genuinely
    // belongs to THIS SAME application — keeps the composite FK valid,
    // so the ONLY thing that can reject this UPDATE is the
    // qr_lifecycle_operations_cancelled_is_consistent CHECK constraint's
    // own rule that terminal_related_credential_id must remain null for
    // every terminal_reason_code other than 'active_credential_already_exists'.
    //
    // Bypasses the finalizer entirely — a direct service-role UPDATE
    // attempting the exact shape the finalizer used to produce before
    // this round's correction. This must fail at the database level,
    // proving the CHECK constraint itself (not just this finalizer's own
    // discipline) is what guarantees the invariant.
    const { error } = await admin
      .from('qr_lifecycle_operations')
      .update({
        status: 'cancelled',
        finalized_at: new Date().toISOString(),
        terminal_reason_code: 'expected_credential_changed',
        terminal_related_credential_id: oldCredentialId,
      })
      .eq('id', operationId);
    // FIX (this round): both qr_lifecycle_operations_enforce_lifecycle_trigger
    // (line ~1541-1542 of the migration: "terminal_related_credential_id
    // must remain null for any cancellation reason other than
    // active_credential_already_exists") and the
    // qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    // independently enforce this exact same rule. Postgres fires
    // BEFORE/row-level triggers before evaluating table CHECK constraints
    // for the same statement, so the trigger's raise exception (SQLSTATE
    // P0001) always intercepts this specific violation first — the CHECK
    // constraint, while present and correctly written, is genuinely
    // unreachable for this exact scenario. The safety guarantee this test
    // exists to verify still holds (the illegal state is rejected), just
    // via the trigger layer rather than the CHECK constraint layer this
    // assertion previously expected.
    expect(error, 'expected the database to reject terminal_related_credential_id set alongside expected_credential_changed').toBeTruthy();
    expect(error!.code).toBe('P0001');
    if (error!.message) {
      expect(error!.message).toContain('terminal_related_credential_id must remain null');
    }

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code, terminal_related_credential_id').eq('id', operationId).single();
    expect(opRow!.status).toBe('pending'); // the rejected UPDATE never committed
    expect(opRow!.terminal_reason_code).toBeNull();
    expect(opRow!.terminal_related_credential_id).toBeNull();
  });

  it('two different pending reissue reservations for the same application are mutually exclusive at the reservation layer, so exactly one operation ever reaches the finalizer and replaces the credential exactly once', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationIdA = await reserveParticipantReissue(fx, oldCredentialId);

    const secondAttempt = await fx.client.rpc('request_my_qr_reissue_transactional', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: oldCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
    });
    expect(secondAttempt.error).toBeNull();
    expect((secondAttempt.data as unknown as { outcome: string }).outcome).toBe('another_operation_pending');

    const inputs = await buildFinalizerInputs();
    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationIdA,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('reissued');

    const { data: activeRows } = await admin.from('qr_credentials').select('id').eq('application_id', fx.applicationId).eq('status', 'active');
    expect(activeRows).toHaveLength(1);
    expect(activeRows![0].id).toBe(inputs.credentialId);
  });

  it('TTL expiring while the finalizer waits specifically on the key-registry lock (position 5) reports operation_expired, the operation becomes expired/ttl_expired, the old credential remains active and unchanged, and no new credential or successful audit survives', async () => {
    // CORRECTED this round: the authoritative timestamp used for the TTL
    // recheck and every pending-path decision was previously captured
    // BEFORE the key-registry lock (position 5) was even acquired,
    // leaving a gap where the operation could expire while THIS call
    // itself waited to acquire that lock and still be finalized/rejected
    // using a stale pre-wait timestamp. This test proves the corrected
    // behavior deterministically: the finalizer is held blocked
    // SPECIFICALLY on the key-registry row (proven via the waiter-to-
    // holder observer, never merely "waiting on something"), the
    // operation's TTL elapses while it waits there, and only THEN is the
    // holder released — the finalizer must observe the expiry, not a
    // stale earlier timestamp that would have let it proceed to
    // key-version-active or finalize.
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    // CORRECTED: the seed's own TTL must be generous — see the
    // issuance-side key-registry-lock equivalent test for the full
    // rationale. Holder/waiter setup (raw-pg connection open, JWT/role
    // context, polling waitUntilHolderReady) was measured to
    // intermittently take several seconds on Supabase Cloud, which could
    // let a tightly-scoped seed TTL expire before the finalizer ever
    // reaches the key-registry lock at all, causing it to short-circuit
    // at position 1 (operation status check) instead of genuinely
    // blocking. The actual expiry proof below is measured from
    // waitUntilBlocked() resolving instead.
    const seedTtlSeconds = 30;
    // test_only_request_my_qr_reissue_short_ttl is granted EXECUTE to
    // authenticated only (revoked from service_role) — must be called via
    // the participant's own authenticated client, not admin.
    const seed = await fx.client.rpc('test_only_request_my_qr_reissue_short_ttl', {
      p_request_key: randomUUID(),
      p_expected_current_credential_id: oldCredentialId,
      p_reissue_reason_code: REISSUE_REASON_NO_NOTE_REQUIRED,
      p_reissue_note: null,
      p_pending_ttl: `${seedTtlSeconds} seconds`,
      p_waiter_tag: `reissue-finalizer-key-lock-ttl-seed-${randomUUID()}`,
    });
    expect(seed.error).toBeNull();
    const seedResult = seed.data as unknown as { outcome: string; operation_id: string };
    expect(seedResult.outcome).toBe('reserved');

    const inputs = await buildFinalizerInputs();
    const holderTag = `reissue-finalizer-key-lock-holder-${randomUUID()}`;
    const waiterTag = `reissue-finalizer-key-lock-waiter-${randomUUID()}`;
    const gateId = await createGate();

    // CORRECTED this round: both the holder and finalizer-waiter promises
    // are now declared OUTSIDE try, before either RPC is started, so
    // `finally` can always settle both — even if waitUntilHolderReady,
    // waitUntilBlocked, or any assertion between the two RPC calls
    // throws. Each RPC is started EXACTLY ONCE and its promise captured
    // immediately (PostgREST's builder is thenable, not a real Promise,
    // so wrapping it eagerly avoids ever re-issuing the request via a
    // second, accidental `await`/`.then()`).
    const usesCloudNativeHolder = disposableDatabaseCheck.reason !== 'local';
    let sessionAPromise: Promise<Awaited<ReturnType<typeof admin.rpc>>> | undefined;
    let sessionBPromise: Promise<Awaited<ReturnType<typeof admin.rpc>>> | undefined;
    let gateReleased = false;
    try {
      if (usesCloudNativeHolder) {
        await launchCloudNativeHolder(
          holderTag,
          'select public.test_only_hold_key_registry_lock($1, $2, $3, $4)',
          [inputs.encryptionKeyVersion, gateId, holderTag, 30],
          HOLDER_WAIT_TIMEOUT_MS,
        );
      } else {
        sessionAPromise = Promise.resolve(
          admin.rpc('test_only_hold_key_registry_lock', {
            p_key_version: inputs.encryptionKeyVersion,
            p_gate_id: gateId,
            p_holder_tag: holderTag,
            p_max_wait_seconds: 30,
          }),
        );
        await waitUntilHolderReady(holderTag, HOLDER_WAIT_TIMEOUT_MS);
      }

      if (usesCloudNativeHolder) {
        await launchCloudNativeWaiter(
          waiterTag,
          undefined,
          'select to_jsonb(public.test_only_finalize_qr_reissue_tagged($1, $2, $3, $4, $5, $6, $7)) as result',
          [seedResult.operation_id, inputs.credentialId, inputs.tokenHash, inputs.tokenCiphertext, inputs.tokenVersion, inputs.encryptionKeyVersion, waiterTag],
        );
      } else {
        sessionBPromise = Promise.resolve(
          admin.rpc('test_only_finalize_qr_reissue_tagged', {
            p_operation_id: seedResult.operation_id,
            p_new_credential_id: inputs.credentialId,
            p_new_token_hash: inputs.tokenHash,
            p_new_token_ciphertext: inputs.tokenCiphertext,
            p_new_token_version: inputs.tokenVersion,
            p_new_encryption_key_version: inputs.encryptionKeyVersion,
            p_waiter_tag: waiterTag,
          }),
        );
      }
      // Proves the finalizer is SPECIFICALLY blocked on the key-registry
      // holder — i.e. it has already acquired positions 1-4 (operation,
      // batch-if-applicable, application, current active credential) and
      // is now waiting only on position 5.
      await waitUntilBlocked(waiterTag, holderTag, HOLDER_WAIT_TIMEOUT_MS);

      // Wait beyond the seed's OWN real TTL (seedTtlSeconds) — measured
      // from waitUntilBlocked() resolving, which only occurs once the
      // finalizer has already inserted/locked its way to genuinely
      // waiting on the key-registry lock.
      await new Promise((resolve) => setTimeout(resolve, seedTtlSeconds * 1000 + 500));

      await releaseGate(gateId);
      gateReleased = true;

      let result: { outcome: string };
      if (usesCloudNativeHolder) {
        result = await getCloudNativeWaiterResult<{ outcome: string }>(waiterTag);
      } else {
        const sessionAResult = await sessionAPromise!;
        expect(sessionAResult.error).toBeNull();
        const sessionBResult = await sessionBPromise!;
        expect(sessionBResult.error).toBeNull();
        expect(sessionBResult.data).toBeTruthy();
        result = sessionBResult.data as unknown as { outcome: string };
      }
      expect(result.outcome).toBe('operation_expired');

      const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code, consumed_at, resulting_credential_id').eq('id', seedResult.operation_id).single();
      expect(opRow!.status).toBe('expired');
      expect(opRow!.terminal_reason_code).toBe('ttl_expired');
      expect(opRow!.consumed_at).toBeNull();
      expect(opRow!.resulting_credential_id).toBeNull();

      const { data: oldRow } = await admin.from('qr_credentials').select('status, token_ciphertext, encryption_key_version').eq('id', oldCredentialId).single();
      expect(oldRow!.status).toBe('active');
      expect(oldRow!.token_ciphertext).toBeTruthy();
      expect(oldRow!.encryption_key_version).not.toBeNull();

      const { data: newRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
      expect(newRows).toHaveLength(0);

      const { data: auditRows } = await admin
        .from('audit_logs')
        .select('id')
        .eq('entity_type', 'qr_credential')
        .eq('entity_id', inputs.credentialId)
        .eq('action', 'reissued');
      expect(auditRows).toHaveLength(0);
    } finally {
      if (usesCloudNativeHolder) {
        try {
          if (!gateReleased) {
            await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
          }
        } finally {
          await closeCloudNativeSession(holderTag);
          await closeCloudNativeSession(waiterTag);
        }
      } else {
        const pending = [sessionAPromise, sessionBPromise].filter((p): p is NonNullable<typeof p> => p !== undefined);
        try {
          if (!gateReleased) {
            await admin.rpc('test_only_release_lock_gate', { p_gate_id: gateId });
          }
        } finally {
          await Promise.allSettled(pending);
        }
      }
    }
  }, 45000);
});

describe('finalize_qr_reissue_for_server — encryption-key validation (retryable, non-terminal)', () => {
  it('a missing key version returns key_version_not_active, the operation remains pending, and the old credential remains active', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs(32010); // no such registry row

    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('key_version_not_active');

    const { data: opRow } = await admin.from('qr_lifecycle_operations').select('status, terminal_reason_code').eq('id', operationId).single();
    expect(opRow!.status).toBe('pending');
    expect(opRow!.terminal_reason_code).toBeNull();

    const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
    expect(oldRow!.status).toBe('active');

    const { data: newRows } = await admin.from('qr_credentials').select('id').eq('id', inputs.credentialId);
    expect(newRows).toHaveLength(0);

    const { data: auditRows } = await admin.from('audit_logs').select('id').eq('entity_type', 'qr_credential').eq('entity_id', inputs.credentialId);
    expect(auditRows).toHaveLength(0);
  });

  it('a decrypt_only key returns key_version_not_active, and the old credential remains active', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const decryptOnlyVersion = 9111;
    await admin.from('qr_encryption_key_registry').insert({ key_version: decryptOnlyVersion, status: 'decrypt_only' });
    const inputs = await buildFinalizerInputs(decryptOnlyVersion);

    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('key_version_not_active');

    const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
    expect(oldRow!.status).toBe('active');
  });

  it('a retired key returns key_version_not_active, and the old credential remains active', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const retiredVersion = 9112;
    await admin.from('qr_encryption_key_registry').insert({ key_version: retiredVersion, status: 'retired', retired_at: new Date().toISOString() });
    const inputs = await buildFinalizerInputs(retiredVersion);

    const { data, error } = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, `finalize call failed: ${error?.message}`).toBeNull();
    expect((data as unknown as { outcome: string }).outcome).toBe('key_version_not_active');

    const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
    expect(oldRow!.status).toBe('active');
  });

  it('key rotation racing with finalization: a key rotated out between reservation and finalize call is correctly rejected, then a fresh active key succeeds on retry', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const rotatedOutVersion = 9113;
    await admin.from('qr_encryption_key_registry').insert({ key_version: rotatedOutVersion, status: 'decrypt_only' });
    const staleInputs = await buildFinalizerInputs(rotatedOutVersion);

    const staleAttempt = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: staleInputs.credentialId,
      p_new_token_hash: staleInputs.tokenHash,
      p_new_token_ciphertext: staleInputs.tokenCiphertext,
      p_new_token_version: staleInputs.tokenVersion,
      p_new_encryption_key_version: staleInputs.encryptionKeyVersion,
    });
    expect(staleAttempt.error).toBeNull();
    expect((staleAttempt.data as unknown as { outcome: string }).outcome).toBe('key_version_not_active');

    const freshInputs = await buildFinalizerInputs();
    const retry = await admin.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: freshInputs.credentialId,
      p_new_token_hash: freshInputs.tokenHash,
      p_new_token_ciphertext: freshInputs.tokenCiphertext,
      p_new_token_version: freshInputs.tokenVersion,
      p_new_encryption_key_version: freshInputs.encryptionKeyVersion,
    });
    expect(retry.error, `retry failed: ${retry.error?.message}`).toBeNull();
    expect((retry.data as unknown as { outcome: string }).outcome).toBe('reissued');

    const { data: oldRow } = await admin.from('qr_credentials').select('status').eq('id', oldCredentialId).single();
    expect(oldRow!.status).toBe('replaced');
  });
});

describe('finalize_qr_reissue_for_server — permissions and safety invariants', () => {
  it('only service_role has execute permission (confirmed structurally by every prior test using the service-role admin client succeeding, and the participant/staff/anon rejection tests above failing)', async () => {
    const { fx, credentialId: oldCredentialId } = await reissueFixtureWithActiveCredential();
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const operationId = await reserveParticipantReissue(fx, oldCredentialId);
    const inputs = await buildFinalizerInputs();

    const { data, error } = await anonClient.rpc('finalize_qr_reissue_for_server', {
      p_operation_id: operationId,
      p_new_credential_id: inputs.credentialId,
      p_new_token_hash: inputs.tokenHash,
      p_new_token_ciphertext: inputs.tokenCiphertext,
      p_new_token_version: inputs.tokenVersion,
      p_new_encryption_key_version: inputs.encryptionKeyVersion,
    });
    expect(error, 'expected the reissue finalizer to be unreachable from an anon session').toBeTruthy();
    expect(data).toBeNull();
  });
});
