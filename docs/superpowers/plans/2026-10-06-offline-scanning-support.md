# Offline Scanning Support (5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the scanner and the walk-in admission page auto-retry after a lost network response, without ever producing a wrong outcome (double-admission, or a false rejection of someone already admitted) — by replacing their Server Actions with Route Handlers (required because Next.js serializes Server Actions client-side, which would otherwise queue a retry behind a hung original request) and adding server-side idempotency keys.

**Architecture:** Two independent idempotency keys (`scan_attempts.idempotency_key`/`scan_fingerprint` for the QR path, `session_bookings.idempotency_key` for walk-in), each checked immediately after its function's own authorization and serialization point, before any business logic that could misfire on a replay. Both admission paths move from Server Actions to Route Handlers so a retry's `fetch()` never queues behind a hung original request. A three-layer error classification (client-side `fetch()` failure, pre-RPC auth/lookup-query failure, RPC error-code table) distinguishes "retry this" from "stop and tell the operator," since the two shared auth helpers this project touches currently conflate both.

**Tech Stack:** Next.js (App Router, Route Handlers, Client Components), Supabase Postgres (PL/pgSQL migrations), `@supabase/supabase-js`, Vitest (live integration tests against the scratch Supabase project + component tests for the client state machine), next-intl.

**Spec:** `docs/superpowers/specs/2026-10-06-offline-scanning-support-design.md` — read this first; it went through three review rounds and the full rationale for every decision below (including why a queue was rejected, why Server Actions don't work here, and the exact race conditions each check closes) lives there, not repeated here.

**Before starting any task below**: read `supabase/migrations/20261006050000_walk_in_admission.sql` (contains the current `admit_walk_in`, `scan_attempt_transactional`, and `scan_qr_attempt_transactional` bodies — the file whose line numbers the spec cites throughout) and `supabase/migrations/20261006052000_admit_walk_in_shared_advisory_lock.sql` (the actual current `admit_walk_in`, superseding the one in the file above) in full. Also read `src/components/scanner/scanner-client.tsx`, `src/components/scanner/scan-state-machine.ts`, `src/lib/attendance/scan-qr-attempt.ts`, `src/lib/scanner-device/server-helpers.ts`, `src/app/[locale]/(admin)/attendance/walk-in/actions.ts`, `src/app/[locale]/(admin)/attendance/walk-in/walk-in-admission-form.tsx`, and `src/lib/admission/server-helpers.ts` — every task below modifies one or more of these.

---

### Task 0: Fix the two shared auth helpers' transport-vs-denial conflation

**Files:**
- Modify: `src/lib/scanner-device/server-helpers.ts`
- Modify: `src/lib/admission/server-helpers.ts`
- Test: `tests/lib/scanner-device/server-helpers.test.ts` (create if it doesn't exist — check first)
- Test: `tests/lib/admission/server-helpers.test.ts` (create if it doesn't exist — check first)

This is a prerequisite, done first and separately, because both Route Handlers added in later tasks depend on it, and because it's a real, independently-valuable bug fix to two *shared* helpers used by callers beyond this sub-project (fixing it narrowly inside a new Route Handler and leaving the shared helper broken would leave the same bug reachable by every other caller).

**The bug** (identical in both files): `requireScannerDeviceCaller`/`requireAdmissionStaffCaller` query `profiles` for the caller's role, then do `if (error || !profile) throw new Error('Profile not found')` — collapsing "the query itself failed (Supabase unreachable)" and "the query succeeded and found no matching row" into the same thrown message. A caller of either helper cannot distinguish a transport failure from a genuine "this profile doesn't exist," which this sub-project's retry logic depends on being able to tell apart (Architecture — Client Side, layer 2 classification, spec lines 97, 111).

- [ ] **Step 1: Write the failing test for `requireScannerDeviceCaller`**

In `tests/lib/scanner-device/server-helpers.test.ts` (check whether this file already exists first; if a test file for this helper exists under a different name, add to it instead of creating a duplicate):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';

// Mock createClient/createServiceRoleClient so the profiles query can be
// made to return a populated `error` (simulating a transport failure)
// distinctly from a clean "no row" result (`data: null, error: null`).
// Follow this codebase's existing mocking convention for @/lib/supabase/server
// — grep tests/ for an existing mock of createServiceRoleClient first and
// match its exact shape rather than inventing a new one.

it('throws a distinguishable error when the profiles query itself fails (not a clean not-found)', async () => {
  // Arrange: user.getUser() resolves with a real user, but the profiles
  // .select().eq().single() call resolves with { data: null, error: { message: 'fetch failed', code: '' } }
  // Act + Assert: requireScannerDeviceCaller() rejects with an error whose
  // message or a new exported error class/code distinguishes this from
  // the clean-not-found case below.
});

it('still throws "Profile not found" for a genuine empty result (no error, no row)', async () => {
  // Arrange: profiles query resolves with { data: null, error: null }
  // Act + Assert: rejects with the existing 'Profile not found' message —
  // this is the regression check proving the fix didn't change the
  // correct-denial behavior, only added a new distinct case.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/scanner-device/server-helpers.test.ts`
Expected: the first test fails (both cases currently throw the identical `'Profile not found'` message; the test should assert they're distinguishable, which the current code cannot satisfy).

- [ ] **Step 3: Fix `requireScannerDeviceCaller`**

In `src/lib/scanner-device/server-helpers.ts`, change:

```typescript
const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
if (error || !profile) throw new Error('Profile not found');
```

to distinguish the two cases — e.g.:

```typescript
const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
if (error) throw new Error('UPSTREAM_UNREACHABLE: profiles lookup failed');
if (!profile) throw new Error('Profile not found');
```

(Exact message/error-shape choice is yours — pick something the Route Handlers in later tasks can reliably pattern-match on, e.g. a message prefix matching this spec's `'LOCK_CONTENTION: '` convention, or a custom `Error` subclass with a `retryable: boolean` field. Whichever you choose, use the SAME convention in Task 3/5's Route Handlers when they catch this helper's throw, and note your choice in your task report so later tasks don't have to guess.)

Also check `supabase.auth.getUser()`'s own error — this call can itself fail with a transport error distinct from "genuinely not authenticated," and `if (!user) throw new Error('Not authenticated')` has the same conflation. Apply the same fix there (check the destructured `error` from `getUser()` before concluding `!user` means "not authenticated").

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/scanner-device/server-helpers.test.ts`
Expected: both tests pass.

- [ ] **Step 5: Repeat Steps 1-4 for `requireAdmissionStaffCaller`**

Same bug, same fix, in `src/lib/admission/server-helpers.ts` / `tests/lib/admission/server-helpers.test.ts`. Use the identical distinguishing convention you picked in Step 3, so both helpers are consistent.

- [ ] **Step 6: Check existing callers aren't broken**

Both helpers have callers beyond this sub-project (e.g. `src/app/[locale]/(admin)/applications/[id]/actions.ts` likely calls one of these, or similar). Run the full test suite for any file that imports either helper (`grep -rl "requireScannerDeviceCaller\|requireAdmissionStaffCaller" src/` to find them, then run each file's corresponding test) and confirm nothing broke — the "Profile not found" message/behavior for a genuine empty result must be byte-identical to before for every existing caller that doesn't care about the new distinction.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/lib/scanner-device/server-helpers.ts src/lib/admission/server-helpers.ts tests/lib/scanner-device/server-helpers.test.ts tests/lib/admission/server-helpers.test.ts
git add src/lib/scanner-device/server-helpers.ts src/lib/admission/server-helpers.ts tests/lib/scanner-device/server-helpers.test.ts tests/lib/admission/server-helpers.test.ts
git commit -m "fix: distinguish a transport failure from a genuine not-found in requireScannerDeviceCaller/requireAdmissionStaffCaller"
```

---

### Task 1: QR path idempotency migration (`scan_attempts` columns + function changes)

**Files:**
- Create: `supabase/migrations/20261006110000_scan_attempts_idempotency.sql`
- Test: `tests/attendance/scan-qr-idempotency-live.test.ts`

Depends on Task 0 only insofar as it shares this plan's conventions; no code dependency — this task can run in parallel with Task 0 if using subagent-driven-development, since it touches entirely different files.

- [ ] **Step 1: Write the migration**

Read the spec's "Architecture — Server Side" section in full before writing this (lines 24-83) — it has the exact placement, the exact `scan_fingerprint` SQL expression (already corrected for the `extensions.digest`/`uuid_send` issues found in review), and the exact three-way `unique_violation` backstop branching. Do not deviate from the placement order described there (idempotency check AFTER the scanner-scope re-check, inside the advisory lock) — this exact ordering is what closes the race conditions two earlier drafts of the spec got wrong.

```sql
-- 20261006110000_scan_attempts_idempotency.sql
alter table scan_attempts add column idempotency_key uuid;
alter table scan_attempts add column scan_fingerprint bytea;
create unique index scan_attempts_idempotency_key_unique on scan_attempts (idempotency_key) where idempotency_key is not null;

drop function if exists scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean, uuid);
drop function if exists public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid);

create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false,
  p_scanner_user_id uuid default null,
  p_idempotency_key uuid default null,
  p_token_hash bytea default null
) returns scan_attempts as $$
declare
  -- ... all existing declarations from the current body, unchanged ...
  v_scan_fingerprint bytea;
  v_existing scan_attempts%rowtype;
  v_constraint text;
begin
  -- Steps 1-2 (advisory lock loop, scanner-scope re-check) copied
  -- VERBATIM from the current body (20261006050000/20261006052000) --
  -- do not modify their logic, only insert the new step 3 after them.

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

  -- ... existing application/session lookup, full decision tree,
  -- UNCHANGED from the current body (lines 165-258 of 20261006050000) ...

  if v_result in ('admitted', 'flexible_admitted', 'override_admitted') then
    begin
      select id into v_matched_booking_id from session_bookings
      where application_id = p_application_id and session_id = p_session_id and status = 'active';

      insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, device_identifier, booking_id)
      values (p_application_id, p_session_id, p_time_slot_group_key, v_entry_type, p_scanned_by, p_device_identifier, v_matched_booking_id)
      returning id into v_attendance_id;

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
  end if;

  -- Non-admitting results: single insert, no attendance_records row to
  -- protect, so no wrapping block needed beyond the idempotency write
  -- itself.
  insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at, idempotency_key, scan_fingerprint)
  values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, v_result, now(), p_idempotency_key, v_scan_fingerprint)
  returning * into v_scan_attempt;

  return v_scan_attempt;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

Also give the advisory-lock-exhausted `raise exception` its distinguishable prefix (spec line 114):

```sql
raise exception 'LOCK_CONTENTION: Another scan for this session is still being processed after % retries — please retry manually', v_max_retries;
```

Then write `scan_qr_attempt_transactional` (the bridge function) with the added `p_idempotency_key` parameter forwarded through, and its own two unresolved-credential branches (malformed hash, no active credential) each computing `v_scan_fingerprint` the same way and wrapping their own single insert in the same `unique_violation`-with-constraint-check pattern (no advisory lock needed there — see spec step 7, line 55).

Finally, restate every `revoke`/`grant` these functions currently carry (check both migration files for the exact current statements and replicate them against the new signatures).

- [ ] **Step 2: Apply the migration**

Follow this project's established live-apply convention (check `CLAUDE.md` or recent migrations for whether `supabase db push` works directly on this project, or whether the `db query --linked --file` workaround is still required — check this project's own memory/notes before assuming either way). Confirm via `select proname, pg_get_function_arguments(oid) from pg_proc where proname in ('scan_attempt_transactional', 'scan_qr_attempt_transactional')` that both now show the new trailing parameters.

- [ ] **Step 3: Write the failing tests**

Create `tests/attendance/scan-qr-idempotency-live.test.ts`, following the established live-test conventions in `tests/attendance/scan-qr-issuance-reservation.test.ts` or a similar recent live-test file in this directory (runId-suffixed fixtures, service-role admin client, FK-ordered cleanup). Cover spec Testing Requirements 1, 3, 4, 6, 8 (lines 208, 210, 211, 213, 215), 9, 10, 11, 12, 13 (lines 216-220) — each as its own `it(...)`, annotated with the requirement number. Test 12 (the cross-session backstop) is explicitly flagged in the spec as hard to construct reliably — do your best with directly-sequenced SQL (e.g. a raw `db query` call racing two inserts within manually-interleaved transactions) rather than `Promise.all`, and if you cannot make it deterministic, report this honestly as DONE_WITH_CONCERNS rather than deleting or weakening the test.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/attendance/scan-qr-idempotency-live.test.ts`

- [ ] **Step 5: Regression check**

Run the full existing scanner/attendance live suite to confirm nothing broke: `npx vitest run tests/attendance`. Pay particular attention to any existing test calling `scan_attempt_transactional`/`scan_qr_attempt_transactional` directly with the old (shorter) argument list — Postgres function overloading by default-parameter should keep these working unchanged, but confirm rather than assume.

- [ ] **Step 6: Regenerate database types**

Run the project's established type-regeneration command (check recent migrations/plans for the exact invocation — likely `npx supabase gen types typescript --linked`), diff against `src/types/database.ts` to confirm the diff is purely additive, replace the file.

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

Can run in parallel with Task 1 (different tables/functions, independent).

- [ ] **Step 1: Write the migration**

Read the spec's walk-in placement section (lines 37-44) and the security-fix paragraph (line 63) in full before writing. The security fix (bare `is_staff()` → `coalesce(is_staff(), false)`, plus the missing `revoke ... from public`) rides along in this same migration since it already drops/recreates this function.

```sql
-- 20261006120000_admit_walk_in_idempotency.sql
alter table session_bookings add column idempotency_key uuid;
create unique index session_bookings_idempotency_key_unique on session_bookings (idempotency_key) where idempotency_key is not null;

drop function if exists admit_walk_in(uuid, uuid);

create or replace function admit_walk_in(
  p_application_id uuid,
  p_session_id     uuid,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_session      sessions%rowtype;
  v_admitted     int;
  v_booking_id   uuid;
  v_existing     session_bookings%rowtype;
  v_constraint   text;
begin
  if not coalesce(is_staff(), false) then
    raise exception 'Not authorized';
  end if;

  if not exists (select 1 from applications where id = p_application_id and status = 'accepted') then
    raise exception 'Application not found or not accepted';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status <> 'confirmed' then
    raise exception 'Session is not open for admission';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_session_id::text));

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

  select count(*) into v_admitted
  from attendance_records where session_id = p_session_id and status = 'admitted';
  if v_admitted >= v_session.capacity then
    raise exception 'Session is at capacity';
  end if;

  if exists (
    select 1 from session_bookings
    where application_id = p_application_id and session_id = p_session_id and status = 'active'
  ) then
    raise exception 'This participant already has a booking for this session';
  end if;

  if exists (
    select 1 from attendance_records
    where application_id = p_application_id and session_id = p_session_id and status = 'admitted'
  ) then
    raise exception 'This participant has already been admitted to this session';
  end if;

  begin
    insert into session_bookings (application_id, session_id, source, idempotency_key)
    values (p_application_id, p_session_id, 'walk_in', p_idempotency_key)
    returning id into v_booking_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'session_bookings_active_unique' then
      raise;
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

  begin
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, booking_id)
    values (p_application_id, p_session_id, compute_time_slot_group_key_for_session(p_session_id), 'walk_in', auth.uid(), v_booking_id);
  exception when unique_violation then
    raise exception 'This participant has already been admitted to this session';
  end;

  return v_booking_id;
end;
$$;

grant execute on function admit_walk_in(uuid, uuid, uuid) to authenticated;
revoke execute on function admit_walk_in(uuid, uuid, uuid) from public;
```

(Double-check the exact current column list/constraint names for `session_bookings_active_unique` and `attendance_records_no_duplicate_active` against the live schema before finalizing — the SQL above is written from the spec's description, not copy-pasted from a live `\d` dump.)

- [ ] **Step 2: Apply the migration**

Same convention as Task 1 Step 2. Verify the security fix specifically: `select has_function_privilege('anon', 'admit_walk_in(uuid,uuid,uuid)', 'execute')` must return `false`.

- [ ] **Step 3: Write the failing tests**

Create `tests/attendance/admit-walk-in-idempotency-live.test.ts`, covering spec Testing Requirements 2, 4, 5, 7 (lines 209, 211, 212, 214) — test 7 specifically needs BOTH the non-staff-signed-in-user case AND the anon-key-no-session case as two separate assertions, per the spec's explicit callout that the bare `is_staff()` form would only catch the first.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run tests/attendance/admit-walk-in-idempotency-live.test.ts`

- [ ] **Step 5: Regression check, type regen, typecheck, lint, commit**

Same pattern as Task 1 Steps 5-7.

```bash
git add supabase/migrations/20261006120000_admit_walk_in_idempotency.sql tests/attendance/admit-walk-in-idempotency-live.test.ts src/types/database.ts
git commit -m "feat: add idempotency key to admit_walk_in, fix is_staff() NULL-bypass and missing PUBLIC revoke"
```

---

### Task 3: Scanner Route Handlers (`/api/scan-qr-attempt`, `/api/scanner-health`)

**Files:**
- Create: `src/app/api/scan-qr-attempt/route.ts`
- Create: `src/app/api/scanner-health/route.ts`
- Modify: `src/lib/attendance/scan-qr-attempt.ts` (remove the now-superseded Server Action export; keep/adapt the module-private helpers if still needed)
- Test: `tests/attendance/scan-qr-attempt-route.test.ts`

Depends on Task 0 (the fixed auth helpers) and Task 1 (the new RPC parameters). Read spec lines 85-186 in full before starting — this task implements the entire three-layer classification scheme and both response-code schemes described there.

- [ ] **Step 1: Write the failing tests for the scan Route Handler**

Create `tests/attendance/scan-qr-attempt-route.test.ts`. This can mock the Supabase calls (unlike Task 1/2's live DB tests) since the goal here is testing the Route Handler's own classification logic, not the RPC's. Cover Testing Requirements 10, 11 (lines 217-218) directly: a mocked RPC error with the `'LOCK_CONTENTION: '` prefix → `{ ok: false, retryable: true, reason: 'lock-contention' }`; a mocked scope-check failure (populated `error`, not a clean empty result) → `{ ok: false, retryable: true, reason: 'upstream-unreachable' }`; a mocked clean "no matching scope" → `{ ok: false, retryable: false }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/attendance/scan-qr-attempt-route.test.ts` — expected: fails, since `route.ts` doesn't exist yet.

- [ ] **Step 3: Write `src/app/api/scan-qr-attempt/route.ts`**

Port `scanQrAttemptConfirmForCaller`'s logic from `src/lib/attendance/scan-qr-attempt.ts` into this file's `POST` handler, following `src/app/api/admin/reports/participants-csv/route.ts`'s auth pattern (read it first for the exact `createClient()`/`createServiceRoleClient()` shape). Apply the full layer-2/layer-3 classification from spec lines 108-116:

```typescript
// src/app/api/scan-qr-attempt/route.ts
import { NextResponse } from 'next/server';
// ... imports mirroring scan-qr-attempt.ts's current ones, plus the
// fixed requireScannerDeviceCaller from Task 0 ...

export async function POST(request: Request) {
  const body = await request.json(); // { qrPayload, sessionId, deviceIdentifier, idempotencyKey }

  let caller;
  try {
    caller = await requireScannerDeviceCaller();
  } catch (err) {
    // Task 0's fix lets you distinguish here -- route the
    // upstream-unreachable case to retryable:true, everything else to
    // retryable:false/401-shaped.
  }

  // verifyScannerScope equivalent, inlined, with BOTH queries checking
  // their own `error` before concluding "not found"/"not authorized"
  // (spec line 111) -- this is the layer-2 fix, do not skip it by
  // copying the old verifyScannerScope's logic verbatim.

  // parseCanonicalQrPayload/hashQrToken unchanged.

  const { data, error } = await service.rpc('scan_qr_attempt_transactional', {
    p_token_hash: tokenHash,
    p_session_id: sessionId,
    p_scanned_by: caller.userId,
    p_device_identifier: deviceIdentifier,
    p_scanner_user_id: caller.userId,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    // Layer-3 classification table from spec lines 112-116, exactly as
    // written there -- implement the full code list, not just the
    // two cases the tests above check.
  }

  const applicationId = data.application_id;
  const participantSummary = applicationId ? await getScannerParticipantSummary(service, applicationId) : null;

  return NextResponse.json({
    ok: true,
    result: { result: data.result, scanAttemptId: data.id, attendanceId: data.resulting_attendance_id, participantSummary },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/attendance/scan-qr-attempt-route.test.ts`

- [ ] **Step 5: Write `src/app/api/scanner-health/route.ts`**

```typescript
// src/app/api/scanner-health/route.ts
export async function GET() {
  let caller;
  try {
    caller = await requireScannerDeviceCaller();
  } catch (err) {
    // Distinguish via Task 0's fix: upstream-unreachable -> 503, genuine
    // auth denial -> 401. See spec lines 176-180.
  }

  const { error } = await caller.service.from('scan_attempts').select('id', { head: true }).limit(0);
  if (error) return new Response(null, { status: 503 });

  return new Response(null, { status: 200 });
}
```

- [ ] **Step 6: Write a test for the health-check route**

Add to the same test file or a sibling `tests/attendance/scanner-health-route.test.ts` — cover Testing Requirement 21 (line 228): a mocked auth-helper failure with the upstream-unreachable shape returns 503, not 401.

- [ ] **Step 7: Remove the superseded Server Action**

In `src/lib/attendance/scan-qr-attempt.ts`, remove the exported `scanQrAttemptConfirm`/`scanQrAttemptConfirmForCaller` functions (now living in the Route Handler) and the `'use server'` directive if nothing else in the file still needs it. Keep `verifyScannerScope` only if the Route Handler doesn't fully inline it — your choice, but if you keep this file at all, update its header comment (it currently describes itself as "the trusted Next.js server boundary for QR-based scanner submission," which is no longer accurate once that boundary is the Route Handler).

- [ ] **Step 8: Check for other callers of the removed exports**

`grep -rn "scanQrAttemptConfirm" src/` — update any other call site (there may be none beyond `scanner-client.tsx`, which Task 4 updates).

- [ ] **Step 9: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/app/api/scan-qr-attempt/route.ts src/app/api/scanner-health/route.ts src/lib/attendance/scan-qr-attempt.ts tests/attendance/scan-qr-attempt-route.test.ts
git add src/app/api/scan-qr-attempt/route.ts src/app/api/scanner-health/route.ts src/lib/attendance/scan-qr-attempt.ts tests/attendance/scan-qr-attempt-route.test.ts
git commit -m "feat: move scan-qr-attempt submission and health check from Server Actions to Route Handlers"
```

---

### Task 4: Scanner client — state machine, retry loop, UI

**Files:**
- Modify: `src/components/scanner/scan-state-machine.ts`
- Modify: `src/components/scanner/scanner-client.tsx`
- Create: `src/components/scanner/use-scan-retry.ts` (new hook — extracts the poll/retry/health-check logic out of `scanner-client.tsx` so that file doesn't grow unmanageably; follows this directory's existing pattern of small, focused hooks like `use-network-status.ts`/`use-service-worker.ts`)
- Modify: `tests/components/scanner/scan-state-machine.test.ts` (or wherever this currently lives — check first)
- Create: `tests/components/scanner/use-scan-retry.test.ts`

Depends on Task 3 (the Route Handlers this hook calls). Read spec lines 120-186 in full before starting.

- [ ] **Step 1: Write the failing state-machine tests**

Update the existing state-machine test file: fix every bare `{ type: 'SUBMIT_START' }` dispatch to supply the new required fields (spec line 152), and add new tests for the `retrying` state's transitions (`SUBMIT_TRANSPORT_FAILURE`, `SUBMIT_REJECTED`, `RETRY_ATTEMPT`, `CANCEL_RETRY`) per the type definitions at spec lines 124-138. Cover Testing Requirements 16, 17, 19 (lines 223, 224, 226) as pure-reducer assertions (no DOM/network needed — this file has zero dependencies per its own design).

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run` against the state-machine test file.

- [ ] **Step 3: Update `scan-state-machine.ts`**

Add the new `ScanState`/`ScanAction` variants exactly as specified at spec lines 124-138, plus the `lastRejection` sibling state (line 144) — decide during this step whether `lastRejection` lives inside this reducer's state or as separate `useState` in the component (the spec suggests "alongside, not inside" the reducer's own state; if you keep it fully separate, document that choice in your report rather than silently picking one).

- [ ] **Step 4: Run the tests, verify they pass**

- [ ] **Step 5: Decide and implement the offline-short-circuit handling**

Spec line 150 flags this as an explicit open decision for implementation: either thread a throwaway `idempotencyKey` through the existing `SUBMIT_START`→`SUBMIT_ERROR` offline-blocked path, or add a new `OFFLINE_BLOCKED` action bypassing `SUBMIT_START` entirely. Pick one, implement it, and write a test confirming the offline-detected-at-scan-time path still works (this is pre-existing behavior from Phase 7E — don't lose it; this is a straightforward regression check).

- [ ] **Step 6: Write `use-scan-retry.ts`**

This hook owns: the health-check poll (2s→10s backoff per spec line 162), the `online` event listener, the "Try Now" trigger, the submission `fetch()` with its own `AbortController` timeout (~8s), the stale-response guard (ref holding `idempotencyKey`+`attemptSeq`, spec line 156), and dispatches the appropriate `ScanAction` based on the three-layer classification (spec lines 108-117, now split across client-side `fetch()` handling here and the Route Handler's own layer-2/3 work from Task 3). Expose a small interface to `scanner-client.tsx` — something like `{ submit(qrPayload, deviceIdentifier), retryNow(), cancel() }` plus the dispatched actions flowing through the existing reducer.

- [ ] **Step 7: Write `use-scan-retry.test.ts`**

Cover Testing Requirements 14, 15, 18 (lines 221, 222, 225) — component/hook-level tests (e.g. `@testing-library/react`'s `renderHook`, mocking `fetch` globally) for: a non-retryable rejection going straight to a terminal state without entering `retrying`; a `fetch()` rejection being classified identically to a parsed `{ok:false, retryable:true}` body; `startedAt` surviving a `retrying → submitting → retrying` cycle.

- [ ] **Step 8: Wire `use-scan-retry` into `scanner-client.tsx`**

Replace the existing `scanQrAttemptConfirm(...).then(...).catch(...)` call (today's lines ~148-175) with calls into the new hook. Implement the "Try Now"/"Cancel" buttons and the 30-second persistent message (spec line 169), the camera-resume-on-cancel requirement (spec line 158 — must be a synchronous call inside the Cancel button's own click handler, not deferred into an effect), and the single-flight extension (spec line 154 — verify, don't just assume, that the existing `DETECT`-is-a-no-op-unless-ready guard genuinely covers the new `retrying` state once it's added to the reducer).

- [ ] **Step 9: Add/update i18n keys**

Add new keys for "Connection lost — retrying…", "Try Now", "Cancel", and the 30-second persistent message, in both `en.json` and `ar.json`, following this project's existing scanner-namespace conventions (check `src/messages/en.json`'s `"scanner"` namespace for the existing `offlineBlocked`/`uncertain`/`server` keys' style).

- [ ] **Step 10: Manual/code-trace verification**

Browser verification may not be practical in this environment. Do a careful code-level trace: confirm the camera-resume-on-cancel call is genuinely synchronous within the click handler (not wrapped in a `.then()` or effect), confirm the stale-response guard is checked in every dispatch path the hook has (not just the success path), confirm the 30-second timer doesn't reset across a `RETRY_ATTEMPT`. State this trace explicitly in your report.

- [ ] **Step 11: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/components/scanner/ tests/components/scanner/
git add src/components/scanner/ tests/components/scanner/ src/messages/en.json src/messages/ar.json
git commit -m "feat: add retrying state and auto-retry loop to the scanner client"
```

---

### Task 5: Walk-in Route Handlers + form retry UI

**Files:**
- Create: `src/app/api/admit-walk-in/route.ts`
- Create: `src/app/api/admission-staff-health/route.ts`
- Delete or gut: `src/app/[locale]/(admin)/attendance/walk-in/actions.ts` (logic moves to the Route Handler)
- Modify: `src/app/[locale]/(admin)/attendance/walk-in/walk-in-admission-form.tsx`
- Test: `tests/attendance/admit-walk-in-route.test.ts`
- Test: `tests/components/walk-in/walk-in-admission-form.test.tsx` (create if a component-test convention/location doesn't already exist for this page — check first)

Depends on Task 0 and Task 2. Mirrors Task 3/4's shape for the simpler walk-in page — read spec lines 187-196 in full before starting.

- [ ] **Step 1: Write the failing Route Handler tests**

Create `tests/attendance/admit-walk-in-route.test.ts`, mirroring Task 3 Step 1's structure but for the walk-in shape (`{ ok: true, bookingId } | { ok: false, retryable, message }`).

- [ ] **Step 2: Write `src/app/api/admit-walk-in/route.ts`**

Port the identifier-resolution logic and RPC call currently in `actions.ts`'s `admitWalkIn` into this handler's `POST`, applying the same layer-2/layer-3 classification as Task 3 (the identifier-lookup query checking its own `error`, per spec line 192).

- [ ] **Step 3: Run the tests, verify they pass**

- [ ] **Step 4: Write `src/app/api/admission-staff-health/route.ts`**

Same shape as Task 3 Step 5, scoped to the (now-fixed, from Task 0) `requireAdmissionStaffCaller`.

- [ ] **Step 5: Remove/gut `actions.ts`**

If nothing else calls `admitWalkIn` as a Server Action (confirm via `grep -rn "admitWalkIn" src/`), delete the file or reduce it to whatever (if anything) genuinely still needs to be a Server Action on this page.

- [ ] **Step 6: Write the failing form-retry tests**

Create a component test covering Testing Requirement 20 (line 227): a retried submission after a simulated transport failure reuses the same `idempotencyKey`, and the session-select/identifier-input fields are disabled while retrying.

- [ ] **Step 7: Update `walk-in-admission-form.tsx`**

Replace the `admitWalkIn(...)` call and its `try/catch` with a `fetch()`-based call to the new Route Handler, implementing the same client-side retry loop (health-check poll, timeout, "Try Now"/"Cancel") as the scanner's `use-scan-retry.ts` — but as simpler local component state (a `retrying: boolean` plus refs, per spec line 194; this page doesn't need the scanner's full reducer). Disable the session/identifier inputs while `retrying`.

- [ ] **Step 8: Run the tests, verify they pass**

- [ ] **Step 9: Add i18n keys**

Same retry-UI copy as the scanner (spec line 194 says "same 'Try Now'/'Cancel' affordances") — check whether these can reuse the scanner's namespace keys from Task 4 Step 9, or need a `walkInAdmission`-namespaced equivalent, matching this page's existing `t('...')` namespace convention.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/app/api/admit-walk-in/ src/app/api/admission-staff-health/ "src/app/[locale]/(admin)/attendance/walk-in/" tests/attendance/admit-walk-in-route.test.ts
git add src/app/api/admit-walk-in/ src/app/api/admission-staff-health/ "src/app/[locale]/(admin)/attendance/walk-in/" tests/attendance/admit-walk-in-route.test.ts tests/components/walk-in/ src/messages/en.json src/messages/ar.json
git commit -m "feat: move walk-in admission to a Route Handler with the same auto-retry pattern as the scanner"
```

---

### Task 6: Full sweep and final review

**Files:**
- None new — verification only, fixing anything found.

- [ ] **Step 1: Full relevant-suite run**

Run: `npx vitest run tests/attendance tests/components/scanner tests/components/walk-in tests/lib/scanner-device tests/lib/admission` (every area this sub-project touched).

- [ ] **Step 2: Full typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/ tests/`. Compare any output against `master`'s pre-existing baseline — verify via `git diff master -- <file>` that any file showing errors was genuinely untouched by this branch before dismissing it (this project has known pre-existing errors in `tests/attendance/qr-issuance-reservation.test.ts`/`tests/attendance/qr-credentials-lifecycle-trigger.test.ts` — confirm these are the same count/shape as on `master`, not new ones).

- [ ] **Step 3: Verify the Next.js Server-Action-serialization fix actually works end-to-end**

This sub-project's entire premise rests on Route Handlers not queuing the way Server Actions do — verify this isn't just a documented assumption. If a local dev server is reachable in this environment: start it, open the scanner page, and manually confirm that triggering a slow/hung `/api/scan-qr-attempt` request (e.g. via browser devtools network throttling, or a temporary artificial delay) does NOT block a concurrent `/api/scanner-health` request from completing. If a local dev server isn't practically reachable here, do a careful code-level trace instead and say so explicitly in your report — do not claim this was verified if it wasn't.

- [ ] **Step 4: Dispatch a final whole-branch code-reviewer subagent**

Covering the full diff against `master`, cross-referencing the spec's three review rounds' worth of fixes specifically: does the idempotency check placement in both functions genuinely run after auth and after the serialization point (re-verify against the final committed SQL, not the spec's sketch); does the `unique_violation` backstop's three-way branching actually distinguish the three cases correctly; does the scan Route Handler's layer-2 classification actually check the scope-verification query's own error before concluding "not authorized"; is `admit_walk_in`'s `PUBLIC` revoke actually present and verified; does the stale-response guard in `use-scan-retry.ts` actually use `attemptSeq`, not just `idempotencyKey`.

- [ ] **Step 5: Proceed to `superpowers:finishing-a-development-branch`**

Push, create a PR (reusing the title/body pattern from prior sub-projects' PRs — this sub-project's branch is `feature/offline-scanning-support`), await merge, clean up the worktree and branch.
