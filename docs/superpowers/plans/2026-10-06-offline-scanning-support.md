# Offline Scanning Support (5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the scanner and the walk-in admission page auto-retry after a lost network response, without ever producing a wrong outcome (double-admission, or a false rejection of someone already admitted) — by replacing their Server Actions with Route Handlers (required because Next.js serializes Server Actions client-side, which would otherwise queue a retry behind a hung original request) and adding server-side idempotency keys.

**Architecture:** Two independent idempotency keys (`scan_attempts.idempotency_key`/`scan_fingerprint` for the QR path, `session_bookings.idempotency_key` for walk-in), each checked immediately after its function's own authorization and serialization point, before any business logic that could misfire on a replay. Both admission paths move from Server Actions to Route Handlers so a retry's `fetch()` never queues behind a hung original request. A three-layer error classification (client-side `fetch()` failure, pre-RPC auth/lookup-query failure, RPC error-code table) distinguishes "retry this" from "stop and tell the operator." A shared helper module (Task 0) implements this classification ONCE, since both Route Handlers need the identical table and getting it wrong anywhere means a real failure either retries forever or a transient one gives up permanently.

**Tech Stack:** Next.js (App Router, Route Handlers, Client Components), Supabase Postgres (PL/pgSQL migrations), `@supabase/supabase-js`, Vitest (live integration tests against the scratch Supabase project; this repo has NO `@testing-library/react` and runs Vitest with `environment: 'node'` — client-side logic is tested by extracting pure functions and testing those directly, per `src/components/scanner/use-network-status.test.ts`'s established precedent, not by rendering components), next-intl.

**Spec:** `docs/superpowers/specs/2026-10-06-offline-scanning-support-design.md` — read this first; it went through three review rounds and the full rationale for every decision below lives there, not repeated here.

**Before starting any task below**, read in full:
- `supabase/migrations/20261006050000_walk_in_admission.sql` (contains the current `scan_attempt_transactional` body at lines 101-266, and `scan_qr_attempt_transactional` at lines 274+ — the ACTUAL current versions of both; its own `admit_walk_in` at the top of the file is superseded, see next file)
- `supabase/migrations/20261006052000_admit_walk_in_shared_advisory_lock.sql` (the actual current `admit_walk_in`)
- `src/lib/scanner-device/server-helpers.ts`, `src/lib/admission/server-helpers.ts` (both use `.single()`, not `.maybeSingle()` — this matters, see Task 0)
- `src/lib/attendance/scan-qr-attempt.ts` (note `toByteaHexOrNull` at line 43 and its use at line 76 — the RPC call passes a hex-encoded string, never a raw `Buffer`)
- `src/components/scanner/scanner-client.tsx`, `src/components/scanner/scan-state-machine.ts`
- `src/app/[locale]/(admin)/attendance/walk-in/actions.ts`, `walk-in-admission-form.tsx`
- `src/app/api/admin/reports/participants-csv/route.ts` (the Route Handler auth pattern to follow)
- `tests/attendance/scan-qr-attempt-server-boundary.test.ts` (an existing, extensive live test suite that imports `scanQrAttemptConfirmForCaller` directly — Task 3 must not delete this function out from under it)
- `src/components/scanner/use-network-status.test.ts` (the established "extract a pure function, test that" convention for client-side logic in this codebase, since there's no `@testing-library/react`)

This plan went through a review round that found real, serious errors in an earlier draft — most seriously, a "fix" in Task 0 that would have made a genuine authentication failure retry forever (the opposite of its purpose), and a Task 3 sketch that would have passed a raw `Buffer` into an RPC call expecting a hex string, silently breaking every resolved QR scan. Both are corrected below. Follow the SQL/TypeScript sketches in this plan closely — they're written against the real current files, not reconstructed from the spec's prose.

---

### Task 0: Shared upstream-error classification helper, and fixing the two auth helpers' real bug

**Files:**
- Create: `src/lib/supabase/upstream-error.ts`
- Modify: `src/lib/scanner-device/server-helpers.ts`
- Modify: `src/lib/admission/server-helpers.ts`
- Test: `tests/lib/supabase/upstream-error.test.ts`
- Test: `tests/lib/scanner-device/server-helpers.test.ts` (create if it doesn't exist — check first)
- Test: `tests/lib/admission/server-helpers.test.ts` (create if it doesn't exist — check first)

**The real bug, confirmed against the actual files**: both `requireScannerDeviceCaller` (`src/lib/scanner-device/server-helpers.ts:24`) and `requireAdmissionStaffCaller` (`src/lib/admission/server-helpers.ts:37`) do:
```typescript
const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
if (error || !profile) throw new Error('Profile not found');
```
This conflates "the query itself failed" (transport-shaped — Supabase unreachable) with "the query succeeded and found no row." Later tasks' Route Handlers need to tell these apart (retryable vs. not).

**Do NOT fix this the way an earlier draft of this plan suggested** (treating any populated `error` as transport-shaped). `.single()` is PostgREST/supabase-js behavior that returns a POPULATED `error` (code `PGRST116`) specifically when zero rows match — this is the normal, expected shape of "no profile," not a transport failure. Treating every `error` as retryable would make a genuinely-nonexistent profile retry forever instead of correctly denying access. The fix must distinguish `PGRST116` (and any other "clean, well-formed, zero-rows" code) from a genuine transport-shaped error (empty/undefined code, `PGRST000-003`, Postgres `08*`/`57014`/`40001`/`40P01`/`53300`, etc.) — the same code table the spec's RPC-error classification already needs (spec lines 112-116). Writing this table once, in a shared module, and importing it everywhere a Route Handler needs to classify an error avoids reimplementing (and risking a divergent copy of) it in four separate places (two auth helpers, two Route Handlers' RPC-error handling in Task 3/5).

- [ ] **Step 1: Write the failing tests for the shared classification helper**

Create `tests/lib/supabase/upstream-error.test.ts`. **Correction from plan review round 2**: an earlier draft of this task claimed `src/lib/` files in this project are tested co-located next to their source — this is wrong. There are zero `src/lib/**/*.test.ts` files anywhere in this repo; the real, confirmed convention is `tests/lib/<area>/` (e.g. `tests/lib/auth/`, `tests/lib/nav/`, `tests/lib/shell/` all already exist). Only `src/components/scanner/` and `src/app/manifest.ts` use co-located tests — a narrower exception, not the general rule. Follow the `tests/lib/` mirror for every `src/lib/` file this plan touches.

```typescript
import { describe, it, expect } from 'vitest';
import { isTransportShapedError, isLockContentionError } from './upstream-error';

describe('isTransportShapedError', () => {
  it('returns true for an empty error code (raw fetch rejection shape)', () => {
    expect(isTransportShapedError({ code: '', message: 'fetch failed' })).toBe(true);
  });
  it('returns true for an undefined code (non-JSON 5xx gateway shape)', () => {
    expect(isTransportShapedError({ code: undefined, message: '<html>502</html>' })).toBe(true);
  });
  it.each(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', '57014', '40001', '40P01', '53300', '08006'])(
    'returns true for Postgres/PostgREST transient code %s',
    (code) => {
      expect(isTransportShapedError({ code, message: 'x' })).toBe(true);
    }
  );
  it('returns false for PGRST116 (PostgREST "no rows" from .single() — a clean, well-formed denial, not a transport failure)', () => {
    expect(isTransportShapedError({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })).toBe(false);
  });
  it('returns false for a genuine deterministic rejection (P0001 without the lock-contention prefix)', () => {
    expect(isTransportShapedError({ code: 'P0001', message: 'Not authorized for this session/room' })).toBe(false);
  });
});

describe('isLockContentionError', () => {
  it('returns true only for P0001 with the exact LOCK_CONTENTION: prefix', () => {
    expect(isLockContentionError({ code: 'P0001', message: 'LOCK_CONTENTION: Another scan for this session is still being processed after 20 retries — please retry manually' })).toBe(true);
  });
  it('returns false for a different P0001 message', () => {
    expect(isLockContentionError({ code: 'P0001', message: 'Idempotency key reused with different scan data' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/lib/supabase/upstream-error.test.ts` — expected: fails, module doesn't exist yet.

- [ ] **Step 3: Write `src/lib/supabase/upstream-error.ts`**

```typescript
// src/lib/supabase/upstream-error.ts
//
// Shared classification for "is this Postgres/PostgREST/Supabase error
// shape a transient, retryable condition, or a genuine, deterministic
// denial?" -- written once here because sub-project 5b's Route Handlers
// (scan-qr-attempt, admit-walk-in) and the two existing auth helpers
// (requireScannerDeviceCaller, requireAdmissionStaffCaller) all need the
// identical answer to this question, and a second, independently-
// maintained copy risks silently drifting out of sync with this one.
//
// PGRST116 ("JSON object requested, multiple (or no) rows returned") is
// explicitly NOT in the transient set -- it's PostgREST's normal,
// well-formed response to a `.single()` call matching zero or >1 rows,
// not a sign anything is actually broken.
const TRANSIENT_CODES = new Set([
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003',
  '57014', '40001', '40P01', '53300',
]);

interface ErrorLike {
  code?: string | null;
  message?: string;
}

export function isTransportShapedError(err: ErrorLike | null | undefined): boolean {
  if (!err) return false;
  const code = err.code;
  if (code === '' || code === undefined || code === null) return true;
  if (TRANSIENT_CODES.has(code)) return true;
  if (code.startsWith('08')) return true; // Postgres connection-exception class
  return false;
}

export const LOCK_CONTENTION_PREFIX = 'LOCK_CONTENTION: ';

export function isLockContentionError(err: ErrorLike | null | undefined): boolean {
  if (!err) return false;
  return err.code === 'P0001' && (err.message ?? '').startsWith(LOCK_CONTENTION_PREFIX);
}
```

- [ ] **Step 4: Run the tests, verify they pass**

- [ ] **Step 5: Write the failing tests for `requireScannerDeviceCaller`**

Create `tests/lib/scanner-device/server-helpers.test.ts` (check first whether a test file for this helper already exists under a different name; add to it instead of duplicating if so). **Review confirmed there is no existing `vi.mock('@/lib/supabase/server', ...)` anywhere in this codebase to copy** — this will be the first. Mock the module directly:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));
// In each test, set createClient's resolved value to an object whose
// .auth.getUser() returns the scenario's { data, error } shape, and
// createServiceRoleClient's return value to an object whose
// .from('profiles').select(...).eq(...).single() returns the
// scenario's { data, error } shape -- a plain mutable mock object per
// test is simplest; match whatever shape @/lib/supabase/server's real
// createClient()/createServiceRoleClient() actually expose (read that
// file first) rather than inventing an unrelated shape.

it('throws UpstreamUnavailableError when the profiles .single() query itself fails with a transport-shaped error (not PGRST116)', async () => {
  // Arrange: getUser() resolves with a real user; the profiles query
  // resolves with { data: null, error: { code: '', message: 'fetch failed' } }
  // (a transport-shaped error -- NOT the PGRST116 shape .single() returns
  // for a genuine zero-row match).
  // Act + Assert: rejects with an UpstreamUnavailableError (or whatever
  // this step names it -- see below), distinguishable from a thrown
  // plain Error via `instanceof` or a `.retryable` field.
});

it('still throws a plain, non-retryable error for a genuine missing profile (PGRST116)', async () => {
  // Arrange: profiles query resolves with
  // { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
  // -- this is .single()'s REAL shape for zero rows, confirmed against
  // the actual supabase-js/postgrest-js behavior, not invented.
  // Act + Assert: rejects with the existing 'Profile not found' message,
  // and this rejection is NOT an UpstreamUnavailableError -- this is the
  // regression check proving the fix didn't change the correct-denial
  // behavior for the actual no-profile case.
});

it('throws a non-retryable error (not UpstreamUnavailableError) when getUser() returns AuthSessionMissingError (genuinely logged out)', async () => {
  // Arrange: supabase.auth.getUser() resolves with
  // { data: { user: null }, error: <an AuthSessionMissingError-shaped object> }
  // Act + Assert: rejects with 'Not authenticated', not retryable --
  // confirms a logged-out caller is NOT classified as upstream-unreachable.
});

it('throws UpstreamUnavailableError when getUser() itself fails with a retryable auth error (isAuthRetryableFetchError)', async () => {
  // Arrange: getUser() resolves with an error for which
  // isAuthRetryableFetchError(error) returns true. Import this from
  // '@supabase/supabase-js' (a direct project dependency that re-exports
  // it), not '@supabase/auth-js' directly -- the latter is not in this
  // project's package.json and only resolves today because npm happens
  // to hoist it; importing from the direct dependency avoids relying on
  // that incidental hoisting.
});

it('throws a plain, non-retryable error (not UpstreamUnavailableError) for a genuine permission-denied (42501) on the profiles query', async () => {
  // Arrange: profiles query resolves with
  // { data: null, error: { code: '42501', message: 'permission denied for table profiles' } }
  // -- a REAL, non-transient Postgres error code this project has
  // actually hit before (see this project's own service_role grants
  // history). Confirms the fix uses the full isTransportShapedError
  // table, not a narrower "anything except PGRST116" check that would
  // wrongly classify this as retryable-forever.
  // Act + Assert: rejects with a plain Error, NOT UpstreamUnavailableError.
});
```

- [ ] **Step 6: Run the tests, verify they fail**

- [ ] **Step 7: Fix `requireScannerDeviceCaller`**

Add an exported error class to `src/lib/supabase/upstream-error.ts` (same file as Step 3) that both this task and Task 3/5's Route Handlers will use:

```typescript
export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}
```

Then in `src/lib/scanner-device/server-helpers.ts`:

```typescript
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { UpstreamUnavailableError, isTransportShapedError } from '@/lib/supabase/upstream-error';

