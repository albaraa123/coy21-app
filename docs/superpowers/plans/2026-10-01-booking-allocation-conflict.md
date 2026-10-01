# Booking/Allocation Conflict Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `book_session()` rejects bookings that time-conflict with a confirmed allocation assignment, and counts confirmed allocation assignments toward a session's capacity — closing the gap where two fully-isolated systems (self-service booking and admin-run allocation) could double-book a participant or jointly overshoot a session's capacity without either system noticing.

**Architecture:** One migration adds two small helper SQL functions (`session_effective_occupied_count`, `session_allocation_confirmed_counts`) and replaces `book_session()` with a version that adds one capacity-check swap and one new conflict-check block, otherwise unchanged. The participant-facing booking-browse page calls the new count RPC to keep its displayed "spots left" consistent with what `book_session()` will actually enforce. A read-only diagnostic SQL script (not a migration) lets the team find any pre-existing conflicts created before this fix existed. The allocation algorithm itself is not touched — this is a one-directional fix.

**Tech Stack:** Supabase Postgres (PL/pgSQL `SECURITY DEFINER` functions), Next.js Server Components, Vitest live tests.

**Reference spec:** `docs/superpowers/specs/2026-10-01-booking-allocation-conflict-design.md`

---

### Task 1: Migration — new count functions + updated `book_session()`

**Files:**
- Create: `supabase/migrations/20261003000000_book_session_respects_allocation.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20261003000000_book_session_respects_allocation.sql
--
-- Closes the gap between the two independent systems that can place a
-- participant into a session: self-service booking (session_bookings,
-- this file's book_session()) and admin-run allocation
-- (allocation_assignments). Until now, neither system was aware of the
-- other's occupancy of a session -- a participant could be allocated to a
-- mandatory session by the algorithm, then separately self-book a
-- time-conflicting elective session, with neither system's capacity
-- counter reflecting the other's rows. This is a one-directional fix:
-- book_session() now respects existing CONFIRMED allocation assignments.
-- The allocation algorithm itself (src/lib/allocation/run-allocation.ts)
-- is unchanged and stays blind to session_bookings -- see
-- docs/superpowers/specs/2026-10-01-booking-allocation-conflict-design.md
-- for the full scope decision and rationale.

-- ---------------------------------------------------------------------------
-- 1. Combined occupancy count: session_bookings (active) + allocation_assignments (confirmed)
-- ---------------------------------------------------------------------------

create function session_effective_occupied_count(p_session_id uuid) returns int
language sql stable as $$
  select
    (select count(*)::int from session_bookings where session_id = p_session_id and status = 'active')
    +
    (select count(*)::int from allocation_assignments where session_id = p_session_id and status = 'confirmed');
$$;

-- ---------------------------------------------------------------------------
-- 2. Aggregate-only confirmed-allocation counts per session, for the
--    participant-facing browse page (which has no RLS access to
--    allocation_assignments directly -- staff-only is_staff() policy).
--    Returns counts only, never individual assignment/participant data.
-- ---------------------------------------------------------------------------

create function session_allocation_confirmed_counts() returns table(session_id uuid, confirmed_count int)
language sql stable security definer set search_path = public, pg_temp as $$
  select session_id, count(*)::int as confirmed_count
  from allocation_assignments
  where status = 'confirmed'
  group by session_id;
$$;

revoke execute on function session_allocation_confirmed_counts() from public;
grant execute on function session_allocation_confirmed_counts() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. book_session(): combined capacity check + new allocation-conflict check.
--    Everything else (authorization, row lock, status check, deadline
--    check, the existing session_bookings-vs-session_bookings conflict
--    check, the final insert) is unchanged from the original definition in
--    20260823020000_session_bookings.sql.
-- ---------------------------------------------------------------------------

create or replace function book_session(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session       sessions%rowtype;
  v_booking_id    uuid;
  v_count         int;
  v_deadline      timestamptz;
begin
  -- Caller must own this application
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  -- Lock the session row to prevent race on capacity
  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status not in ('published', 'confirmed') then
    raise exception 'Session is not open for booking';
  end if;

  v_deadline := coalesce(v_session.booking_deadline, v_session.start_time - interval '3 hours');
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  -- Capacity check (now combined: session_bookings + confirmed allocation_assignments)
  v_count := session_effective_occupied_count(p_session_id);
  if v_count >= v_session.capacity then
    raise exception 'Session is full';
  end if;

  -- Conflict check: any active booking for this participant that overlaps?
  if exists (
    select 1
    from session_bookings sb
    join sessions s on s.id = sb.session_id
    where sb.application_id = p_application_id
      and sb.status = 'active'
      and tstzrange(s.start_time, s.end_time, '[)') &&
          tstzrange(v_session.start_time, v_session.end_time, '[)')
  ) then
    raise exception 'Time conflict with an existing booking';
  end if;

  -- NEW: conflict check against this participant's confirmed allocation assignments
  if exists (
    select 1
    from allocation_assignments aa
    join sessions s on s.id = aa.session_id
    where aa.application_id = p_application_id
      and aa.status = 'confirmed'
      and tstzrange(s.start_time, s.end_time, '[)') &&
          tstzrange(v_session.start_time, v_session.end_time, '[)')
  ) then
    raise exception 'Time conflict with an assigned session';
  end if;

  insert into session_bookings (application_id, session_id)
  values (p_application_id, p_session_id)
  returning id into v_booking_id;

  return v_booking_id;
end;
$$;

grant execute on function book_session(uuid, uuid) to authenticated;
```

