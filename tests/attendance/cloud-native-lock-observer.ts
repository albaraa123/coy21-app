// tests/attendance/cloud-native-lock-observer.ts
//
// Cloud-native replacement for the pg_stat_activity.application_name
// tagging observer used by qr-issuance-reservation.test.ts's concurrency
// tests. Two facts, both confirmed by direct testing against
// rcoy-phase6-test/lhzvuywqpjylxreglgnr, drove this design:
//
//   1. Supabase Cloud routes every admin.rpc()/client.rpc() call through
//      PostgREST, whose own connection-pool backends never appear in
//      pg_stat_activity queried from a separate direct connection, at
//      any timeout length — the specific limitation that made the
//      original application_name design unusable on Cloud.
//
//   2. A PostgREST-originated backend's row-lock WAIT state IS visible
//      in pg_locks (granted = false) from a separate connection — but
//      relying on that alone was measured to be unreliable in practice
//      (the PostgREST-originated waiter's own connection setup/routing
//      time is itself variable enough that a purely-observational
//      approach sometimes never caught it inside a bounded window,
//      producing real, reproducible — not merely rare — timeouts).
//
// The design used here instead runs BOTH the holder and the waiter over
// dedicated raw PostgreSQL connections (via the `pg` package, bypassing
// PostgREST for transport only):
//
//   - The HOLDER invokes the SAME EXISTING test-only SQL holder function
//     directly as a plain SQL call — its lock-acquisition/gate-polling
//     logic is completely unchanged, just reached over a different
//     transport. pg_backend_pid() is known immediately, and pg_locks
//     correctly shows its row lock as {locktype: 'transactionid', mode:
//     'ExclusiveLock'} (the real Postgres representation of a FOR
//     UPDATE/FOR SHARE row lock — confirmed by direct observation) for
//     the entire duration it holds the lock.
//
//   - The WAITER invokes the SAME EXISTING PRODUCTION RPC function
//     PostgREST would normally call — never a reimplementation of its
//     logic — over ITS OWN dedicated raw connection, with the identical
//     request context PostgREST itself would set: `role` and
//     `request.jwt.claims` populated from the REAL JWT
//     signInWithPassword() already issued for that session (decoded,
//     never fabricated), via the same set_config()/SET LOCAL mechanism
//     PostgREST uses. auth.uid() and every RLS/authorization check the
//     production function performs behaves EXACTLY as it would under
//     PostgREST, because it IS the same underlying mechanism — confirmed
//     by direct testing that auth.uid() resolves to the correct user id
//     under this reproduced context.
//
// Both connections are fully under this module's control, so
// pg_blocking_pids() proves the genuine Postgres-level blocking
// relationship deterministically — no polling race, no dependency on
// PostgREST's own connection-pool timing.
//
// Requires PHASE6_TEST_DATABASE_URL — a direct/Supavisor-session-mode
// PostgreSQL connection string for the SAME disposable project
// NEXT_PUBLIC_SUPABASE_URL points at. Read from environment only; never
// logged, never embedded in an error message.
import pg from 'pg';

let observerClient: pg.Client | null = null;
let observerClientConnecting: Promise<pg.Client> | null = null;

function requireConnectionString(): string {
  const connectionString = process.env.PHASE6_TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'cloud-native-lock-observer: PHASE6_TEST_DATABASE_URL is not set. ' +
        'A direct PostgreSQL connection string (Supavisor session mode or direct connection) ' +
        'to the disposable Supabase Cloud project is required for cloud-native concurrency testing.',
    );
  }
  return connectionString;
}

// The observer connection is long-lived (shared across the whole suite),
// so it can be dropped mid-run by the pooler/network independently of any
// individual test (confirmed: a bare "Connection terminated unexpectedly"
// surfaced as an unhandled exception well into a real run, with no test
// code involved). Without an error listener, the dead pg.Client stayed
// cached forever — every later getObserverClient() call kept returning
// the same unusable connection, hanging every subsequent test for the
// rest of the suite. The 'error' handler below clears the cache on any
// connection-level failure so the next getObserverClient() call
// transparently reconnects instead of reusing a dead client.
async function getObserverClient(): Promise<pg.Client> {
  if (observerClient) return observerClient;
  if (observerClientConnecting) return observerClientConnecting;
  observerClientConnecting = (async () => {
    const client = new pg.Client({ connectionString: requireConnectionString() });
    client.on('error', () => {
      if (observerClient === client) {
        observerClient = null;
        observerClientConnecting = null;
      }
    });
    await client.connect();
    observerClient = client;
    return client;
  })();
  return observerClientConnecting;
}