export async function requireScannerDeviceCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError && isAuthRetryableFetchError(userError)) {
    throw new UpstreamUnavailableError('auth.getUser() failed transiently');
  }
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  // Use the SAME shared classification table as everywhere else in this
  // sub-project, not a narrower ad hoc check -- an earlier draft of this
  // step used `error.code !== 'PGRST116'` directly, which would have
  // classified EVERY other error code (e.g. a genuine 42501 permission-
  // denied, which this project has hit for real before) as transient
  // and retryable forever, rather than correctly surfacing it as a real,
  // non-retryable problem.
  if (error && isTransportShapedError(error)) {
    throw new UpstreamUnavailableError('profiles lookup failed transiently');
  }
  if (!profile) throw new Error('Profile not found');
  if (!isScannerDeviceRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}
```

(Note the `.single()` PGRST116 case and the plain-missing-profile case both end up at `if (!profile) throw new Error('Profile not found')` — `.single()` returns `data: null` alongside the `PGRST116` error, so excluding that one code from the `UpstreamUnavailableError` branch and falling through to the existing check is correct and requires no further branching.)

- [ ] **Step 8: Run the tests, verify they pass**

- [ ] **Step 9: Repeat Steps 5-8 for `requireAdmissionStaffCaller`**

Same bug, same fix, in `src/lib/admission/server-helpers.ts` / its test file. Reuse `UpstreamUnavailableError`/`isAuthRetryableFetchError` from the same shared module — do not reimplement.

- [ ] **Step 10: Check existing callers aren't broken**

Both helpers have callers beyond this sub-project, including some live test files that call them directly (e.g. `tests/attendance/scanner-device-access-live.test.ts`, `tests/auth/staff-roles-live.test.ts` — confirmed via review). Run `grep -rln "requireScannerDeviceCaller\|requireAdmissionStaffCaller" src/ tests/` (both directories, not just `src/`) to find every caller, then run each caller's own test file and confirm nothing broke — the `'Profile not found'`/`'Not authenticated'` messages and behavior for a genuine denial must be byte-identical to before for every existing caller.

- [ ] **Step 11: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/lib/supabase/upstream-error.ts src/lib/scanner-device/server-helpers.ts src/lib/admission/server-helpers.ts tests/lib/supabase/upstream-error.test.ts tests/lib/scanner-device/server-helpers.test.ts tests/lib/admission/server-helpers.test.ts
git add src/lib/supabase/upstream-error.ts tests/lib/supabase/upstream-error.test.ts src/lib/scanner-device/server-helpers.ts src/lib/admission/server-helpers.ts tests/lib/scanner-device/server-helpers.test.ts tests/lib/admission/server-helpers.test.ts
git commit -m "fix: distinguish a transport failure from a genuine not-found/not-authenticated in the shared auth helpers"
```

---

### Task 1: QR path idempotency migration (`scan_attempts` columns + function changes)

**Files:**
- Create: `supabase/migrations/20261006110000_scan_attempts_idempotency.sql`
- Test: `tests/attendance/scan-qr-idempotency-live.test.ts`

No code dependency on Task 0. **Run this task BEFORE Task 2, not in parallel with it** — both tasks regenerate and commit `src/types/database.ts` from the same live database and both apply DDL/run live tests against the same shared scratch project; running them one after another avoids a type-regeneration commit race and avoids two tasks' live test runs contending with each other.

- [ ] **Step 1: Write the migration**

Copy `scan_attempt_transactional`'s CURRENT full body verbatim from `supabase/migrations/20261006050000_walk_in_admission.sql` lines 101-266 (including every existing comment — do not drop any, they explain real invariants, e.g. the `v_matched_booking_id` NULL-is-normal comment at lines 247-251) into this new migration, then make exactly these changes:

1. Add two new trailing parameters: `p_idempotency_key uuid default null, p_token_hash bytea default null`.
2. Add `v_scan_fingerprint bytea`, `v_existing scan_attempts%rowtype`, `v_constraint text` to the `declare` block.
3. Immediately after the scanner-scope re-check (the existing `if p_scanner_user_id is not null then ... end if;` block, lines 152-163) and BEFORE the existing `select status into v_application_status ...` line (165), insert:

```sql
  v_scan_fingerprint := extensions.digest(coalesce(p_token_hash, ''::bytea) || uuid_send(p_session_id), 'sha256');

  if p_idempotency_key is not null then
    select * into v_existing from scan_attempts where idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      if v_existing.scan_fingerprint is not distinct from v_scan_fingerprint and v_existing.session_id = p_session_id then
        return v_existing;
      else
        raise exception 'Idempotency key reused with different scan data';
      end if;
    end if;
  end if;
```

4. The existing early-return `invalid_qr` insert (lines 168-173, for a not-accepted application or missing session) must ALSO write the key/fingerprint — an earlier draft of this plan missed this, which would let a retry of this specific branch insert a second row. Change:
```sql
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now())
    returning * into v_scan_attempt;
```
to:
```sql
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at, idempotency_key, scan_fingerprint)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now(), p_idempotency_key, v_scan_fingerprint)
    returning * into v_scan_attempt;
```
This same column addition applies to EVERY existing `insert into scan_attempts` statement in this function body, not just this one — check each one.

5. Give the advisory-lock-exhausted exception its distinguishable prefix (unchanged otherwise):
```sql
    raise exception 'LOCK_CONTENTION: Another scan for this session is still being processed after % retries — please retry manually', v_max_retries;
```

6. The final section of the function (currently: `if v_result in (...) then <attendance_records insert> end if;` followed by one unconditional `insert into scan_attempts ...`) must become ONE `begin...exception when unique_violation` block wrapping BOTH the conditional `attendance_records` insert and the final `scan_attempts` insert together — an earlier draft of this plan incorrectly split these into a wrapped admitting-branch and an unwrapped non-admitting insert, which would let a non-admitting result's `scan_attempts` insert hit a cross-session key collision with no recovery. The correct structure, preserving every existing line unchanged except for the new wrapping and the two new columns on the final insert:

```sql
  begin
    if v_result in ('admitted', 'flexible_admitted', 'override_admitted') then
      -- v_matched_booking_id is NULL when no matching active booking exists
      -- (e.g. a flexible/priority admission with no prior self-service
      -- booking, or an admission for a participant who never used
      -- self-service booking at all) -- this is the expected, normal,
      -- non-error case per the design spec's scope decision 1.
      select id into v_matched_booking_id from session_bookings
      where application_id = p_application_id and session_id = p_session_id and status = 'active';

      insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, device_identifier, booking_id)
      values (p_application_id, p_session_id, p_time_slot_group_key, v_entry_type, p_scanned_by, p_device_identifier, v_matched_booking_id)
      returning id into v_attendance_id;
    end if;

    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, resulting_attendance_id, finalized_at, idempotency_key, scan_fingerprint)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, v_result, v_attendance_id, now(), p_idempotency_key, v_scan_fingerprint)
    returning * into v_scan_attempt;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'attendance_records_no_duplicate_active' then
      raise;
    elsif v_constraint = 'scan_attempts_idempotency_key_unique' then
      select * into v_existing from scan_attempts where idempotency_key = p_idempotency_key;
      if v_existing.scan_fingerprint is not distinct from v_scan_fingerprint and v_existing.session_id = p_session_id then
        return v_existing;
      else
        raise exception 'Idempotency key reused with different scan data';
      end if;
    else
      raise;
    end if;
  end;

  return v_scan_attempt;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

Preface the whole function with `drop function if exists scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean, uuid);` (matching the current 7-argument signature) and the column/index additions:

```sql
alter table scan_attempts add column idempotency_key uuid;
alter table scan_attempts add column scan_fingerprint bytea;
create unique index scan_attempts_idempotency_key_unique on scan_attempts (idempotency_key) where idempotency_key is not null;
```

**Before writing `scan_qr_attempt_transactional`'s new version, drop its old 6-argument signature too** — `drop function if exists public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid);`. Review round 2 caught that an earlier draft of this task only dropped `scan_attempt_transactional`'s old signature and never this one. A bare `create or replace` that adds a new trailing parameter does NOT replace an existing function with a different argument count — it creates a SECOND overload, leaving the original 6-argument version callable too. Any existing caller using named parameters without `p_idempotency_key` (confirmed live: `tests/attendance/scan-qr-attempt-live.test.ts` lines 133-137 and 318-322, and production's own `scan-qr-attempt.ts` until Task 3 updates it) would then match BOTH overloads ambiguously, and Postgres/PostgREST reports this as "function is not unique" (PGRST203) rather than resolving it — breaking every existing caller immediately upon this migration landing, not just the ones this sub-project updates later. Dropping the old signature first is required, matching this exact codebase's own established precedent for the same situation (`20261006050000_walk_in_admission.sql` line 99, dropping `scan_qr_attempt_transactional`'s even-older 5-argument form before that migration's own 6-argument version).

Then copy `scan_qr_attempt_transactional`'s current full body (same file, lines 274+) verbatim, adding:
- A new trailing `p_idempotency_key uuid default null` parameter, forwarded as the 8th positional argument to `scan_attempt_transactional` (the call currently passes 7 positional arguments — check the exact current call site and add BOTH `p_idempotency_key` and `p_token_hash` as the new 8th/9th arguments; an earlier draft of this plan only mentioned forwarding the key and silently dropped `p_token_hash`, which would make every resolved scan's fingerprint computed from an empty hash, breaking the mismatch check's whole purpose).
- Its own two unresolved-credential early-return branches (malformed hash, no active credential match) each compute `v_scan_fingerprint` the same way (using whatever `p_token_hash` these branches receive — `null` for the malformed-hash branch) and wrap their own single insert in the same `begin...exception when unique_violation` / `constraint_name` branching pattern as above (no advisory lock needed there, per the spec — each is a single, unconditional insert).

Finally, restate every `revoke`/`grant` these functions currently carry (check `20261006050000_walk_in_admission.sql`'s tail, around lines 340-347, for the exact current statements, and the `comment on function` statements too — both are lost when the old function is dropped and must be restated against the new signatures).

- [ ] **Step 2: Apply the migration**

Follow this project's established live-apply convention (check this session's/project's own memory notes for whether `supabase db push` works directly, or whether `db query --linked --file` is still required). Confirm via `select proname, pg_get_function_arguments(oid) from pg_proc where proname in ('scan_attempt_transactional', 'scan_qr_attempt_transactional')` that both now show the new trailing parameters.

- [ ] **Step 3: Write the failing tests**

Create `tests/attendance/scan-qr-idempotency-live.test.ts`, following this directory's established live-test conventions (runId-suffixed fixtures, service-role admin client, FK-ordered cleanup — check a recent live-test file in `tests/attendance/` for the exact helper-function shapes). Cover spec Testing Requirements 1, 3, 4, 6, 8, 9, 12, 13 (the full list is in the spec's Testing Requirements section) — each as its own `it(...)`, annotated with the requirement number. Do NOT include Testing Requirements 10/11 here (those are Route Handler HTTP-classification tests, assigned to Task 3 — they test `fetch()`/JSON-body classification, not the SQL layer, and belong against the Route Handler, not the database). Requirement 7's split (anon-key rejection vs. a signed-in-but-profile-less caller) belongs to Task 2 (walk-in), not here.

Testing Requirement 12 (the cross-session `unique_violation` backstop actually firing) is explicitly flagged in the spec as hard to construct reliably with `Promise.all` alone — attempt direct, carefully-sequenced SQL (e.g. two manually-interleaved transactions via separate `db query` connections) rather than relying on client-side parallelism, and if you cannot make it deterministic, report this honestly as DONE_WITH_CONCERNS with the exact difficulty encountered, rather than deleting or weakening the test.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/attendance/scan-qr-idempotency-live.test.ts`

- [ ] **Step 5: Regression check**

Run `npx vitest run tests/attendance` (the full existing suite) to confirm nothing broke — particularly `tests/attendance/scan-qr-attempt-server-boundary.test.ts` and `tests/attendance/scan-attempt-concurrency-live.test.ts`, both of which call these functions directly with the old (shorter) argument list; Postgres's default-parameter overloading should keep these working unchanged, but confirm rather than assume.

- [ ] **Step 6: Regenerate database types**