- [ ] **Step 2: Confirm the scratch project is linked, then apply the migration**

Run: `cat supabase/.temp/linked-project.json`
Expected: `"ref":"jgsuguohtjqurnshagup"` (`coy21-dev-scratch3`). **Do not proceed if any other ref appears.** If the file doesn't exist in this worktree, the worktree needs linking first — report NEEDS_CONTEXT rather than guessing at credentials.

Run: `npx supabase db push`
Expected: migration applies cleanly with no errors.

- [ ] **Step 3: Smoke-check the new functions exist and are callable**

Run (adjust connection details to match how other live tests in this repo connect, e.g. via a quick Node script using `@supabase/supabase-js` with the service-role key from `.env.local`):
```ts
const { data, error } = await admin.rpc('session_allocation_confirmed_counts');
console.log({ data, error });
```
Expected: `error` is `null`, `data` is an array (likely empty on a freshly-reset scratch project — that's fine, it just means no confirmed allocation_assignments exist yet).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261003000000_book_session_respects_allocation.sql
git commit -m "feat: book_session() respects confirmed allocation assignments

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Live tests for the new `book_session()` behavior

**Context:** No live test file exists yet for `session_bookings`/`book_session()` at all (checked — `tests/agenda/` and `tests/allocation/` have no existing coverage of this RPC). This task adds the first such coverage, scoped to exactly what Task 1 changed. Fixture pattern follows `tests/allocation/priority-pool-validation-live.test.ts`'s conventions (`runId`-suffixed emails/codes for collision-proofing, `beforeAll`/`afterAll`, FK-ordered cleanup) but builds `allocation_runs`/`allocation_assignments` fixture rows via direct `insert()` rather than running the real `runAllocation()` algorithm — this test is about `book_session()`'s SQL logic in isolation, not the allocation algorithm's behavior, so a direct insert is simpler, faster, and doesn't couple this test to algorithm internals.

**Files:**
- Create: `tests/agenda/booking-allocation-conflict-live.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/agenda/booking-allocation-conflict-live.test.ts
//
// Live coverage for book_session()'s new allocation-awareness (added in
// 20261003000000_book_session_respects_allocation.sql): it must reject a
// booking that time-conflicts with a CONFIRMED allocation_assignments row
// for the same participant, and must count confirmed allocation_assignments
// toward a session's capacity alongside active session_bookings. A
// 'proposed' (not yet confirmed) assignment must NOT block a booking or
// count toward capacity -- only 'confirmed' does.
//
// Runs against the live scratch Supabase project -- not isolated from
// other test data; see tests/allocation/priority-pool-validation-live.test.ts
// for the same pattern this file follows.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set to run this live test');
}
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const DAY = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let staffId: string;
let featureExtractionRunId: string;
let allocationRunId: string;

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];

async function seedAcceptedApplicant(emailSlug: string): Promise<string> {
  const { data: user } = await admin.auth.admin.createUser({
    email: `booking-alloc-conflict-live-${runId}-${emailSlug}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  const applicantId = user!.user!.id;
  applicantUserIds.push(applicantId);

  const { data: app } = await admin
    .from('applications')
    .insert({
      applicant_id: applicantId,
      status: 'accepted',
      preferred_language: 'ar',
      experience_level: 'beginner',
      interests: [],
    })
    .select('id')
    .single();
  applicationIds.push(app!.id);
  return app!.id;
}