export async function closeDirectClient(): Promise<void> {
  if (observerClient) {
    await observerClient.end();
    observerClient = null;
    observerClientConnecting = null;
  }
}

// Decodes a Supabase access token's payload WITHOUT verifying its
// signature — safe here because the token is one this same test process
// just received directly from a real signInWithPassword() call against
// this exact disposable project; it is never accepted from any external
// or untrusted source.
function decodeJwtPayload(accessToken: string): string {
  const payloadB64Url = accessToken.split('.')[1];
  if (!payloadB64Url) throw new Error('decodeJwtPayload: malformed access token (no payload segment).');
  return Buffer.from(payloadB64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// A holder session: a dedicated raw PostgreSQL connection that invokes
// one of the existing test-only holder SQL functions directly (bypassing
// PostgREST) and keeps the connection open for the duration of that
// call. The holder function itself polls test_only_lock_gates and
// returns once released — identical behavior to the original
// admin.rpc()-based invocation, just reached over a different transport.
export class CloudNativeHolderSession {
  private client: pg.Client;
  private queryPromise: Promise<unknown> | null = null;
  public readonly pid: number;

  private constructor(client: pg.Client, pid: number) {
    this.client = client;
    this.pid = pid;
  }

  static async open(): Promise<CloudNativeHolderSession> {
    const client = new pg.Client({ connectionString: requireConnectionString() });
    // Without a listener, an unexpected disconnect (pooler/network drop)
    // emits an unhandled 'error' that crashes the whole Node process
    // rather than just failing this session's own in-flight query/close()
    // — confirmed by a real "Connection terminated unexpectedly" uncaught
    // exception mid-suite. The query/awaitCompletion() promise already
    // rejects on its own from the same failure; this listener only
    // prevents the redundant process-level crash.
    client.on('error', () => undefined);
    await client.connect();
    const res = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    return new CloudNativeHolderSession(client, res.rows[0].pid);
  }

  // Fires the holder function call but does NOT await it — the function
  // blocks (polling its gate) until released, exactly like the original
  // admin.rpc() call did. Call awaitCompletion() after releasing the gate.
  startHolderFunction(sql: string, params: unknown[]): void {
    this.queryPromise = this.client.query(sql, params);
  }

  async awaitCompletion(): Promise<void> {
    if (!this.queryPromise) throw new Error('CloudNativeHolderSession: startHolderFunction was never called');
    await this.queryPromise;
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

// A waiter session: a dedicated raw PostgreSQL connection that
// reproduces the exact request context PostgREST would set for an
// authenticated call (role + request.jwt.claims, from a REAL JWT this
// test already obtained via signInWithPassword()), then invokes the SAME
// EXISTING PRODUCTION RPC function PostgREST would normally call —
// never a reimplementation of its logic. auth.uid() and every RLS/
// authorization check inside that function behave identically to a real
// PostgREST-routed call, because they use the same underlying mechanism.
export class CloudNativeAuthenticatedSession {
  private client: pg.Client;
  private queryPromise: Promise<unknown> | null = null;
  public readonly pid: number;

  private constructor(client: pg.Client, pid: number) {
    this.client = client;
    this.pid = pid;
  }

  // accessToken: the real access_token from this test's own
  // signInWithPassword() call (participant or staff — this class does
  // not care which; it only reproduces whatever session PostgREST would
  // have received). When omitted, the session instead does `set role
  // service_role` — used for test-only wrapper functions that are
  // security definer and granted execute ONLY to service_role (e.g. the
  // finalizer wrappers), matching what admin.rpc() would have run as,
  // without relying on the raw connection's superuser privileges to
  // silently bypass that grant check.
  static async open(accessToken?: string): Promise<CloudNativeAuthenticatedSession> {
    const client = new pg.Client({ connectionString: requireConnectionString() });
    // See CloudNativeHolderSession.open()'s identical listener: without
    // it, an unexpected disconnect crashes the whole Node process instead
    // of just failing this session's own query/close().
    client.on('error', () => undefined);
    await client.connect();
    const res = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    if (accessToken) {
      const payloadJson = decodeJwtPayload(accessToken);
      await client.query(`select set_config('request.jwt.claims', $1, false)`, [payloadJson]);
      await client.query('set role authenticated');
    } else {
      await client.query('set role service_role');
    }
    return new CloudNativeAuthenticatedSession(client, res.rows[0].pid);
  }

  public lastStartError: unknown = undefined;

  // Runs a query to completion on THIS session's own connection, before
  // startRpcFunction() — used by TTL-margin tests that need the
  // database server's own clock_timestamp() captured on the SAME
  // connection immediately before the RPC statement that will insert a
  // row using that same server's clock, with no cross-connection gap
  // (raw connection setup time — TCP handshake, JWT claim/role context —
  // was measured to add over a second, making a clock reading taken
  // before this session even opened too early relative to the row's
  // real created_at).
  async queryBeforeStart<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    return this.client.query(sql, params);
  }

  // Fires the production RPC function call but does NOT await it — used
  // when the call is expected to block on a lock the test's holder
  // session still has. Call awaitCompletion() to get its result.
  startRpcFunction(sql: string, params: unknown[]): void {
    this.queryPromise = this.client.query(sql, params);
    this.queryPromise.catch((err) => {
      this.lastStartError = err;
    });
  }

  async awaitCompletion<T extends pg.QueryResultRow = Record<string, unknown>>(): Promise<pg.QueryResult<T>> {
    if (!this.queryPromise) throw new Error('CloudNativeAuthenticatedSession: startRpcFunction was never called');
    return this.queryPromise as Promise<pg.QueryResult<T>>;
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

// Cloud-native equivalent of the old waitUntilHolderReady(): true once
// the holder's PID genuinely holds a row-level lock (locktype =
// 'transactionid', the real Postgres representation of a FOR UPDATE/FOR
// SHARE row lock — confirmed by direct observation against this exact
// disposable project, not assumed).
export async function waitUntilHolderReadyCloudNative(holderPid: number, timeoutMs: number): Promise<void> {
  const client = await getObserverClient();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.query<{ locktype: string; granted: boolean }>(
      `select locktype, granted from pg_locks where pid = $1 and locktype = 'transactionid' and granted = true`,
      [holderPid],
    );
    if (res.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntilHolderReadyCloudNative: timed out after ${timeoutMs}ms — holder pid ${holderPid} never acquired its row lock.`);
}

// Waits until the given PID genuinely holds a specific pg_advisory_xact_lock
// — observable directly in pg_locks as {locktype: 'advisory', granted:
// true}, confirmed by direct testing against this exact disposable project.
// Used to establish genuine happens-before ordering between two REAL
// production RPC calls that both take the SAME advisory lock (e.g. the
// reservation-domain lock at position 2 of
// reserve_or_reuse_qr_lifecycle_operation), without relying on Promise.all
// dispatch-timing races: caller A is launched, this function confirms A
// has genuinely entered its locked critical section, THEN caller B is
// launched — B is thus guaranteed to either wait behind A or find A's
// result already committed, never an ambiguous true-simultaneity race.
export async function waitUntilAdvisoryLockHeldCloudNative(pid: number, timeoutMs: number): Promise<void> {
  const client = await getObserverClient();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.query<{ granted: boolean }>(
      `select granted from pg_locks where pid = $1 and locktype = 'advisory' and granted = true`,
      [pid],
    );
    if (res.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitUntilAdvisoryLockHeldCloudNative: timed out after ${timeoutMs}ms — pid ${pid} never acquired an advisory lock.`);
}

// Both the holder and the waiter are now dedicated raw-pg connections
// with KNOWN PIDs, so the blocking relationship is proven directly and
// deterministically via pg_blocking_pids() — no discovery/polling race
// on the waiter's identity, unlike the pg_locks-scanning approach this
// replaces (which was measured to be unreliable specifically because
// finding a PostgREST-originated waiter's PID by elimination could race
// against its own connection-pool routing time).
export async function waitUntilWaiterBlockedCloudNative(waiterPid: number, holderPid: number, timeoutMs: number): Promise<void> {
  const client = await getObserverClient();
  const deadline = Date.now() + timeoutMs;
  let lastBlockingPids: number[] = [];
  while (Date.now() < deadline) {
    const res = await client.query<{ blocking_pids: number[] }>(`select pg_blocking_pids($1) as blocking_pids`, [waiterPid]);
    const blockingPids = res.rows[0]?.blocking_pids ?? [];
    lastBlockingPids = blockingPids;
    if (blockingPids.includes(holderPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const diag = await client.query<{ locktype: string; granted: boolean; mode: string; state: string | null; query: string | null }>(
    `select l.locktype, l.granted, l.mode, a.state, a.query
     from pg_locks l left join pg_stat_activity a on a.pid = l.pid
     where l.pid = $1`,
    [waiterPid],
  );
  const activityDiag = await client.query<{ state: string | null; query: string | null; wait_event: string | null }>(
    `select state, query, wait_event from pg_stat_activity where pid = $1`,
    [waiterPid],
  );
  const holderDiag = await client.query<{ locktype: string; granted: boolean; mode: string; state: string | null }>(
    `select l.locktype, l.granted, l.mode, a.state from pg_locks l left join pg_stat_activity a on a.pid = l.pid where l.pid = $1`,
    [holderPid],
  );
  throw new Error(
    `waitUntilWaiterBlockedCloudNative: timed out after ${timeoutMs}ms — waiter pid ${waiterPid} was never observed blocked by holder pid ${holderPid}. ` +
      `lastBlockingPids=${JSON.stringify(lastBlockingPids)} waiterLocks=${JSON.stringify(diag.rows)} waiterActivity=${JSON.stringify(activityDiag.rows)} holderLocks=${JSON.stringify(holderDiag.rows)}`,
  );
}

// ============================================================================
// Tag-keyed registry — lets qr-issuance-reservation.test.ts's existing
// waitUntilHolderReady(tag, ...)/waitUntilBlocked(waiterTag, holderTag,
// ...) call sites (35 tests, ~70 call sites) stay COMPLETELY UNCHANGED.
// Only the launch statements (previously admin.rpc('test_only_hold_...')
// / fx.client.rpc(...)) are converted, via launchCloudNativeHolder()/
// launchCloudNativeWaiter() below, to open a session and register it here
// under the SAME tag string the test already generates. The test file's
// own waitUntilHolderReady/waitUntilBlocked wrapper functions look a tag
// up here (cloud-native mode) instead of polling
// test_only_is_holder_ready/test_only_is_waiter_blocked_by_holder (local
// mode) — see qr-issuance-reservation.test.ts's own updated
// waitUntilHolderReady/waitUntilBlocked bodies.
// ============================================================================
const holderSessionsByTag = new Map<string, CloudNativeHolderSession>();
const waiterSessionsByTag = new Map<string, CloudNativeAuthenticatedSession>();

export function registerCloudNativeHolder(tag: string, session: CloudNativeHolderSession): void {
  holderSessionsByTag.set(tag, session);
}

export function registerCloudNativeWaiter(tag: string, session: CloudNativeAuthenticatedSession): void {
  waiterSessionsByTag.set(tag, session);
}

export function getCloudNativeHolderSession(tag: string): CloudNativeHolderSession {
  const session = holderSessionsByTag.get(tag);
  if (!session) throw new Error(`getCloudNativeHolderSession: no holder session registered for tag "${tag}" — launchCloudNativeHolder() was never called for it.`);
  return session;
}

export function getCloudNativeWaiterSession(tag: string): CloudNativeAuthenticatedSession {
  const session = waiterSessionsByTag.get(tag);
  if (!session) throw new Error(`getCloudNativeWaiterSession: no waiter session registered for tag "${tag}" — launchCloudNativeWaiter() was never called for it.`);
  return session;
}

// Opens a holder session, starts the given SQL call on it (unawaited,
// matching the original admin.rpc() fire-and-poll pattern), registers it
// under `tag`, and waits until its lock is genuinely held — mirroring
// the original launch-then-waitUntilHolderReady() two-step exactly.
export async function launchCloudNativeHolder(tag: string, sql: string, params: unknown[], readyTimeoutMs: number): Promise<CloudNativeHolderSession> {
  const session = await CloudNativeHolderSession.open();
  registerCloudNativeHolder(tag, session);
  session.startHolderFunction(sql, params);
  await waitUntilHolderReadyCloudNative(session.pid, readyTimeoutMs);
  return session;
}

// Opens a waiter session (reproducing the given accessToken's PostgREST
// request context) and starts the given SQL call on it (unawaited) —
// registers it under `tag` so a later waitUntilBlocked(tag, holderTag,
// ...) call site can find it. Does NOT wait for blocking itself — that
// remains the caller's own subsequent waitUntilBlocked() call, exactly
// matching the original two-step pattern.
export async function launchCloudNativeWaiter(tag: string, accessToken: string | undefined, sql: string, params: unknown[]): Promise<CloudNativeAuthenticatedSession> {
  const session = await CloudNativeAuthenticatedSession.open(accessToken);
  registerCloudNativeWaiter(tag, session);
  session.startRpcFunction(sql, params);
  return session;
}

// Retrieves a waiter's already-completed (or in-flight) result, parsed
// from the to_jsonb(...)-wrapped composite the caller's own SQL text is
// expected to have used (see qr-issuance-reservation.test.ts's own
// convention: `select to_jsonb(fn(...)) as result`).
export async function getCloudNativeWaiterResult<T extends pg.QueryResultRow = Record<string, unknown>>(
  tag: string,
): Promise<T> {
  const session = getCloudNativeWaiterSession(tag);
  const res = await session.awaitCompletion<{ result: T }>();
  return res.rows[0].result;
}

// PostgREST-shaped { data, error } outcome, for tests that expect the
// waiter's call to FAIL with a specific PostgreSQL error (e.g. a raw
// unique_violation re-raised rather than swallowed) — raw pg rejects the
// query promise with a real pg.DatabaseError in that case rather than
// returning an {error} field, so this normalizes both shapes to the same
// {data, error} contract the original PostgREST-based tests already
// assert against (error.code, error.message).
export async function getCloudNativeWaiterOutcome<T extends pg.QueryResultRow = Record<string, unknown>>(
  tag: string,
): Promise<{ data: T | null; error: { code?: string; message: string } | null }> {
  const session = getCloudNativeWaiterSession(tag);
  try {
    const res = await session.awaitCompletion<{ result: T }>();
    return { data: res.rows[0].result, error: null };
  } catch (err) {
    const pgErr = err as { code?: string; message?: string };
    return { data: null, error: { code: pgErr.code, message: pgErr.message ?? String(err) } };
  }
}

// A test's own `finally` block is expected to have already released the
// lock gate (directly or via test_only_release_lock_gate) before calling
// this — but if an earlier unrelated throw skipped that, a holder session
// awaiting its own still-polling PL/pgSQL call would otherwise block
// close() (and therefore this whole test's — and the next test's —
// cleanup) for up to that holder's own internal p_max_wait_seconds
// ceiling. CLOSE_TIMEOUT_MS bounds that: past this window we stop waiting
// for the query to finish gracefully and force the connection closed via
// end(), which pg terminates without waiting for in-flight results, so no
// single leaked gate can ever stall the rest of the suite.
const CLOSE_TIMEOUT_MS = 3000;

async function awaitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([promise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

export async function closeCloudNativeSession(tag: string): Promise<void> {
  const holder = holderSessionsByTag.get(tag);
  if (holder) {
    await awaitWithTimeout(holder.awaitCompletion(), CLOSE_TIMEOUT_MS);
    await holder.close();
    holderSessionsByTag.delete(tag);
    return;
  }
  const waiter = waiterSessionsByTag.get(tag);
  if (waiter) {
    await awaitWithTimeout(waiter.awaitCompletion(), CLOSE_TIMEOUT_MS);
    await waiter.close();
    waiterSessionsByTag.delete(tag);
  }
}

// Closes every still-open session regardless of tag — a safety net for
// afterAll(), in case any individual test's own cleanup missed one (e.g.
// due to an assertion throwing before its own finally block's close
// calls ran).
export async function closeAllCloudNativeSessions(): Promise<void> {
  for (const session of holderSessionsByTag.values()) {
    await awaitWithTimeout(session.awaitCompletion(), CLOSE_TIMEOUT_MS);
    await session.close().catch(() => undefined);
  }
  holderSessionsByTag.clear();
  for (const session of waiterSessionsByTag.values()) {
    await awaitWithTimeout(session.awaitCompletion(), CLOSE_TIMEOUT_MS);
    await session.close().catch(() => undefined);
  }
  waiterSessionsByTag.clear();
}