Run the project's established type-regeneration command, diff against `src/types/database.ts` to confirm the diff is purely additive, replace the file.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint tests/attendance/scan-qr-idempotency-live.test.ts
git add supabase/migrations/20261006110000_scan_attempts_idempotency.sql tests/attendance/scan-qr-idempotency-live.test.ts src/types/database.ts
git commit -m "feat: add idempotency key + fingerprint to scan_attempt_transactional/scan_qr_attempt_transactional"
```

---

### Task 2: Walk-in path idempotency migration (`session_bookings` column + `admit_walk_in` changes, including the security fix)

**Files:**
- Create: `supabase/migrations/20261006120000_admit_walk_in_idempotency.sql`
- Test: `tests/attendance/admit-walk-in-idempotency-live.test.ts`

Depends on Task 1 only in the sense of execution ORDER (run after Task 1 completes, not in parallel — see Task 1's note on shared `database.ts` regeneration and shared live-DB contention). No code dependency.

- [ ] **Step 1: Write the migration**

Copy `admit_walk_in`'s CURRENT full body verbatim from `supabase/migrations/20261006052000_admit_walk_in_shared_advisory_lock.sql` (including BOTH its comment blocks — lines 1-30 explaining the shared advisory lock rationale, and the inline comment at lines 63-70 explicitly warning not to "fix" the `attendance_records`-based capacity count into matching `book_session`'s — these are load-bearing explanations of real, intentional design decisions, not boilerplate to drop) into this new migration, then make exactly these changes:

1. Add a new trailing parameter: `p_idempotency_key uuid default null`.
2. Add `v_existing session_bookings%rowtype`, `v_constraint text` to the `declare` block.
3. Change the authorization check (the fix rides along since this signature change already drops/recreates the function):
```sql
  if not coalesce(is_staff(), false) then
    raise exception 'Not authorized';
  end if;
```
4. Immediately after `perform pg_advisory_xact_lock(hashtext(p_session_id::text));` and BEFORE the existing `select count(*) into v_admitted ...` capacity check, insert:
```sql
  if p_idempotency_key is not null then
    select * into v_existing from session_bookings where idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      if v_existing.application_id = p_application_id and v_existing.session_id = p_session_id then
        return v_existing.id;
      else
        raise exception 'Idempotency key reused with different admission data';
      end if;
    end if;
  end if;
```
5. **The `session_bookings` insert currently has NO `unique_violation` handler at all** — the `'This participant already has a booking for this session'` message currently comes entirely from the explicit pre-check at lines 77-82 (`if exists (select 1 from session_bookings where ...) then raise exception ...`), which stays in place UNCHANGED above this insert. This step ADDS a new `begin...exception` wrapper around the insert itself, branching three ways on `constraint_name`, as genuinely new code (not a modification of an existing handler — don't go looking for one to edit, there isn't one):
```sql
  begin
    insert into session_bookings (application_id, session_id, source, idempotency_key)
    values (p_application_id, p_session_id, 'walk_in', p_idempotency_key)
    returning id into v_booking_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'session_bookings_active_unique' then
      raise exception 'This participant already has a booking for this session';
    elsif v_constraint = 'session_bookings_idempotency_key_unique' then
      select * into v_existing from session_bookings where idempotency_key = p_idempotency_key;
      if v_existing.application_id = p_application_id and v_existing.session_id = p_session_id then
        return v_existing.id;
      else
        raise exception 'Idempotency key reused with different admission data';
      end if;
    else
      raise;
    end if;
  end;
```
6. The `attendance_records` insert's existing `exception when unique_violation` block (the second `begin...end` block, unrelated to the idempotency key) is UNCHANGED — leave it exactly as-is.

Preface with `drop function if exists admit_walk_in(uuid, uuid);` and the column/index additions:
```sql
alter table session_bookings add column idempotency_key uuid;
create unique index session_bookings_idempotency_key_unique on session_bookings (idempotency_key) where idempotency_key is not null;
```

Grant/revoke at the end — revoke from BOTH `public` AND `anon` explicitly, matching this codebase's own established precedent (`20261006050000_walk_in_admission.sql` line 346's `revoke all ... from public, anon, authenticated` pattern) rather than relying on `from public` alone: Supabase's own default-privilege setup can give `anon` an explicit grant that revoking only `from public` does not remove, since `anon` is a real role with its own ACL entries, not merely a member of `public` for grant-removal purposes:

```sql
grant execute on function admit_walk_in(uuid, uuid, uuid) to authenticated;
revoke execute on function admit_walk_in(uuid, uuid, uuid) from public, anon;
```

(Double-check the exact current index names for `session_bookings_active_unique` (`20260823020000_session_bookings.sql`) and `attendance_records_no_duplicate_active` (`20260804120000_create_attendance_records_table.sql` or wherever it's actually defined — confirm via `select indexname from pg_indexes where tablename in ('session_bookings', 'attendance_records')` against the live project before finalizing, rather than trusting this plan's citation alone.)

- [ ] **Step 2: Apply the migration**

Same convention as Task 1 Step 2. Verify the security fix specifically: `select has_function_privilege('anon', 'admit_walk_in(uuid,uuid,uuid)', 'execute')` must return `false`.

- [ ] **Step 3: Write the failing tests**

Create `tests/attendance/admit-walk-in-idempotency-live.test.ts`, covering spec Testing Requirements 2, 4, 5 (the walk-in-specific parts), and Requirement 7's THREE distinct cases — an earlier draft of this plan only split this into two (dropping the spec's own first case entirely):
- **7a (ordinary non-staff denial, with a previously-used key)**: a genuinely signed-in, normally-profiled PARTICIPANT (not staff) presents a valid, previously-committed idempotency key from someone else's successful admission — still gets `'Not authorized'`, proving the idempotency check never runs before (or instead of) the `is_staff()` gate, regardless of whether the key itself would have matched.
- **7b (revoke)**: an anon-key client (no signed-in user) calling `admit_walk_in` gets a permission-denied error at the grant layer, never reaching the function body — proves the `revoke ... from public, anon` took effect.
- **7c (coalesce)**: a genuinely signed-in but PROFILE-LESS authenticated user (create the auth user via the admin API, sign in as them, but do NOT create a matching `profiles` row — or delete it after creation) calling `admit_walk_in` gets `'Not authorized'` from inside the function body, not a silent success — this is the only way to actually exercise `coalesce(is_staff(), false)` specifically, since the anon case above never reaches it at all once the grant is fixed.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run tests/attendance/admit-walk-in-idempotency-live.test.ts`

- [ ] **Step 5: Regression check**

`admit_walk_in`'s existing, primary live coverage is NOT under `tests/attendance/` — it's the `describe('walk-in admission')` block inside `tests/agenda/booking-rules-completion-live.test.ts` (starting around line 648). Run `npx vitest run tests/agenda/booking-rules-completion-live.test.ts` explicitly (not just `tests/attendance`) to confirm this migration didn't break it. This file is known to have a slow/occasionally-timing-out `afterAll` cleanup against the live project (see this project's own prior notes on this if available) — a cleanup timeout there is a known pre-existing flake, not necessarily a sign this migration broke something, but confirm the actual test assertions themselves still pass before concluding either way.

- [ ] **Step 6: Type regen, typecheck, lint, commit**

```bash
git add supabase/migrations/20261006120000_admit_walk_in_idempotency.sql tests/attendance/admit-walk-in-idempotency-live.test.ts src/types/database.ts
git commit -m "feat: add idempotency key to admit_walk_in, fix is_staff() NULL-bypass and missing PUBLIC revoke"
```

---

### Task 3: Scanner Route Handlers (`/api/scan-qr-attempt`, `/api/scanner-health`)

**Files:**
- Create: `src/app/api/scan-qr-attempt/route.ts`
- Create: `src/app/api/scanner-health/route.ts`
- Modify: `src/lib/attendance/scan-qr-attempt.ts` (KEEP `scanQrAttemptConfirmForCaller` as a plain, non-`'use server'` exported function — see below — DO NOT delete it)
- Modify: `tests/attendance/scan-qr-attempt-server-boundary.test.ts` (update, do not break — see Step 1)
- Test: `tests/api/scan-qr-attempt-route.test.ts`
- Test: `tests/api/scanner-health-route.test.ts`

Depends on Task 0 (the fixed auth helpers + shared `upstream-error.ts`) and Task 1 (the new RPC parameters).