async function seedSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  const { data } = await admin
    .from('sessions')
    .insert({
      session_code: `BALC-${codeSlug}-${runId}`,
      title_ar: 'جلسة اختبار',
      title_en: 'Test Session',
      conference_day_id: conferenceDayId,
      start_time: `${DAY}T09:00:00+03:00`,
      end_time: `${DAY}T10:00:00+03:00`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: roomId,
      language: 'en',
      difficulty_level: 'beginner',
      capacity: 2,
      min_capacity: 0,
      status: 'confirmed',
      ...overrides,
    })
    .select('id')
    .single();
  sessionIds.push(data!.id);
  return data!.id as string;
}

async function insertAllocationAssignment(applicationId: string, sessionId: string, status: 'proposed' | 'confirmed') {
  const { data, error } = await admin
    .from('allocation_assignments')
    .insert({
      allocation_run_id: allocationRunId,
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: `slot-${sessionId}`,
      suitability_score: 0.9,
      status,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to seed allocation_assignments: ${error.message}`);
  return data!.id as string;
}

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: `booking-alloc-conflict-live-${runId}-staff@test.local`, password: 'password123', email_confirm: true });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day } = await admin.from('conference_days').insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: room } = await admin.from('rooms').insert({ code: `BALC-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 }).select('id').single();
  roomId = room!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `BALC-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sType } = await admin.from('session_types').insert({ code: `BALC-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sType!.id;

  const { data: extraction } = await admin
    .from('feature_extraction_runs')
    .insert({ rules_version: 1, application_count: 0, run_by: staffId })
    .select('id')
    .single();
  featureExtractionRunId = extraction!.id;

  const { data: run } = await admin
    .from('allocation_runs')
    .insert({ feature_extraction_run_id: featureExtractionRunId, run_by: staffId, status: 'draft' })
    .select('id')
    .single();
  allocationRunId = run!.id;
});