**Critical correction from plan review round 2, read before starting — the real auth architecture, confirmed against the actual file**: `scanQrAttemptConfirmForCaller(params, caller)` does NOT call `requireScannerDeviceCaller()` itself — it takes an already-authenticated `caller: { userId, service }` as an INJECTED parameter. Only the thin `scanQrAttemptConfirm(qrPayload, sessionId, deviceIdentifier)` wrapper (`scan-qr-attempt.ts` lines 112-115) calls `requireScannerDeviceCaller()` and then delegates to `...ForCaller`. This split exists specifically because `...ForCaller` is unit-testable without a request context (confirmed by `tests/attendance/scan-qr-attempt-server-boundary.test.ts`'s own header comment, lines 13-22) — an earlier draft of this task's Step 3 incorrectly told the implementer to move the auth call INSIDE `...ForCaller`, while its Step 7 sketch simultaneously called `...ForCaller` with no caller at all, and its Step 10 deleted the only code (`scanQrAttemptConfirm`) that ever authenticated anything. That combination would have broken auth entirely. **Do not do any of that.** Instead:

- `scanQrAttemptConfirmForCaller`'s signature and injected-caller pattern stay EXACTLY as they are today — only its return type changes, from `Promise<ScanQrResult>`/throwing to `Promise<ScanQrOutcome>` (success/retryable/non-retryable), and it gains a new `idempotencyKey: string` parameter. It remains importable and unit-testable with a hand-constructed `caller` object, exactly as the existing boundary test already does.
- `scanQrAttemptConfirm` (the thin wrapper that calls `requireScannerDeviceCaller()`) is REMOVED — nothing needs it once `route.ts` takes over that role.
- `route.ts`'s `POST` handler is the new home for "call `requireScannerDeviceCaller()`, then call `...ForCaller` with the result as `caller`" — i.e., `route.ts` takes over exactly what `scanQrAttemptConfirm` used to do, classifying `requireScannerDeviceCaller()`'s own throw (now potentially an `UpstreamUnavailableError` per Task 0) before ever reaching `...ForCaller`.
- `tests/attendance/scan-qr-attempt-server-boundary.test.ts`'s existing calls to `...ForCaller` (which already construct their own `caller` object directly, per its header comment) need NO change to how they call it beyond the return-shape adaptation in Step 1 below — they never went through `requireScannerDeviceCaller()` in the first place, so nothing about the auth-relocation affects them.

Also critical: the real `scanQrAttemptConfirmForCaller` passes `p_token_hash: toByteaHexOrNull(tokenHash) as string` to the RPC (`scan-qr-attempt.ts` line 76) — a hex-encoded string via a helper function, NEVER the raw `Buffer` that `hashQrToken` produces. Any rewrite of this function's body must keep using `toByteaHexOrNull`, not pass the raw hash directly.

**Known temporary build break, accepted deliberately**: between this task's Step 3 (changing `...ForCaller`'s return type) and Task 4 (updating `scanner-client.tsx`'s call site), `scanner-client.tsx` will fail to typecheck/import correctly, since it currently imports the now-removed `scanQrAttemptConfirm` and expects the old throwing contract. This task's own Step 11 `tsc --noEmit` is EXPECTED to show errors in `scanner-client.tsx` specifically (and only that file) — confirm the failure is confined to that one file's stale import, not a sign this task's own files are broken, and note this explicitly in your task report rather than treating it as a regression to chase down within this task. Task 4 resolves it.

- [ ] **Step 1: Update `tests/attendance/scan-qr-attempt-server-boundary.test.ts` for the new outcome-returning contract**

Read this file in full first (all ~14 test cases, not just the ones using `.rejects.toThrow`). Review found most of this file's assertions read `result.result`, `result.scanAttemptId`, etc. directly on a successful resolution — these need to become `outcome.result.result`, `outcome.result.scanAttemptId` (narrowed through the new `{ ok: true, result: ScanQrResult }` wrapper), not just the `.rejects.toThrow` cases converted to `{ ok: false, retryable, message }` checks. Specific things to get right:
- Only one case (confirmed: the "Not authorized" scope-violation test) currently uses `.rejects.toThrow` — convert that one to assert `{ ok: false, retryable: false, message: expect.stringContaining('Not authorized') }`.
- Every other test case currently awaits a direct `ScanQrResult` and reads its fields — these become `const outcome = await scanQrAttemptConfirmForCaller(...); if (!outcome.ok) throw new Error('expected success'); expect(outcome.result.result).toBe(...)` (or equivalent type-narrowing your test style prefers).
- The test asserting an exact key list on the result object needs its assertion moved to check `outcome.result`'s keys, not `outcome`'s.
- **Give every distinct test case its OWN fresh `idempotencyKey` via `crypto.randomUUID()`** — do not reuse one key across multiple test cases/calls in this file. A reused key would make a second call replay the first call's cached result instead of re-executing the scenario the second test actually intends to exercise (e.g. a test that calls the function twice to prove a duplicate-scan detection must use two DIFFERENT keys, or the second call will return the first call's original result via the new idempotency check instead of ever reaching the duplicate-detection logic it's testing).
- The test described in an earlier draft of this plan as "override-escalation" is actually a success-path test (asserting `restricted_denied` behavior) — it needs no `.rejects`-to-outcome conversion at all, only the `result.X` → `outcome.result.X` field-access update like the other success-path tests.

- [ ] **Step 2: Run this test file, verify the now-adapted assertions fail**

(They should fail because `scanQrAttemptConfirmForCaller` doesn't return the new shape yet.)

- [ ] **Step 3: Rewrite `scanQrAttemptConfirmForCaller` in `src/lib/attendance/scan-qr-attempt.ts`**

Keep its existing `(params, caller)` signature; add a third parameter `idempotencyKey: string`. Change its return type to `Promise<ScanQrOutcome>` (success/retryable/non-retryable per spec lines 101-105) instead of `Promise<ScanQrResult>`/throwing. Classification, using Task 0's `isTransportShapedError`/`isLockContentionError`:
- `verifyScannerScope`'s two queries (currently silently ignoring a populated `error` on both the `sessions` read and the `scanner_assignments` count) must each check their OWN `error` first via `isTransportShapedError` before concluding "not found"/"not authorized" — this is the layer-2 fix from spec line 111, applied here inline, replacing the existing silent-ignore behavior. A transport-shaped error on either query → return `{ ok: false, retryable: true, reason: 'upstream-unreachable' }` immediately.
- The RPC's own `{ data, error }`: apply `isLockContentionError`/`isTransportShapedError` from Task 0 against `error`, per the classification table (spec lines 112-116) — do not reinvent this table here, import and reuse Task 0's helpers.
- Keep `toByteaHexOrNull(tokenHash)` unchanged, and keep `getScannerParticipantSummary` unchanged (it already swallows its own errors and returns `null`, so it's safe to carry forward as-is).
- Pass the new `idempotencyKey` parameter through to the RPC call as `p_idempotency_key`.
- A successful RPC call returns `{ ok: true, result: { result: data.result, scanAttemptId: data.id, attendanceId: data.resulting_attendance_id, participantSummary } }` — the existing `ScanQrResult` shape, now nested under `result`.

Then write a new, SEPARATE thin function (replacing the deleted `scanQrAttemptConfirm` — this is the Route Handler's job now, see Step 7, so this new function may live directly in `route.ts` rather than back in `scan-qr-attempt.ts`; your choice, note which in your report) that calls `requireScannerDeviceCaller()`, classifies ITS throw the same way (an `UpstreamUnavailableError` → `{ ok: false, retryable: true, reason: 'upstream-unreachable' }`; any other throw → `{ ok: false, retryable: false, message: err.message }`), and on success calls `scanQrAttemptConfirmForCaller(params, caller, idempotencyKey)`.

- [ ] **Step 4: Run the test file, verify it passes**

Run: `npx vitest run tests/attendance/scan-qr-attempt-server-boundary.test.ts`

- [ ] **Step 5: Write the failing tests for `...ForCaller`'s classification logic directly**

Create `tests/attendance/scan-qr-attempt-classification.test.ts` (or add to the existing boundary test file — your choice) covering spec Testing Requirements 10 and 11 directly against `scanQrAttemptConfirmForCaller` with a MOCKED `service` client (not a live DB call, since these are pure classification-logic tests): a mocked RPC response `{ data: null, error: { code: 'P0001', message: 'LOCK_CONTENTION: ...' } }` → `{ ok: false, retryable: true, reason: 'lock-contention' }`; a mocked `verifyScannerScope` sessions-query response `{ data: null, error: { code: '' } }` (a transport-shaped failure, not a clean empty result) → `{ ok: false, retryable: true, reason: 'upstream-unreachable' }`. An earlier draft of this plan assigned these two requirements to Task 3's Route Handler test file, which mocks `...ForCaller` itself and therefore can never actually exercise this classification logic — these two requirements need a test that calls the REAL `...ForCaller` with a mocked database layer underneath it, not a test that mocks `...ForCaller` away entirely.

- [ ] **Step 6: Run the tests, verify they fail, then pass after Step 3's work**

- [ ] **Step 7: Write the failing tests for the Route Handler itself**

Create `tests/api/scan-qr-attempt-route.test.ts` — this matches the real, confirmed convention for Route Handler tests in this codebase (`tests/api/resend-webhook.test.ts` is the existing precedent, importing its handler function directly from `@/app/api/...`), NOT co-located under `src/app/api/`. Mock `scanQrAttemptConfirmForCaller` AND `requireScannerDeviceCaller` (both — the route now owns the auth call, per Step 3's design) to return/throw each relevant case, and assert the handler's HTTP response: **every** classified outcome (success, retryable, non-retryable — including an `UpstreamUnavailableError` thrown by the mocked `requireScannerDeviceCaller`) returns HTTP `200` with the outcome as the JSON body — per spec line 184, the retryable/non-retryable distinction lives in the JSON body, never the HTTP status, specifically so the client's "any non-2xx or unparseable body means transport failure" rule (layer 1) never misfires on a deterministic server-side denial. Also test: a malformed request body (bad JSON, missing fields) returns a `200` with `{ ok: false, retryable: false, ... }`, not an uncaught `500` — the whole handler body must be wrapped in a try/catch that converts any unexpected thrown error into this same non-retryable shape. Also test: a non-uuid `sessionId` or `idempotencyKey` in the request body is rejected with `{ ok: false, retryable: false }` BEFORE any auth/RPC call is attempted.

- [ ] **Step 8: Run the tests, verify they fail**

- [ ] **Step 9: Write `src/app/api/scan-qr-attempt/route.ts`**

```typescript
// src/app/api/scan-qr-attempt/route.ts
import { NextResponse } from 'next/server';
import { scanQrAttemptConfirmForCaller } from '@/lib/attendance/scan-qr-attempt';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { qrPayload, sessionId, deviceIdentifier, idempotencyKey } = body ?? {};
    if (typeof qrPayload !== 'string' || !isUuid(sessionId) || !isUuid(idempotencyKey)) {
      return NextResponse.json({ ok: false, retryable: false, message: 'Invalid request' }, { status: 200 });
    }

    let caller;
    try {
      caller = await requireScannerDeviceCaller();
    } catch (err) {
      if (err instanceof UpstreamUnavailableError) {
        return NextResponse.json({ ok: false, retryable: true, reason: 'upstream-unreachable' }, { status: 200 });
      }
      return NextResponse.json({ ok: false, retryable: false, message: err instanceof Error ? err.message : 'Not authorized' }, { status: 200 });
    }

    const outcome = await scanQrAttemptConfirmForCaller(
      { qrPayload, sessionId, deviceIdentifier: typeof deviceIdentifier === 'string' ? deviceIdentifier : null },
      caller,
      idempotencyKey
    );
    return NextResponse.json(outcome, { status: 200 });
  } catch (err) {
    // An unexpected, unclassified throw must never look like "keep
    // retrying" to the client -- default to non-retryable.
    return NextResponse.json({ ok: false, retryable: false, message: 'Unexpected error' }, { status: 200 });
  }
}
```

- [ ] **Step 10: Run the tests, verify they pass**

- [ ] **Step 11: Write and implement `src/app/api/scanner-health/route.ts` + its test**

```typescript
// src/app/api/scanner-health/route.ts
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';
import { UpstreamUnavailableError } from '@/lib/supabase/upstream-error';

export async function GET() {
  let caller;
  try {
    caller = await requireScannerDeviceCaller();
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) return new Response(null, { status: 503 });
    return new Response(null, { status: 401 });
  }

  const { error } = await caller.service.from('scan_attempts').select('id', { head: true }).limit(0);
  if (error) return new Response(null, { status: 503 });

  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
```

Test (`tests/api/scanner-health-route.test.ts`, mocking `requireScannerDeviceCaller`): a thrown `UpstreamUnavailableError` → 503; a thrown plain `Error` (genuine auth denial) → 401; a successful caller but a failing `scan_attempts` query → 503; both succeeding → 200.

- [ ] **Step 12: Check for other callers of the removed `scanQrAttemptConfirm` wrapper**

`grep -rn "scanQrAttemptConfirm\b" src/` (note: NOT `scanQrAttemptConfirmForCaller`, which Step 3 kept with its signature intact). Update any other call site — `scanner-client.tsx`'s import is the known one, deliberately left broken until Task 4 per this task's header note.

- [ ] **Step 13: Typecheck, lint, commit**

Expect `tsc --noEmit` to show an error in `scanner-client.tsx` specifically (its stale `scanQrAttemptConfirm` import) — this is the documented, accepted temporary break from this task's header, not a sign of a problem in the files this task actually touches. Confirm no OTHER file shows a new error before committing.

```bash
npx tsc --noEmit
npx eslint src/app/api/scan-qr-attempt/ src/app/api/scanner-health/ src/lib/attendance/scan-qr-attempt.ts tests/attendance/scan-qr-attempt-server-boundary.test.ts
git add src/app/api/scan-qr-attempt/ src/app/api/scanner-health/ src/lib/attendance/scan-qr-attempt.ts tests/attendance/scan-qr-attempt-server-boundary.test.ts
git commit -m "feat: move scan-qr-attempt submission and health check from a Server Action to Route Handlers"
```

---

### Task 4: Scanner client — state machine, retry loop, UI

**Files:**
- Modify: `src/components/scanner/scan-state-machine.ts`
- Modify: `src/components/scanner/scanner-client.tsx`
- Create: `src/components/scanner/use-scan-retry.ts`
- Modify: `src/components/scanner/scan-state-machine.test.ts` (co-located, confirmed existing file)
- Create: `src/components/scanner/use-scan-retry.test.ts` (co-located — test the extracted PURE functions this hook exposes, e.g. a backoff-delay calculator and a stale-response-check function, NOT the hook itself via a renderer; this repo has no `@testing-library/react` and runs Vitest with `environment: 'node'`, confirmed via `vitest.config.ts` and `src/components/scanner/use-network-status.test.ts`'s own header comment, which explicitly states this and shows the pattern to follow)

Depends on Task 3. Read spec lines 120-186 in full before starting.

- [ ] **Step 1: Write the failing state-machine tests**

In `src/components/scanner/scan-state-machine.test.ts`: fix every existing bare `{ type: 'SUBMIT_START' }` dispatch to supply the new required fields (`idempotencyKey`, `attemptSeq`, `startedAt`). Add new tests for the `retrying` state's transitions (`SUBMIT_TRANSPORT_FAILURE`, `SUBMIT_REJECTED`, `RETRY_ATTEMPT`, `CANCEL_RETRY`) per the type definitions at spec lines 124-138. Explicitly include, as their own test cases (previously unassigned to any task in an earlier draft of this plan):
- **Testing Requirement 18**: dispatching `CANCEL_RETRY` from `retrying`, then a fresh `DETECT`/`SUBMIT_START` for the same `qrPayload`, produces a NEW `idempotencyKey` in the resulting `submitting` state — not a reuse of the cancelled attempt's key (this is a property of how the CALLER generates the key before dispatching, so the test asserts that two separately-constructed `SUBMIT_START` actions with independently-generated keys produce two different `idempotencyKey` values in state, confirming the reducer itself does nothing to prevent key reuse — the real guarantee is the caller's own `crypto.randomUUID()` call on every genuinely-new scan event).
- **Testing Requirement 19**: `DETECT` dispatched while `state.kind === 'retrying'` is a no-op (returns the same `retrying` state unchanged) — the single-flight guarantee extending correctly to the new state, verified directly rather than only asserted as true in prose.

- [ ] **Step 2: Run the tests, verify they fail**

- [ ] **Step 3: Update `scan-state-machine.ts`**

Add the new `ScanState`/`ScanAction` variants exactly per spec lines 124-138. Decide where `lastRejection: string | null` lives (the spec suggests "alongside, not inside" the reducer's own state — if you implement it as separate component-level `useState` rather than inside this file's reducer state, say so explicitly in your report) and add a dedicated `OFFLINE_BLOCKED` action (`ready`/`detected` → `ready`, no new idempotency fields needed) replacing the existing offline-short-circuit's current reuse of `SUBMIT_START`/`SUBMIT_ERROR` — the spec flags this as an open decision for implementation (line 150); this plan resolves it as a new, separate action rather than forcing a meaningless UUID through the "real" submission path.

Also add a new `RETRY_ABORTED { message: string }` action (`retrying` → `ready`, carries the message to `lastRejection`) — needed because the health-check Route Handler's `401` case (Task 3 Step 9) can occur WHILE the state machine is in `retrying`, and `SUBMIT_REJECTED` is only a valid transition from `submitting`, not `retrying`. This was an unresolved gap in an earlier draft of this plan.

- [ ] **Step 4: Run the tests, verify they pass**

- [ ] **Step 5: Write `use-scan-retry.ts`'s pure functions and their tests first (TDD)**

Before writing any stateful hook logic, extract and test the pure decision functions this hook needs, following `use-network-status.ts`'s established pattern:

```typescript
// in use-scan-retry.ts, or a sibling file if it grows large enough to warrant splitting
export function nextBackoffDelayMs(previousDelayMs: number): number {
  return Math.min(previousDelayMs * 2, 10_000);
}

export function isStaleAttempt(guardKey: string, guardSeq: number, responseKey: string, responseSeq: number): boolean {
  // True means "discard this response -- it belongs to a superseded
  // attempt." Must compare BOTH key and seq: retries intentionally
  // reuse the same idempotencyKey across a whole retry cycle, so a
  // seq-only or key-only comparison alone cannot tell a stale response
  // for attempt N apart from the current attempt N+1 that happens to
  // share the same key (or, across a brand-new scan, happens to reuse
  // seq 0).
  return responseKey !== guardKey || responseSeq !== guardSeq;
}
```

Write `src/components/scanner/use-scan-retry.test.ts` covering both functions directly (pure function calls, no React involved) — this is where Testing Requirements 16 and the backoff-timing half of 17 actually get covered, NOT as "pure-reducer assertions" (an earlier draft of this plan mis-assigned requirement 16 to the reducer, but the stale-response guard lives in a ref outside the reducer, not in reducer state).

- [ ] **Step 6: Run the pure-function tests, verify they pass**

- [ ] **Step 7: Implement the stateful retry logic as a plain, non-hook factory function first**

**A React hook's internals cannot be called or tested outside a component render** — an earlier draft of this task's Step 8 described testing the hook's exposed functions "directly," which isn't executable (there's no renderer available to produce a live hook instance to call into). The fix: write the actual stateful logic as a plain factory function, and make `use-scan-retry.ts`'s exported hook a thin wrapper around it (a `useRef`/`useEffect` shell that constructs one instance and exposes its methods) — this is standard practice for making hook logic unit-testable without a DOM/renderer, and it's what makes Step 8 below actually work.

```typescript
// in use-scan-retry.ts, below the pure functions from Step 5
export function createScanRetryController(deps: {
  dispatch: (action: ScanAction) => void;
  fetchImpl: typeof fetch; // injectable for tests
}) {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 2000;
  const guard = { idempotencyKey: '', attemptSeq: -1 };

  function submit(qrPayload: string, sessionId: string, deviceIdentifier: string | null, idempotencyKey: string, attemptSeq: number) {
    guard.idempotencyKey = idempotencyKey;
    guard.attemptSeq = attemptSeq;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    deps.fetchImpl('/api/scan-qr-attempt', {
      method: 'POST',
      body: JSON.stringify({ qrPayload, sessionId, deviceIdentifier, idempotencyKey }),
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timeout);
        if (isStaleAttempt(guard.idempotencyKey, guard.attemptSeq, idempotencyKey, attemptSeq)) return;
        if (!res.ok) { deps.dispatch({ type: 'SUBMIT_TRANSPORT_FAILURE' }); return; }
        const outcome = await res.json().catch(() => null);
        if (!outcome) { deps.dispatch({ type: 'SUBMIT_TRANSPORT_FAILURE' }); return; }
        if (outcome.ok) deps.dispatch({ type: 'SUBMIT_SUCCESS', result: outcome.result });
        else if (outcome.retryable) deps.dispatch({ type: 'SUBMIT_TRANSPORT_FAILURE' });
        else deps.dispatch({ type: 'SUBMIT_REJECTED', message: outcome.message });
      })
      .catch(() => {
        clearTimeout(timeout);
        if (isStaleAttempt(guard.idempotencyKey, guard.attemptSeq, idempotencyKey, attemptSeq)) return;
        deps.dispatch({ type: 'SUBMIT_TRANSPORT_FAILURE' });
      });
  }

  function pollHealthThenRetry(qrPayload: string, sessionId: string, deviceIdentifier: string | null, idempotencyKey: string) {
    const controller = new AbortController();
    deps.fetchImpl('/api/scanner-health', { signal: controller.signal, cache: 'no-store' })
      .then((res) => {
        if (isStaleAttempt(guard.idempotencyKey, guard.attemptSeq, idempotencyKey, guard.attemptSeq)) return;
        if (res.status === 200) {
          backoffMs = 2000;
          const nextSeq = guard.attemptSeq + 1;
          deps.dispatch({ type: 'RETRY_ATTEMPT', attemptSeq: nextSeq });
          submit(qrPayload, sessionId, deviceIdentifier, idempotencyKey, nextSeq);
        } else if (res.status === 401) {
          deps.dispatch({ type: 'RETRY_ABORTED', message: 'Scanner session expired — please re-authenticate' });
        } else {
          backoffMs = nextBackoffDelayMs(backoffMs);
          timerId = setTimeout(() => pollHealthThenRetry(qrPayload, sessionId, deviceIdentifier, idempotencyKey), backoffMs);
        }
      })
      .catch(() => {
        backoffMs = nextBackoffDelayMs(backoffMs);
        timerId = setTimeout(() => pollHealthThenRetry(qrPayload, sessionId, deviceIdentifier, idempotencyKey), backoffMs);
      });
    // Store this controller somewhere `cancel()` below can reach, so a
    // Cancel click can abort an in-flight health-check fetch too --
    // review's M6 finding: without this, a health check that resolves
    // 200 AFTER Cancel was clicked would still call submit() again,
    // since isStaleAttempt alone doesn't stop a health-check-triggered
    // retry from firing if the guard hasn't been bumped past it yet.
    // (Implementer: wire this controller into the same cancel() below.)
  }

  function cancel() {
    if (timerId) clearTimeout(timerId);
    guard.attemptSeq = -999; // sentinel that can never match a real attemptSeq
    // Also abort any in-flight health-check AbortController here (see
    // the comment inside pollHealthThenRetry above) -- track it in an
    // outer-scope variable this closure can reach.
  }

  return { submit, pollHealthThenRetry, cancel };
}
```

Then write `use-scan-retry.ts`'s actual exported hook as a thin wrapper: `const controllerRef = useRef<ReturnType<typeof createScanRetryController>>(); if (!controllerRef.current) controllerRef.current = createScanRetryController({ dispatch, fetchImpl: fetch });` and expose `controllerRef.current`'s methods to `scanner-client.tsx`.

- [ ] **Step 8: Write the stateful behavior tests against the plain factory function**

Create or extend `src/components/scanner/use-scan-retry.test.ts`: call `createScanRetryController({ dispatch: vi.fn(), fetchImpl: vi.fn() })` directly (a plain function call — no renderer, no hook, exactly the shape that makes this testable at all) and assert on the mock `dispatch`'s calls and the mock `fetchImpl`'s calls. Cover: a `fetch()` rejection and a parsed `{ ok: false, retryable: true }` body both leading to the identical `SUBMIT_TRANSPORT_FAILURE` dispatch (Testing Requirement 15); a non-retryable rejection never triggering a call to `pollHealthThenRetry`/a second `fetchImpl` call (Testing Requirement 14); `cancel()` followed by a late-resolving mocked `fetchImpl` promise never producing a dispatch (the stale-response guard working end-to-end, including the M6 health-check-after-cancel case specifically).

- [ ] **Step 9: Wire `use-scan-retry` into `scanner-client.tsx`**

Replace the existing `scanQrAttemptConfirm(...).then(...).catch(...)` call (today's lines ~148-175) with calls into the new hook. The Cancel button's `onClick` must, synchronously within that same handler (per the spec's iOS-Safari user-gesture requirement, line 158): call `retry.cancel()`, then `dispatch({ type: 'CANCEL_RETRY' })`, then `start()` (the existing camera-control function from `useQrScanner`, already in scope in this file — see the existing `handleScanNext`-style precedent around lines 198-203 for how this file already calls `start()`/`stop()`).

Implement the "Try Now"/"Cancel" buttons and the 30-second persistent message (`startedAt` from the `retrying` state, compared against `Date.now()` in a render-time check or a `setInterval` tick — your choice, note which in your report).

Verify, don't just assume, that the existing `DETECT`-is-a-no-op-unless-`ready` guard in the reducer genuinely covers the newly-added `retrying` state (it should, via the reducer's existing `default: return state` branch, but confirm by reading the actual updated switch statement after Step 3, not by re-deriving the argument from scratch).

- [ ] **Step 10: Add/update i18n keys**

Add new keys for "Connection lost — retrying…", "Try Now", "Cancel", the 30-second persistent message, and a re-authenticate message (for `RETRY_ABORTED`), in both `en.json` and `ar.json`, following the existing `"scanner"` namespace's style (check the existing `offlineBlocked`/`uncertain`/`server` keys for register). Decide whether the existing `'uncertain'`/`'server'` `SubmitFailureKind` values and their i18n keys are now dead code (since `retrying` supersedes most of what they covered) — if so, remove them in this same step rather than leaving unreachable code; if any remaining call site still needs one of them, say so explicitly in your report.

- [ ] **Step 11: Manual/code-trace verification**

Browser verification may not be practical in this environment. Do a careful code-level trace: confirm the camera-resume-on-cancel call is genuinely synchronous within the Cancel button's own click handler; confirm the stale-response guard (`isStaleAttempt`) is checked in every dispatch path the hook has; confirm `startedAt` survives a `retrying → submitting → retrying` cycle without being reset. State this trace explicitly in your report.

- [ ] **Step 12: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/components/scanner/
git add src/components/scanner/ src/messages/en.json src/messages/ar.json
git commit -m "feat: add retrying state and auto-retry loop to the scanner client"
```

---

### Task 5: Walk-in Route Handlers + form retry UI

**Files:**
- Create: `src/app/api/admit-walk-in/route.ts`
- Create: `src/app/api/admission-staff-health/route.ts`
- Modify (gut or delete, depending on Step 5's finding): `src/app/[locale]/(admin)/attendance/walk-in/actions.ts`
- Modify: `src/app/[locale]/(admin)/attendance/walk-in/walk-in-admission-form.tsx`
- Test: `tests/api/admit-walk-in-route.test.ts`
- Test: `tests/api/admission-staff-health-route.test.ts`

Depends on Task 0, Task 2, AND Task 4 (this task reuses the retry-UI i18n keys Task 4 adds, and ideally the same `nextBackoffDelayMs`/`isStaleAttempt` pure functions from `use-scan-retry.ts` — import and reuse them rather than re-deriving equivalent logic by hand, to avoid the two retry loops silently drifting apart over time).

- [ ] **Step 1: Write the failing Route Handler tests**

Create `tests/api/admit-walk-in-route.test.ts`, mirroring Task 3 Step 5's structure but for the walk-in shape (`{ ok: true, bookingId } | { ok: false, retryable, message }`), with the same "always HTTP 200, malformed-body safety, uuid validation" requirements.

- [ ] **Step 2: Port the identifier-resolution logic into `src/app/api/admit-walk-in/route.ts`**

Port the logic currently in `actions.ts`'s `admitWalkIn` (the identifier search via `buildIlikeOrFilter`, the accepted/ambiguous/not-found branches, then the RPC call) into this handler's `POST`. Two details an earlier draft of this plan missed:
- The identifier-lookup query (`service.from('applications').select(...).or(orFilter).limit(10)`) must check its OWN `error` via `isTransportShapedError` before concluding "no match" — same layer-2 fix as the scanner's `verifyScannerScope`.
- **The `admit_walk_in` RPC call must use the caller's own authenticated `session` client, not the `service` (service-role) client** — `is_staff()` and `scanned_by = auth.uid()` inside the function need the real signed-in user's identity, which only the `session` client (from `requireAdmissionStaffCaller`'s return value) carries; the `service` client has no `auth.uid()`. Confirm this against the current `actions.ts` (it already does this correctly — `session.rpc('admit_walk_in', ...)` — carry that exact choice forward, don't accidentally switch to `service`.

Apply the same try/catch-wraps-everything, always-200, uuid-validation pattern as Task 3's scan Route Handler.

- [ ] **Step 3: Run the tests, verify they pass**

- [ ] **Step 4: Write and implement `src/app/api/admission-staff-health/route.ts` + its test**

Same shape as Task 3 Step 9, scoped to `requireAdmissionStaffCaller` instead of `requireScannerDeviceCaller`.

- [ ] **Step 5: Check whether `actions.ts` can be deleted entirely**

`grep -rn "admitWalkIn" src/` — if nothing else calls it as a Server Action, delete the file. If something else still imports it, reduce it to only what's still needed and say so in your report.

- [ ] **Step 6: Write the failing form-retry tests**

This form has no existing test file. Review found this codebase's actual convention for component-involving tests outside `src/components/scanner/`'s own exception: `tests/components/*.test.tsx` exist and use React's `renderToStaticMarkup` (from `react-dom/server`), NOT `@testing-library/react` (confirmed absent) and NOT a co-located path. If this page's retry logic needs any test beyond reusing Task 4's already-tested `nextBackoffDelayMs`/`isStaleAttempt` pure functions directly, create `tests/components/walk-in-admission-form.test.tsx` following that `renderToStaticMarkup` convention — check an existing file under `tests/components/` first for its exact shape. If the only logic specific to this file is a thin wrapper around Task 4's already-tested pure functions with nothing independently worth testing, say so explicitly in your report and skip a dedicated test file rather than inventing one for its own sake.

- [ ] **Step 7: Update `walk-in-admission-form.tsx`**

Replace the `admitWalkIn(...)` call and its `try/catch` with a `fetch()`-based call to `/api/admit-walk-in`, implementing the same client-side retry loop as the scanner (health-check poll reusing `nextBackoffDelayMs` from Task 4's `use-scan-retry.ts`, a client-side submission timeout, "Try Now"/"Cancel") as simple local component state (`retrying: boolean` plus refs for `idempotencyKey`/`startedAt`/the stale-response guard — this page has no camera/single-flight concerns requiring the scanner's full reducer). Disable the session-select and identifier-input fields while `retrying`.

- [ ] **Step 8: Run the tests, verify they pass**

- [ ] **Step 9: Add i18n keys**

Reuse Task 4's "Try Now"/"Cancel"/retrying-message keys if they're generic enough (check their namespace — if scoped under `"scanner"`, this page likely needs its own `"walkInAdmission"`-namespaced equivalents instead, matching this page's existing `t('...')` convention; decide and note which in your report).

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/app/api/admit-walk-in/ src/app/api/admission-staff-health/ "src/app/[locale]/(admin)/attendance/walk-in/"
git add src/app/api/admit-walk-in/ src/app/api/admission-staff-health/ "src/app/[locale]/(admin)/attendance/walk-in/" src/messages/en.json src/messages/ar.json
git commit -m "feat: move walk-in admission to a Route Handler with the same auto-retry pattern as the scanner"
```

---

### Task 6: Full sweep and final review

**Files:**
- None new — verification only, fixing anything found.

- [ ] **Step 1: Full relevant-suite run**

Run: `npx vitest run tests/attendance tests/lib/scanner-device tests/lib/admission tests/lib/supabase tests/api/scan-qr-attempt-route.test.ts tests/api/scanner-health-route.test.ts tests/api/admit-walk-in-route.test.ts tests/api/admission-staff-health-route.test.ts src/components/scanner` (every area this sub-project touched — note `src/lib/`/Route Handler tests live under `tests/lib/`/`tests/api/`, while scanner CLIENT-COMPONENT tests are co-located under `src/components/scanner/`, confirmed as this codebase's one real exception to the `tests/` mirror).

- [ ] **Step 2: Full typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/ tests/`. Compare any output against `master`'s pre-existing baseline via `git diff master -- <file>` before dismissing any error as pre-existing (this project has known, pre-existing errors in `tests/attendance/qr-issuance-reservation.test.ts`/`tests/attendance/qr-credentials-lifecycle-trigger.test.ts` — confirm these are the same count/shape as on `master`, not new ones).

- [ ] **Step 3: Verify the Next.js Server-Action-serialization fix actually works end-to-end**

This sub-project's entire premise rests on Route Handlers not queuing the way Server Actions do — verify this isn't just a documented assumption. If a local dev server is reachable in this environment: start it, open the scanner page, and manually confirm that an artificially slow/hung `/api/scan-qr-attempt` request does NOT block a concurrent `/api/scanner-health` request from completing (browser devtools network throttling, or a temporary artificial delay in the route handler, can simulate this). If a local dev server isn't practically reachable here, do a careful code-level trace instead and say so explicitly in your report — do not claim this was verified if it wasn't.

- [ ] **Step 4: Dispatch a final whole-branch code-reviewer subagent**

Covering the full diff against `master`, cross-referencing the spec's three review rounds' worth of fixes AND this plan's own review round specifically: does the idempotency check placement in both functions genuinely run after auth and after the serialization point; does the `unique_violation` backstop's three-way branching wrap the FULL insert sequence (both the conditional `attendance_records` insert and the final `scan_attempts` insert) in the QR path, not just the final insert alone; does the scan Route Handler's layer-2 classification actually check each pre-RPC query's own error before concluding a denial; is `admit_walk_in`'s `PUBLIC` revoke actually present and verified; does `scanQrAttemptConfirmForCaller` still use `toByteaHexOrNull`, not a raw Buffer; is `tests/attendance/scan-qr-attempt-server-boundary.test.ts` still present and passing (not deleted); does the stale-response guard in `use-scan-retry.ts` compare both `idempotencyKey` AND `attemptSeq`, not just one.

- [ ] **Step 5: Proceed to `superpowers:finishing-a-development-branch`**

Push, create a PR (reusing the title/body pattern from prior sub-projects' PRs — this sub-project's branch is `feature/offline-scanning-support`), await merge, clean up the worktree and branch.