afterAll(async () => {
  await admin.from('allocation_assignments').delete().eq('allocation_run_id', allocationRunId);
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('feature_extraction_runs').delete().eq('id', featureExtractionRunId);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
  await admin.from('sessions').delete().in('id', sessionIds);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of [...applicantUserIds, staffId]) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe('book_session() respects confirmed allocation_assignments', () => {
  it('rejects a booking that time-conflicts with a CONFIRMED allocation assignment', async () => {
    const applicationId = await seedAcceptedApplicant('conflict-confirmed');
    const assignedSessionId = await seedSession('assigned-1');
    const bookableSessionId = await seedSession('bookable-1'); // same default 09:00-10:00 window -> overlaps
    await insertAllocationAssignment(applicationId, assignedSessionId, 'confirmed');

    const { error } = await admin.rpc('book_session', { p_application_id: applicationId, p_session_id: bookableSessionId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Time conflict with an assigned session');
  });

  it('allows a booking that time-conflicts with only a PROPOSED (not confirmed) allocation assignment', async () => {
    const applicationId = await seedAcceptedApplicant('conflict-proposed');
    const assignedSessionId = await seedSession('assigned-2');
    const bookableSessionId = await seedSession('bookable-2');
    await insertAllocationAssignment(applicationId, assignedSessionId, 'proposed');

    const { error } = await admin.rpc('book_session', { p_application_id: applicationId, p_session_id: bookableSessionId });
    expect(error).toBeNull();
  });

  it('counts confirmed allocation_assignments toward capacity, rejecting once combined occupancy reaches it', async () => {
    // capacity=2 session; fill it with 1 confirmed allocation_assignment + 1 active session_booking,
    // then a third participant's booking attempt must be rejected as full.
    const sessionId = await seedSession('capacity-1', { capacity: 2 });
    const allocatedApplicantId = await seedAcceptedApplicant('capacity-allocated');
    const bookedApplicantId = await seedAcceptedApplicant('capacity-booked');
    const thirdApplicantId = await seedAcceptedApplicant('capacity-third');

    await insertAllocationAssignment(allocatedApplicantId, sessionId, 'confirmed');
    const { error: firstBookingError } = await admin.rpc('book_session', { p_application_id: bookedApplicantId, p_session_id: sessionId });
    expect(firstBookingError).toBeNull(); // 1 confirmed allocation + this booking = 2, still fits capacity=2

    const { error: thirdError } = await admin.rpc('book_session', { p_application_id: thirdApplicantId, p_session_id: sessionId });
    expect(thirdError).not.toBeNull();
    expect(thirdError?.message).toContain('Session is full');
  });

  it('still succeeds for a session with zero allocation assignments at all (no regression)', async () => {
    const applicationId = await seedAcceptedApplicant('no-allocation');
    const sessionId = await seedSession('no-allocation-session');

    const { data, error } = await admin.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
  });
});

describe('session_allocation_confirmed_counts()', () => {
  it('returns correct per-session aggregate counts and is callable without staff privileges', async () => {
    const applicationId = await seedAcceptedApplicant('agg-count');
    const sessionId = await seedSession('agg-count-session');
    await insertAllocationAssignment(applicationId, sessionId, 'confirmed');

    const { data, error } = await admin.rpc('session_allocation_confirmed_counts');
    expect(error).toBeNull();
    const row = (data ?? []).find((r: { session_id: string; confirmed_count: number }) => r.session_id === sessionId);
    expect(row?.confirmed_count).toBe(1);
  });

  it('is callable by a real participant session (authenticated grant works end-to-end, not just via service_role)', async () => {
    // A real sign-in, not the service-role client -- proves the function's
    // `grant execute ... to authenticated` actually works for a genuine
    // participant JWT, which is the only thing that matters (an
    // introspection query against pg_catalog would only prove the grant
    // statement ran, not that PostgREST/RLS actually honors it end-to-end).
    // Follows the exact sign-in pattern established in
    // tests/allocation/authorization.test.ts.
    const applicationId = await seedAcceptedApplicant('grant-check');
    const sessionId = await seedSession('grant-check-session');
    await insertAllocationAssignment(applicationId, sessionId, 'confirmed');

    const email = `booking-alloc-conflict-live-${runId}-grant-check@test.local`;
    const participantClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { error: signInError } = await participantClient.auth.signInWithPassword({ email, password: 'password123' });
    expect(signInError).toBeNull();

    const { data, error } = await participantClient.rpc('session_allocation_confirmed_counts');
    expect(error).toBeNull();
    const row = (data ?? []).find((r: { session_id: string; confirmed_count: number }) => r.session_id === sessionId);
    expect(row?.confirmed_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/agenda/booking-allocation-conflict-live.test.ts`
Expected: all 7 tests pass (4 in the first `describe`, 3 in the second — the second `describe`'s last test signs in as a real participant via `NEXT_PUBLIC_SUPABASE_ANON_KEY` + `signInWithPassword`, confirm this env var is present in this worktree's `.env.local`; it's the same anon key used throughout the existing test suite, e.g. `tests/allocation/authorization.test.ts`, so it should already be set).

- [ ] **Step 3: Self-review**

Confirm: all 6 tests pass, `afterAll` cleanup leaves no orphaned rows (spot-check by re-running the suite twice in a row with no failures — collision-proofing via `runId` should make this safe).

- [ ] **Step 4: Commit**

```bash
git add tests/agenda/booking-allocation-conflict-live.test.ts
git commit -m "test: live coverage for book_session()'s allocation-awareness

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Capacity display fix — `/my-agenda/browse`

**Context:** `src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx` currently builds `countMap` from `session_bookings` only. Once Task 1 ships, `book_session()` will also reject bookings based on confirmed `allocation_assignments` occupancy that this page's UI doesn't yet reflect — a participant could see "5 spots left" and have their booking rejected as full. This task closes that gap using the new `session_allocation_confirmed_counts()` RPC from Task 1.

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx`

- [ ] **Step 1: Read the current file in full**

Confirm the exact current structure around lines 48-66 (the `myBookings`/`countMap` construction) before editing — line numbers may have drifted slightly since the spec was written.

- [ ] **Step 2: Add the allocation-count query and merge it into `countMap`**

After the existing `countRows` query block (currently ending around line 66 with the `for (const row of countRows ?? [])` loop), add:

```typescript
  // Confirmed allocation-assignment counts per session — via a SECURITY
  // DEFINER RPC, since participants have no direct RLS access to
  // allocation_assignments. Added to (not replacing) the session_bookings
  // counts above, so the displayed "spots left" matches exactly what
  // book_session() will enforce.
  const { data: allocationCountRows } = await supabase.rpc('session_allocation_confirmed_counts');
  for (const row of allocationCountRows ?? []) {
    countMap.set(row.session_id, (countMap.get(row.session_id) ?? 0) + row.confirmed_count);
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. If `session_allocation_confirmed_counts` isn't recognized by the generated Supabase types (`src/types/database.ts`), check whether this repo's convention is to regenerate types from the live schema (check `package.json` for a `supabase gen types` script) or to use the `as never`-cast RPC-call workaround already established elsewhere in this codebase (seen in `src/lib/participants/reclassify.ts` for a migration-defined RPC not yet in generated types) — prefer regenerating types if a script exists and is quick to run against the scratch project; otherwise use the established cast workaround rather than blocking on type-generation tooling.

- [ ] **Step 4: Manual verification**

With the scratch-project `.env.local` present in this worktree and the dev server running, log in as a test participant, create a confirmed allocation assignment for a session via direct DB insert (or reuse a fixture from Task 2's test if still present — but don't rely on test data existing; set up a throwaway row manually if needed and clean it up after), and visit `/my-agenda/browse`. Confirm the "spots left" / full indicator for that session reflects the allocation assignment's occupancy, not just `session_bookings`. Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx"
git commit -m "fix: browse page shows allocation-aware remaining capacity

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Diagnostic query for pre-existing conflicts

**Files:**
- Create: `scripts/diagnose-booking-allocation-conflicts.sql`

- [ ] **Step 1: Write the script**

```sql
-- scripts/diagnose-booking-allocation-conflicts.sql
--
-- Read-only diagnostic. Finds every ACTIVE session_bookings row whose
-- participant also has a CONFIRMED allocation_assignments row for a
-- time-overlapping session -- i.e. bookings made before
-- 20261003000000_book_session_respects_allocation.sql existed, which
-- are now inconsistent with the new rule but were never automatically
-- cancelled or modified (explicit scope decision, see
-- docs/superpowers/specs/2026-10-01-booking-allocation-conflict-design.md
-- section 1). Run manually and review with the team; this script makes
-- no changes.
select
  sb.id as booking_id,
  sb.application_id,
  sb.session_id as booked_session_id,
  aa.session_id as assigned_session_id,
  s1.title_en as booked_session_title,
  s2.title_en as assigned_session_title
from session_bookings sb
join sessions s1 on s1.id = sb.session_id
join allocation_assignments aa on aa.application_id = sb.application_id and aa.status = 'confirmed'
join sessions s2 on s2.id = aa.session_id
where sb.status = 'active'
  and tstzrange(s1.start_time, s1.end_time, '[)') && tstzrange(s2.start_time, s2.end_time, '[)');
```

- [ ] **Step 2: Verify it runs and returns the expected shape against the scratch project**

Run it via `npx supabase db execute` (or the project's established way of running an ad-hoc SQL file against the linked project — check `package.json`/`scripts/` for an existing pattern other `.sql` diagnostic scripts in this repo use, if any exist; otherwise run it via a quick Node script using the service-role client with `.rpc` is not applicable here since it's a plain SELECT, not a function — use the Supabase JS client's `.from()`/raw query capability, or simplest: temporarily wrap the query body in a throwaway `create or replace function` for one manual test call, then drop it — do NOT leave a temporary function behind; this script is meant to be run as raw SQL by a human with DB access, not as an app-callable RPC).

Confirm: query runs without error, returns zero rows on the freshly-fixture-free scratch project (or the expected rows if Task 2's test fixtures happen to still be present — not a failure either way, just confirm the shape/columns look right).

- [ ] **Step 3: Commit**

```bash
git add scripts/diagnose-booking-allocation-conflicts.sql
git commit -m "chore: add read-only diagnostic for pre-existing booking/allocation conflicts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Final sweep verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full relevant test suite**

Run: `npx vitest run tests/agenda/`
Expected: all pass, including the pre-existing `conflict-and-validation.test.ts` and `session-day-match-live.test.ts` from earlier sub-projects (confirming no regression).

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors (pre-existing unrelated errors in `tests/attendance/qr-issuance-reservation.test.ts` and `tests/attendance/qr-credentials-lifecycle-trigger.test.ts` are known and out of scope).

- [ ] **Step 3: Full lint**

Run: `npx eslint` on all files this branch touched.
Expected: no new issues.

- [ ] **Step 4: Dispatch final code review**

Use a code-reviewer subagent to review the entire branch diff (`git diff master...HEAD`) against the spec, confirming: the capacity/conflict-check additions in `book_session()` are correctly placed and don't disturb the unchanged parts of the function; `session_allocation_confirmed_counts()`'s grant is to `authenticated` (not `service_role`) and returns aggregate data only; the browse-page change correctly adds to (not replaces) the existing `countMap`; the diagnostic script makes no writes; test coverage matches every scenario in spec section 5.

- [ ] **Step 5: Proceed to superpowers:finishing-a-development-branch**
