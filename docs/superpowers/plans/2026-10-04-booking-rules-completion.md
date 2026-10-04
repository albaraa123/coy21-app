# Booking Rules Completion (4e) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four remaining booking rules from the original project request: a global booking-closing deadline, a session-capacity downsize guard, no-show seat release (bridging `session_bookings` and `attendance_records` for the first time), and walk-in admission for a not-yet-booked participant at the door.

**Architecture:** Seven schema migrations (enum isolation, two new tables, three new columns, one widened constraint), three `create or replace function` edits to existing RPCs (deadline consolidation), one new trigger (capacity guard), two new functions plus a cron route (no-show), one new RPC plus a standalone admin page (walk-in), one existing-function edit (linking QR scans to bookings), and two new admin pages (global deadline settings, walk-in admission).

**Tech Stack:** Next.js (App Router, Server Actions), Supabase Postgres (migrations, RLS, PL/pgSQL), Vitest (live integration tests against the scratch Supabase project).

**Spec:** `docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md` — read this first; it has the full rationale for every decision below, including two full review rounds' worth of fixes already incorporated into its SQL. This plan implements it task-by-task, copying its SQL blocks verbatim where given.

---

### Task 1: Global deadline — `conference_settings` table + `session_effective_deadline()` consolidation

**Files:**
- Create: `supabase/migrations/20261006000000_conference_settings_table.sql`
- Create: `supabase/migrations/20261006010000_consolidate_session_effective_deadline.sql`
- Test: `tests/agenda/booking-rules-completion-live.test.ts` (created here, extended in later tasks)

This task has no dependency on anything else in this plan — it's pure schema plus a 3-call-site edit to existing, already-tested RPCs.

- [ ] **Step 1: Write the `conference_settings` migration**

```sql
-- 20261006000000_conference_settings_table.sql
--
-- Singleton settings table for a platform-wide booking-closing deadline,
-- modeled directly on email_settings (20260930010000_add_email_settings_table.sql)
-- -- same id boolean primary key default true + check(id=true) pattern,
-- same RLS shape (staff read, super_admin write). See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 5.

create table conference_settings (
  id boolean primary key default true,
  constraint conference_settings_singleton check (id = true),
  global_booking_deadline timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

insert into conference_settings (id) values (true);

alter table conference_settings enable row level security;

create policy "staff can read conference settings"
  on conference_settings for select
  using (is_staff());

create policy "only super_admin can update conference settings"
  on conference_settings for update
  using (current_user_role() = 'super_admin')
  with check (current_user_role() = 'super_admin');

-- no insert/delete policy: seeded singleton row, never created or
-- removed by the app after this migration runs.
```

- [ ] **Step 2: Apply the migration**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push` (confirm `supabase/.temp/linked-project.json` points at the scratch project first).

- [ ] **Step 3: Regenerate database types**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase gen types typescript --project-id <scratch-project-ref> > src/types/database.ts`

Verify `conference_settings` appears with `global_booking_deadline: string | null`.

- [ ] **Step 4: Write the `session_effective_deadline()` consolidation migration**

```sql
-- 20261006010000_consolidate_session_effective_deadline.sql
--
-- Replaces the dead-code session_effective_deadline() (defined in 4a's
-- migration, never actually called) with a real implementation, and
-- updates book_session/join_waitlist/cancel_booking (their current
-- authoritative bodies, unchanged except this one line each) to call it
-- instead of their own duplicated inline coalesce(...) expression. See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 4.

create or replace function session_effective_deadline(p_session sessions) returns timestamptz
language sql stable as $$
  select least(
    coalesce((select global_booking_deadline from conference_settings), 'infinity'::timestamptz),
    coalesce(p_session.booking_deadline, p_session.start_time - interval '3 hours')
  );
$$;

-- book_session: full current authoritative body from
-- 20261003000000_book_session_respects_allocation.sql, with its single
-- `v_deadline := coalesce(...)` line (that file's line 83) replaced by a
-- call to session_effective_deadline. Every other line is unchanged.
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
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status not in ('published', 'confirmed') then
    raise exception 'Session is not open for booking';
  end if;

  v_deadline := session_effective_deadline(v_session);
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  v_count := session_effective_occupied_count(p_session_id);
  if v_count >= v_session.capacity then
    raise exception 'Session is full';
  end if;

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

-- join_waitlist: full current authoritative body from
-- 20261005035000_join_waitlist_unique_violation_handling.sql, with its
-- single `v_deadline := coalesce(...)` line (that file's line 55)
-- replaced the same way. Every other line (including the
-- unique_violation handler) is unchanged.
create or replace function join_waitlist(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session        sessions%rowtype;
  v_enable_waitlist boolean;
  v_count          int;
  v_deadline       timestamptz;
  v_waitlist_id    uuid;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status not in ('published', 'confirmed') then
    raise exception 'Session is not open for booking';
  end if;

  select st.enable_waitlist into v_enable_waitlist
  from session_types st where st.id = v_session.session_type_id;
  if not coalesce(v_enable_waitlist, false) then
    raise exception 'This session does not support a waitlist';
  end if;

  v_deadline := session_effective_deadline(v_session);
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  v_count := session_effective_occupied_count(p_session_id);
  if v_count < v_session.capacity then
    raise exception 'Session is not full -- book it directly instead of joining the waitlist';
  end if;

  if exists (
    select 1 from session_bookings
    where application_id = p_application_id and session_id = p_session_id and status = 'active'
  ) then
    raise exception 'You already have a booking for this session';
  end if;

  if exists (
    select 1 from session_waitlist
    where application_id = p_application_id and session_id = p_session_id and status = 'waiting'
  ) then
    raise exception 'You are already on the waitlist for this session';
  end if;

  begin
    insert into session_waitlist (application_id, session_id)
    values (p_application_id, p_session_id)
    returning id into v_waitlist_id;
  exception when unique_violation then
    raise exception 'You are already on the waitlist for this session';
  end;

  return v_waitlist_id;
end;
$$;

grant execute on function join_waitlist(uuid, uuid) to authenticated;

-- cancel_booking: full current authoritative body from
-- 20261005045000_fix_promotion_recheck_comment.sql, with its single
-- `v_deadline := coalesce(...)` line (that file's line 58) replaced the
-- same way. Every other line (including the full promotion loop) is
-- unchanged here -- Task 4 replaces this same function again to extract
-- the promotion loop into a shared helper; this task's edit is scoped
-- to the deadline line only, so the two tasks' diffs don't fight each
-- other when applied in order.
create or replace function cancel_booking(
  p_booking_id     uuid,
  p_application_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking         session_bookings%rowtype;
  v_session         sessions%rowtype;
  v_deadline        timestamptz;
  v_enable_waitlist boolean;
  v_candidate       record;
  v_new_booking_id  uuid;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_booking from session_bookings
  where id = p_booking_id and application_id = p_application_id
  for update;

  if v_booking.id is null then
    raise exception 'Booking not found';
  end if;
  if v_booking.status in ('cancelled', 'session_cancelled') then
    raise exception 'Booking is already cancelled';
  end if;

  select * into v_session from sessions where id = v_booking.session_id;
  v_deadline := session_effective_deadline(v_session);

  if now() > v_deadline then
    raise exception 'Cannot cancel after the booking deadline';
  end if;

  update session_bookings
  set status = 'cancelled', cancelled_at = now()
  where id = p_booking_id;

  select st.enable_waitlist into v_enable_waitlist
  from session_types st where st.id = v_session.session_type_id;

  if coalesce(v_enable_waitlist, false) then
    <<promotion>>
    for v_candidate in
      select sw.id, sw.application_id, sw.status
      from session_waitlist sw
      where sw.session_id = v_booking.session_id
        and sw.status = 'waiting'
      order by sw.joined_at asc
      for update of sw
    loop
      if v_candidate.status is distinct from 'waiting' then
        continue;
      end if;

      if exists (
        select 1 from session_bookings sb join sessions s on s.id = sb.session_id
        where sb.application_id = v_candidate.application_id and sb.status = 'active'
          and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)')
      ) or exists (
        select 1 from allocation_assignments aa join sessions s on s.id = aa.session_id
        where aa.application_id = v_candidate.application_id and aa.status = 'confirmed'
          and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)')
      ) then
        continue;
      end if;

      insert into session_bookings (application_id, session_id)
      values (v_candidate.application_id, v_booking.session_id)
      returning id into v_new_booking_id;

      update session_waitlist
      set status = 'promoted', promoted_at = now()
      where id = v_candidate.id;

      update session_waitlist sw2
      set status = 'withdrawn', withdrawn_at = now()
      from sessions s2
      where sw2.session_id = s2.id
        and sw2.application_id = v_candidate.application_id
        and sw2.status = 'waiting'
        and tstzrange(s2.start_time, s2.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)');

      insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
      values (v_new_booking_id, v_candidate.application_id, v_booking.session_id, 'waitlist_promoted');

      exit promotion;
    end loop;
  end if;
end;
$$;

grant execute on function cancel_booking(uuid, uuid) to authenticated;
```

- [ ] **Step 5: Apply the migration**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`.

- [ ] **Step 6: Create the live test file and write the deadline tests**

Create `tests/agenda/booking-rules-completion-live.test.ts`, following `tests/agenda/work-group-waitlist-live.test.ts`'s exact conventions (read that file first — it's your template): `runId`-suffixed fixtures, dedicated room per session, signed-in participant client for `auth.uid()`-gated RPCs, `vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 })` near the top (this file will accumulate many tests across this plan's tasks, same reasoning as 4d's own hookTimeout bump), careful `afterAll` cleanup (including the `schedule_change_events` pre-delete only if any test in this file directly `UPDATE`s `sessions.status`/`start_time`/`end_time` — check as you go, per Task 4's own test, which may need it).

Add a helper to read/write `conference_settings.global_booking_deadline` directly via the `admin` service-role client for test setup (no RPC needed — a plain `.from('conference_settings').update({...}).eq('id', true)` works fine for seeding test state, bypassing RLS as service-role always does), and a helper to reset it to `null` in `afterAll` (important: this table is a shared singleton across the whole scratch project, not per-test-fixture-isolated like everything else — resetting it in `afterAll` is required so this test file doesn't leave the scratch project's global deadline permanently set for any other test file that runs afterward).

```typescript
describe('session_effective_deadline', () => {
  it('returns the global deadline when it is earlier than the per-session deadline', async () => {
    // set conference_settings.global_booking_deadline to some time T1;
    // seed a session with booking_deadline T2 where T1 < T2; call
    // session_effective_deadline via a test-only wrapper or indirectly
    // via book_session's own rejection -- assert booking is rejected
    // once now() > T1 even though T2 hasn't passed yet
  });

  it('returns the per-session deadline when it is earlier than the global deadline', async () => {
    // global deadline far in the future; per-session deadline already
    // passed -- assert book_session still rejects (per-session wins)
  });

  it('falls back to the per-session effective deadline when global_booking_deadline is NULL', async () => {
    // reset global to null (the default/most-common state); confirm
    // existing per-session deadline behavior is completely unchanged
    // (this is really a non-regression check against 4a/4b's existing
    // deadline tests, from this new code path)
  });
});
```

Fill in each test body with real seeded fixtures and real RPC calls (`book_session` is the simplest vehicle to observe `session_effective_deadline`'s behavior indirectly, since there's no standalone RPC exposed for it — calling it directly via `.rpc()` isn't possible since it takes a `sessions` composite-type argument, not scalar args, so testing it through `book_session`'s accept/reject behavior is the correct and only practical approach).

- [ ] **Step 7: Write the deadline-enforcement tests for all three RPCs**

```typescript
describe('global deadline enforcement across book_session/join_waitlist/cancel_booking', () => {
  it('book_session rejects once the global deadline has passed, even though the per-session deadline has not', async () => {});
  it('join_waitlist rejects once the global deadline has passed, even though the per-session deadline has not', async () => {});
  it('cancel_booking rejects once the global deadline has passed, even though the per-session deadline has not', async () => {});
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/agenda/booking-rules-completion-live.test.ts`

Expected: all 6 tests PASS.

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint tests/agenda/booking-rules-completion-live.test.ts`. Pre-existing unrelated errors in `tests/attendance/qr-issuance-reservation.test.ts`/`tests/attendance/qr-credentials-lifecycle-trigger.test.ts` are known and out of scope.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/20261006000000_conference_settings_table.sql supabase/migrations/20261006010000_consolidate_session_effective_deadline.sql tests/agenda/booking-rules-completion-live.test.ts src/types/database.ts
git commit -m "feat: add global booking deadline, consolidate deadline logic"
```

---

### Task 2: Global deadline admin UI

**Files:**
- Create: `src/app/[locale]/(admin)/settings/conference-settings-form.tsx`
- Modify: `src/app/[locale]/(admin)/settings/actions.ts`
- Modify: `src/app/[locale]/(admin)/settings/page.tsx`

This task depends on Task 1's `conference_settings` table existing.

- [ ] **Step 1: Add the server actions**

In `src/app/[locale]/(admin)/settings/actions.ts`, read the file first (it already has `applyEmailSettingsUpdate`/`requireSuperAdmin`-based actions — this is your template). Add:

```ts
async function applyConferenceSettingsUpdate(
  service: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  patch: { global_booking_deadline: string | null }
): Promise<{ error: string | null }> {
  const { error } = await service
    .from('conference_settings')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath(SETTINGS_PATH);
  return { error: null };
}

export async function setGlobalBookingDeadline(deadlineIso: string) {
  const { service, userId } = await requireSuperAdmin();
  return applyConferenceSettingsUpdate(service, userId, { global_booking_deadline: deadlineIso });
}

export async function clearGlobalBookingDeadline() {
  const { service, userId } = await requireSuperAdmin();
  return applyConferenceSettingsUpdate(service, userId, { global_booking_deadline: null });
}
```

- [ ] **Step 2: Read the current `page.tsx` and `settings-form.tsx` in full**

Before writing Step 3, read `src/app/[locale]/(admin)/settings/page.tsx` and `src/app/[locale]/(admin)/settings/settings-form.tsx` completely so the new section matches their exact existing structure/styling (this plan's author did not read `settings-form.tsx` during research — do so now before writing new UI).

- [ ] **Step 3: Add the conference settings section**

In `page.tsx`, add a query for `conference_settings.global_booking_deadline` (same `.eq('id', true).single()` pattern as the existing `email_settings` query) and pass it to a new `ConferenceSettingsForm` component (new file, `conference-settings-form.tsx`, following `settings-form.tsx`'s exact client-component pattern: local state, `useTransition`, calls `setGlobalBookingDeadline`/`clearGlobalBookingDeadline`). A `datetime-local` input plus "Save" and "Clear" buttons is sufficient — no new design system component needed, matching the plain-input style already used elsewhere in this admin area (e.g. the session capacity field in `session-edit-form.tsx`).

- [ ] **Step 4: Manual browser verification**

Start the dev server, sign in as a `super_admin`, navigate to the settings page, set a global deadline, confirm it persists on reload, clear it, confirm it clears. If a `super_admin`-authenticated session isn't readily available, skip this and note it as a self-review gap (same pattern Task 1 of 4c/4d used), relying instead on a careful trace of the data flow (query → prop → form state → server action → DB write → `revalidatePath`).

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint "src/app/[locale]/(admin)/settings/"`.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/(admin)/settings/"
git commit -m "feat: add global booking deadline admin UI"
```

---

### Task 3: Session capacity downsize guard

**Files:**
- Create: `supabase/migrations/20261006020000_session_capacity_downsize_guard.sql`
- Modify: `tests/agenda/booking-rules-completion-live.test.ts`

Independent of Tasks 1-2; can be done in any order relative to them, but is sequenced here to keep the plan's task numbering matching the spec's own document order.

- [ ] **Step 1: Write the migration**

```sql
-- 20261006020000_session_capacity_downsize_guard.sql
--
-- Rejects reducing a session's capacity below its current booking +
-- allocation occupancy, mirroring revalidate_sessions_on_room_capacity_change's
-- exact reject-don't-cascade pattern
-- (20260723020000_sessions_triggers.sql, trigger #4). See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 6.

create function enforce_session_capacity_vs_bookings() returns trigger as $$
declare
  v_occupied int;
begin
  if new.capacity >= old.capacity then
    return new; -- only a reduction needs checking
  end if;
  v_occupied := session_effective_occupied_count(new.id);
  if new.capacity < v_occupied then
    raise exception 'Cannot reduce session capacity to %: % booking(s)/allocation(s) already occupy this session', new.capacity, v_occupied;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_capacity_vs_bookings
  before update of capacity on sessions
  for each row execute function enforce_session_capacity_vs_bookings();
```

- [ ] **Step 2: Apply the migration**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`.

- [ ] **Step 3: Write the failing tests**

Append to `tests/agenda/booking-rules-completion-live.test.ts`:

```typescript
describe('session capacity downsize guard', () => {
  it('rejects reducing capacity below the current occupied count', async () => {
    // seed a session with capacity 3, book 2 active seats; attempt to
    // update capacity to 1 via the admin service-role client; assert
    // the update errors with a message containing 'Cannot reduce
    // session capacity'
  });

  it('allows reducing capacity to exactly the occupied count', async () => {
    // same setup; reduce capacity to 2 (== occupied count); assert success
  });

  it('allows reducing capacity when no bookings exist', async () => {
    // capacity 5, zero bookings; reduce to 1; assert success
  });

  it('allows increasing capacity regardless of occupied count', async () => {
    // capacity 2, 2 active bookings (at capacity); increase to 5;
    // assert success (the trigger only checks reductions)
  });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agenda/booking-rules-completion-live.test.ts`

Expected: all tests (Task 1's 6 + this task's 4 = 10) PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint tests/agenda/booking-rules-completion-live.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261006020000_session_capacity_downsize_guard.sql tests/agenda/booking-rules-completion-live.test.ts
git commit -m "feat: reject session capacity downsize below occupied count"
```

---

### Task 4: No-show detection and seat release

**Files:**
- Create: `supabase/migrations/20261006030000_add_no_show_booking_status.sql`
- Create: `supabase/migrations/20261006040000_no_show_detection_and_promotion_helper.sql`
- Create: `src/app/api/cron/process-session-no-shows/route.ts`
- Modify: `vercel.json`
- Modify: `tests/agenda/booking-rules-completion-live.test.ts`

This is the core of the feature. Depends on Task 1 (uses `session_effective_deadline` indirectly through unrelated code paths, but more importantly needs `cancel_booking` already updated so this task's own `cancel_booking` replacement — which also extracts the promotion helper — doesn't conflict). Sequence Tasks 1 and 4 in order; do not parallelize them against the same `cancel_booking` function.

- [ ] **Step 1: Write the enum-extension migration**

```sql
-- 20261006030000_add_no_show_booking_status.sql
--
-- Must be its own migration, committed before any later migration
-- references the new value (Postgres requires ALTER TYPE ... ADD VALUE
-- to commit before use -- same constraint every prior enum extension in
-- this codebase has worked around). See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 8.

alter type booking_status add value 'no_show';
```

- [ ] **Step 2: Apply it alone first**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`. Confirm it applies cleanly before writing Step 3's file.

- [ ] **Step 3: Write the no-show detection + promotion-helper migration**

Copy the full `promote_next_waitlist_candidate` and `process_session_no_shows` function bodies from the spec's "No-Show Detection and Seat Release" section verbatim (spec lines 138-229 for the two functions). Also include, in the same migration file, a `create or replace function cancel_booking(...)` that is identical to Task 1's version of `cancel_booking` EXCEPT its promotion loop (the `if coalesce(v_enable_waitlist, false) then <<promotion>> for v_candidate in ... end loop; end if;` block) is replaced with a single call: `perform promote_next_waitlist_candidate(v_booking.session_id);`.

```sql
-- 20261006040000_no_show_detection_and_promotion_helper.sql
--
-- Extracts cancel_booking's inline promotion loop into a shared
-- promote_next_waitlist_candidate() helper (cancel_booking's existing
-- promotion behavior is unchanged -- this is a pure refactor, verified
-- by Task 1's/4d's existing cancel_booking tests staying green), and
-- adds process_session_no_shows(), which calls the same helper. See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- "No-Show Detection and Seat Release" section for full rationale,
-- including why idempotency is per-booking (via status = 'active') and
-- not a session-level marker column, and why within-pass promotion
-- feedback is safe by construction (PL/pgSQL cursor materialization).

create function promote_next_waitlist_candidate(p_session_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session         sessions%rowtype;
  v_candidate       record;
  v_new_booking_id  uuid;
begin
  select * into v_session from sessions where id = p_session_id;

  <<promotion>>
  for v_candidate in
    select sw.id, sw.application_id, sw.status
    from session_waitlist sw
    where sw.session_id = p_session_id
      and sw.status = 'waiting'
    order by sw.joined_at asc
    for update of sw
  loop
    if v_candidate.status is distinct from 'waiting' then
      continue;
    end if;

    if exists (
      select 1 from session_bookings sb join sessions s on s.id = sb.session_id
      where sb.application_id = v_candidate.application_id and sb.status = 'active'
        and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)')
    ) or exists (
      select 1 from allocation_assignments aa join sessions s on s.id = aa.session_id
      where aa.application_id = v_candidate.application_id and aa.status = 'confirmed'
        and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)')
    ) then
      continue;
    end if;

    insert into session_bookings (application_id, session_id)
    values (v_candidate.application_id, p_session_id)
    returning id into v_new_booking_id;

    update session_waitlist set status = 'promoted', promoted_at = now() where id = v_candidate.id;

    update session_waitlist sw2
    set status = 'withdrawn', withdrawn_at = now()
    from sessions s2
    where sw2.session_id = s2.id
      and sw2.application_id = v_candidate.application_id
      and sw2.status = 'waiting'
      and tstzrange(s2.start_time, s2.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)');

    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
    values (v_new_booking_id, v_candidate.application_id, p_session_id, 'waitlist_promoted');

    exit promotion;
  end loop;
end;
$$;

create function process_session_no_shows(p_session_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_booking         record;
  v_enable_waitlist boolean;
begin
  select st.enable_waitlist into v_enable_waitlist
  from sessions s join session_types st on st.id = s.session_type_id
  where s.id = p_session_id;

  for v_booking in
    select sb.id
    from session_bookings sb
    where sb.session_id = p_session_id
      and sb.status = 'active'
      and not exists (
        select 1 from attendance_records ar
        where ar.booking_id = sb.id and ar.status = 'admitted'
      )
    for update of sb
  loop
    update session_bookings set status = 'no_show' where id = v_booking.id;

    if coalesce(v_enable_waitlist, false) then
      perform promote_next_waitlist_candidate(p_session_id);
    end if;
  end loop;
end;
$$;

-- cancel_booking: identical to the version in
-- 20261006010000_consolidate_session_effective_deadline.sql except the
-- inline promotion loop is replaced by the same enable_waitlist lookup
-- plus a call to the new helper above -- preserving the exact same
-- "only call into the promotion path when the session type supports a
-- waitlist" gate process_session_no_shows also uses, so neither caller
-- diverges from the other's contract with promote_next_waitlist_candidate.
create or replace function cancel_booking(
  p_booking_id     uuid,
  p_application_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking         session_bookings%rowtype;
  v_session         sessions%rowtype;
  v_deadline        timestamptz;
  v_enable_waitlist boolean;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_booking from session_bookings
  where id = p_booking_id and application_id = p_application_id
  for update;

  if v_booking.id is null then
    raise exception 'Booking not found';
  end if;
  if v_booking.status in ('cancelled', 'session_cancelled') then
    raise exception 'Booking is already cancelled';
  end if;

  select * into v_session from sessions where id = v_booking.session_id;
  v_deadline := session_effective_deadline(v_session);

  if now() > v_deadline then
    raise exception 'Cannot cancel after the booking deadline';
  end if;

  update session_bookings
  set status = 'cancelled', cancelled_at = now()
  where id = p_booking_id;

  select st.enable_waitlist into v_enable_waitlist
  from session_types st where st.id = v_session.session_type_id;

  if coalesce(v_enable_waitlist, false) then
    perform promote_next_waitlist_candidate(v_booking.session_id);
  end if;
end;
$$;

grant execute on function cancel_booking(uuid, uuid) to authenticated;
```

- [ ] **Step 4: Apply the migration**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`.

- [ ] **Step 5: Write the no-show cron route**

Create `src/app/api/cron/process-session-no-shows/route.ts`, closely mirroring `src/app/api/cron/process-session-notifications/route.ts`'s exact skeleton (read that file first): same `isAuthorizedCronRequest`/`CRON_SECRET` guard shape, same service-role client setup. Query shape:

```ts
const { data: sessions, error: fetchErr } = await service
  .from('sessions')
  .select('id')
  .eq('status', 'confirmed')
  .lte('start_time', new Date(Date.now() - 15 * 60 * 1000).toISOString())
  .gte('start_time', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
```

(15-minute no-show threshold per spec scope decision 2; bounded to a 2-hour lookback window per the spec's "No-Show Detection" section note, to avoid an ever-growing scan as the conference progresses — both window edges are plain arithmetic on `Date.now()`, not configurable.)

For each matching session, call `process_session_no_shows` via RPC: `await service.rpc('process_session_no_shows' as never, { p_session_id: session.id })`. No per-row email/outbox handling needed in this route itself — `promote_next_waitlist_candidate` already queues the `waitlist_promoted` notification into `session_notification_outbox`, which the *existing* `process-session-notifications` cron already drains (no new email-sending code needed here at all). Track a simple `processed`/`errored` count per the established response-shape convention (`{ processed, errored, total: sessions.length }`), logging (not failing the whole request on) any single session's RPC error, matching `process-session-notifications`'s per-row error tolerance.

- [ ] **Step 6: Register the new cron in `vercel.json`**

Add an entry alongside the existing cron entries (`session-reminders`, `process-session-notifications`, etc. — read `vercel.json` first to match its exact formatting): `{ "path": "/api/cron/process-session-no-shows", "schedule": "*/5 * * * *" }`.

- [ ] **Step 7: Write the failing no-show tests**

Append to `tests/agenda/booking-rules-completion-live.test.ts`. This describe block's tests will need to directly call `process_session_no_shows` via RPC rather than waiting for a real cron tick (same pattern as calling other RPCs directly in this test file):

```typescript
describe('no-show detection and seat release', () => {
  it('marks an active booking with no admitted attendance record as no_show', async () => {
    // seed a session with start_time in the past (so the 15-min
    // threshold has already elapsed -- use a past DAY/start_time
    // override, not real-time waiting), one active booking with no
    // attendance_records row; call process_session_no_shows via RPC;
    // assert the booking's status is now 'no_show'
  });

  it('leaves a booking active when a matching admitted attendance record exists', async () => {
    // same setup, but seed an attendance_records row with booking_id
    // pointing at this booking and status='admitted'; assert the
    // booking remains 'active' after the RPC call
  });

  it('triggers waitlist promotion only when the session type has enable_waitlist = true', async () => {
    // waitlist-enabled session, one no-show booking, one waiting
    // candidate; call the RPC; assert the candidate is promoted
    // (active booking + session_waitlist row 'promoted')
  });

  it('does not attempt promotion when enable_waitlist is false', async () => {
    // same setup but enable_waitlist=false; assert the waiting
    // candidate's row is untouched ('waiting') and no new booking exists
  });

  it('is idempotent per-booking: a second call makes no further changes to already-processed bookings, and still evaluates a booking added after the first pass', async () => {
    // call process_session_no_shows once (marks booking A no_show);
    // seed a NEW active booking B for the same session with no
    // attendance record; call process_session_no_shows again; assert A
    // is still no_show (untouched) and B is now also no_show (newly
    // evaluated) -- this is the specific regression test for the
    // per-booking-not-per-session idempotency design decision
  });

  it('queues a waitlist_promoted outbox notification identical in shape to a cancel_booking-triggered promotion', async () => {
    // waitlist-enabled session, no-show triggers promotion; assert
    // exactly one session_notification_outbox row with
    // notification_type='waitlist_promoted' and the correct booking_id
  });
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/agenda/booking-rules-completion-live.test.ts`

Expected: all tests (10 from Tasks 1+3, plus 6 new = 16) PASS.

- [ ] **Step 9: Also re-run 4c/4d's existing live test files to confirm `cancel_booking`'s refactor didn't regress anything**

Run: `npx vitest run tests/agenda/session-lifecycle-notifications-live.test.ts tests/agenda/work-group-waitlist-live.test.ts`

Expected: all tests in both files still pass unchanged — this is the regression check the spec's Step 3 note promised ("verified by keeping its existing test suite green"). If anything fails here, the promotion-loop extraction has a bug; fix the migration, not the pre-existing tests.

- [ ] **Step 10: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/app/api/cron/process-session-no-shows/route.ts tests/agenda/booking-rules-completion-live.test.ts`.

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations/20261006030000_add_no_show_booking_status.sql supabase/migrations/20261006040000_no_show_detection_and_promotion_helper.sql src/app/api/cron/process-session-no-shows/route.ts vercel.json tests/agenda/booking-rules-completion-live.test.ts
git commit -m "feat: detect no-shows and release seats via waitlist promotion"
```

---

### Task 5: `/my-agenda` no-show badge

**Files:**
- Modify: `src/components/ui/badge.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/page.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/agenda-day.tsx`

Depends on Task 4 (the `'no_show'` enum value must exist).

- [ ] **Step 1: Add the `noShow` Badge variant**

In `src/components/ui/badge.tsx`, following the exact pattern `sessionCancelled`/`waitlisted` already established (read the file first — it's short): add `noShow` to the `BadgeVariant` union and `VARIANT_CLASSES`, with a comment explaining the color choice relative to the two existing cancellation-flavored variants (`cancelled` muted-strikethrough, `sessionCancelled` solid-red-active-warning) — a no-show is informational/past-tense like `cancelled`, not an action-required warning like `sessionCancelled`, so a muted treatment (similar family to `cancelled`, visually distinct enough not to be confused with it) is the right call; pick exact Tailwind classes consistent with that reasoning.

- [ ] **Step 2: Update `/my-agenda`'s query and type**

In `page.tsx`, the existing `session_bookings` query already does `.in('status', ['active', 'session_cancelled'])` (from 4c). Widen this to `.in('status', ['active', 'session_cancelled', 'no_show'])` so no-show bookings are fetched at all (currently they'd be silently excluded, same gap 4c fixed for `session_cancelled`).

In `agenda-day.tsx`, the `Booking.status` type is currently `'active' | 'session_cancelled'` (deliberately tightened in 4c). Widen it to `'active' | 'session_cancelled' | 'no_show'`. In the render branch that currently does `b.status === 'session_cancelled' ? <Badge variant="sessionCancelled">...</Badge> : <CancelButton .../>`, add a third branch: `b.status === 'no_show' ? <Badge variant="noShow">No Show</Badge> : ...`.

- [ ] **Step 3: Manual verification or self-review**

Same pattern as prior tasks — verify in a real browser session if a participant account with a no-show booking is easy to construct (likely not, without running the actual cron), otherwise do a careful code-level trace (query → type → render branch) and note the gap explicitly.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/components/ui/badge.tsx "src/app/[locale]/(participant)/(shell)/my-agenda/"`.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/badge.tsx "src/app/[locale]/(participant)/(shell)/my-agenda/page.tsx" "src/app/[locale]/(participant)/(shell)/my-agenda/agenda-day.tsx"
git commit -m "feat: show a no-show badge on /my-agenda"
```

---

### Task 6: Walk-in admission RPC + attendance-booking link

**Files:**
- Create: `supabase/migrations/20261006050000_walk_in_admission.sql`
- Modify: `tests/agenda/booking-rules-completion-live.test.ts`

Depends on Task 1 (`session_bookings.source` doesn't exist yet — this task adds it) — actually independent of Tasks 1/3/4's specific content, but must come after Task 1 only insofar as the migration-file dating needs to not collide; no real functional dependency. Can be implemented any time after Task 1 is merged into the branch.

- [ ] **Step 1: Write the migration**

```sql
-- 20261006050000_walk_in_admission.sql
--
-- Adds session_bookings.source, attendance_records.booking_id, widens
-- attendance_records.entry_type's check constraint, and adds
-- admit_walk_in() -- a new RPC letting staff admit a not-yet-booked,
-- accepted participant directly at the door. Also updates
-- scan_attempt_transactional to populate the new booking_id link on
-- every admission the normal QR flow produces. See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- "Walk-In Admission" section for full rationale, including why
-- admit_walk_in's own is_staff() check is the sole authorization gate
-- (not deferred to a TypeScript-side pre-check) and the
-- compute_time_slot_group_key_for_session() access-path reasoning.

alter table session_bookings add column source text not null default 'self_service'
  check (source in ('self_service', 'walk_in'));

alter table attendance_records add column booking_id uuid references session_bookings(id);

alter table attendance_records drop constraint attendance_records_entry_type_check;
alter table attendance_records add constraint attendance_records_entry_type_check
  check (entry_type in ('priority', 'flexible', 'override', 'walk_in'));

create function admit_walk_in(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session      sessions%rowtype;
  v_admitted     int;
  v_booking_id   uuid;
begin
  if not is_staff() then
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

  insert into session_bookings (application_id, session_id, source)
  values (p_application_id, p_session_id, 'walk_in')
  returning id into v_booking_id;

  begin
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, booking_id)
    values (p_application_id, p_session_id, compute_time_slot_group_key_for_session(p_session_id), 'walk_in', auth.uid(), v_booking_id);
  exception when unique_violation then
    raise exception 'This participant has already been admitted to this session';
  end;

  return v_booking_id;
end;
$$;

grant execute on function admit_walk_in(uuid, uuid) to authenticated;
```

Note on the `is_staff()` check plus `grant execute ... to authenticated`: this matches the pattern `join_waitlist`/`leave_waitlist`/`book_session`/`cancel_booking` all use (granted to `authenticated`, with their own in-function authorization check gating who among `authenticated` callers may actually succeed) — `admit_walk_in` follows the same shape, just checking `is_staff()` instead of an `auth.uid()`-based application-ownership check, since the caller here is staff acting on someone else's behalf, not the participant themselves.

Then, in the same migration file, add the `scan_attempt_transactional` update — full current authoritative body from `20260928000000_scan_attempt_transactional_scope_check.sql` (lines 38-194), with one addition: a new `v_matched_booking_id uuid;` declaration, a new lookup statement inserted right before the existing `insert into attendance_records (...)` (that file's line 183), and `booking_id` added to that insert's column/values lists:

```sql
-- scan_attempt_transactional: full current body, unchanged except the
-- booking_id lookup/column addition described above. Copy the complete
-- function body from 20260928000000_scan_attempt_transactional_scope_check.sql
-- verbatim, then apply this one change at its `insert into
-- attendance_records` statement (originally that file's lines 182-186):
--
--   if v_result in ('admitted', 'flexible_admitted', 'override_admitted') then
--     select id into v_matched_booking_id from session_bookings
--     where application_id = p_application_id and session_id = p_session_id and status = 'active';
--
--     insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, device_identifier, booking_id)
--     values (p_application_id, p_session_id, p_time_slot_group_key, v_entry_type, p_scanned_by, p_device_identifier, v_matched_booking_id)
--     returning id into v_attendance_id;
--   end if;
--
-- v_matched_booking_id is NULL when no matching active booking exists
-- (e.g. a flexible/priority admission with no prior self-service
-- booking) -- this is the expected, non-error case per scope decision 1.
```

Write out the FULL `create or replace function scan_attempt_transactional(...)` body in the actual migration file — the comment above is a diff summary for this plan, not something to paste as-is. Copy every line from the current authoritative file, add `v_matched_booking_id uuid;` to the `declare` block, and apply the two-line change shown above at the one `insert into attendance_records` call site. Every other part of the function (the advisory lock, the scanner-scope re-check, the full admission_policy decision tree) is copied unchanged. The function's grants (`grant execute on function public.scan_attempt_transactional(...) to service_role;`) and `scan_qr_attempt_transactional`'s own unchanged wrapper do not need to be re-stated in this migration unless `create or replace function` requires them to be re-granted — check whether Postgres preserves existing grants across a `create or replace function` (it does, for a matching signature) before deciding whether to repeat the grant statement; if the signature is unchanged (it is — no new parameters), the existing grant from `20260928000000` already covers this replacement and does not need restating.

- [ ] **Step 2: Apply the migration**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase db push`.

- [ ] **Step 3: Regenerate database types**

Run: `SUPABASE_ACCESS_TOKEN=<token> npx supabase gen types typescript --project-id <scratch-project-ref> > src/types/database.ts`. Confirm `admit_walk_in` appears in the RPC `Functions` union and `session_bookings.source`/`attendance_records.booking_id` appear in their respective table types.

- [ ] **Step 4: Write the failing walk-in tests**

Append to `tests/agenda/booking-rules-completion-live.test.ts`:

```typescript
describe('admit_walk_in', () => {
  it('succeeds when admitted count is below capacity', async () => {
    // seed a confirmed session with capacity 2, zero attendance_records;
    // call admit_walk_in via the admin service-role client (or a
    // signed-in staff client if one is easy to construct in this test
    // file's existing fixtures -- check how is_staff() is satisfied in
    // other live tests in this codebase, e.g. admin-layout-live.test.ts,
    // for the right pattern); assert a session_bookings row exists with
    // source='walk_in' and an attendance_records row exists with
    // entry_type='walk_in' and the correct booking_id. Per spec testing
    // requirement 9, also confirm the walk-in booking is visible
    // through the SAME query paths a self-service booking would be,
    // not just that the raw rows exist with the right shape:
    //   - call session_effective_occupied_count(session_id) (the same
    //     function book_session/join_waitlist use for their own
    //     capacity checks) and assert it includes this walk-in booking
    //     in its count (i.e. it increased by 1 after admit_walk_in,
    //     same as it would after a successful book_session call)
    //   - query session_bookings the same way /my-agenda's page.tsx
    //     does (.eq('application_id', ...).in('status', ['active', ...]))
    //     and assert the walk-in row is included
  });

  it('rejects when admitted count equals capacity', async () => {
    // capacity 1, one existing admitted attendance_records row; assert
    // admit_walk_in raises 'Session is at capacity'
  });

  it('rejects a participant who already has an active booking for this session', async () => {
    // seed an active session_bookings row for the applicant; assert
    // admit_walk_in raises 'This participant already has a booking for this session'
  });

  it('rejects a participant already admitted via the normal flow with no prior booking', async () => {
    // seed an attendance_records row (status='admitted', entry_type
    // e.g. 'flexible', booking_id null -- simulating a normal QR
    // admission with no self-service booking); assert admit_walk_in
    // raises 'This participant has already been admitted to this session'.
    // This is the attendance_records-side duplicate check, distinct
    // from the session_bookings-side case above.
  });

  it('rejects admission to a non-confirmed session', async () => {
    // seed a draft session; assert admit_walk_in raises
    // 'Session is not open for admission'
  });

  it('book_session still produces source = \'self_service\' after this column\'s addition', async () => {
    // spec testing requirement 11: a plain regression check that this
    // task's new session_bookings.source column's default doesn't
    // silently change ordinary self-service booking behavior. Seed a
    // normal bookable session, call book_session (not admit_walk_in)
    // through a signed-in participant client exactly as earlier tasks'
    // tests already do, then assert the resulting session_bookings
    // row's source column is 'self_service'.
  });
});

describe('scan_attempt_transactional booking_id linkage', () => {
  it('populates booking_id when a matching active booking exists', async () => {
    // seed an active self-service booking; call scan_attempt_transactional
    // (via its RPC, with whatever minimal valid args this codebase's
    // existing attendance live tests already use -- check
    // tests/attendance/*.test.ts for the established call pattern
    // before writing this) in a way that results in admission; assert
    // the resulting attendance_records row's booking_id matches the
    // booking's id
  });

  it('leaves booking_id NULL when no matching active booking exists', async () => {
    // no prior booking; admission still succeeds via the normal
    // flexible/priority path; assert booking_id is null
  });
});
```

For both `describe` blocks, check `tests/attendance/*.test.ts` (any existing live test file calling `scan_attempt_transactional`) for the established fixture pattern (session setup, `admission_policy`, how a caller satisfies `is_staff()`/scanner authorization in a test context) before writing these tests from scratch — reuse that pattern rather than inventing a new one.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agenda/booking-rules-completion-live.test.ts`

Expected: all tests (16 from Tasks 1/3/4, plus 8 new = 24) PASS.

- [ ] **Step 6: Also re-run existing attendance live tests to confirm `scan_attempt_transactional`'s edit didn't regress anything**

Run: `npx vitest run tests/attendance/` (every live test file in that directory that exercises `scan_attempt_transactional`/`scan_qr_attempt_transactional` — exclude the two files with pre-existing unrelated typecheck errors from this run only if they also fail to execute for that reason; otherwise include them).

Expected: no new failures attributable to this task's change. If anything fails, the `scan_attempt_transactional` edit has a bug — fix the migration, not the pre-existing tests.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint tests/agenda/booking-rules-completion-live.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20261006050000_walk_in_admission.sql tests/agenda/booking-rules-completion-live.test.ts src/types/database.ts
git commit -m "feat: add walk-in admission RPC and link attendance to bookings"
```

---

### Task 7: Walk-in admin UI

**Files:**
- Create: `src/app/[locale]/(admin)/attendance/walk-in/page.tsx`
- Create: `src/app/[locale]/(admin)/attendance/walk-in/actions.ts`
- Create: `src/app/[locale]/(admin)/attendance/walk-in/walk-in-admission-form.tsx`

Depends on Task 6 (`admit_walk_in` must exist). Follows the `attendance/<feature>/{page.tsx,actions.ts,<feature>-manager.tsx}` three-file convention already used by `attendance/admissions/` and `attendance/scanners/`.

- [ ] **Step 1: Read the existing `attendance/admissions/` three files in full**

Before writing anything, read `src/app/[locale]/(admin)/attendance/admissions/page.tsx`, `actions.ts`, and `admission-management-console.tsx` completely — this is the closest existing precedent (same feature domain, same staff-auth helper) and the new walk-in page should match its structure as closely as the simpler feature allows.

- [ ] **Step 2: Write the server action**

In `actions.ts`, use `requireAdmissionStaffCaller` (from `src/lib/admission/server-helpers.ts` — the admission-domain-scoped staff helper, not the generic agenda one) to gate a single exported action:

```ts
'use server';
import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';

export async function admitWalkIn(applicationId: string, sessionId: string) {
  const { session } = await requireAdmissionStaffCaller();
  const { data, error } = await session.rpc('admit_walk_in' as never, {
    p_application_id: applicationId,
    p_session_id: sessionId,
  });
  if (error) return { error: error.message };
  return { bookingId: data as string };
}
```

Use `session` (the real `auth.uid()`-bearing client), not `service`, since `admit_walk_in` is `security definer` with its own `is_staff()` check that needs a real authenticated caller — confirm this against `requireAdmissionStaffCaller`'s actual return shape (read `src/lib/admission/server-helpers.ts` in full first; it was not fully read during research, only its signature was confirmed) before finalizing which client to pass.

- [ ] **Step 3: Write the page and form**

`page.tsx`: server component, staff-gated (same pattern as `admissions/page.tsx`), fetches a list of confirmed sessions (id, title_en/ar, start_time — for a simple picker) and renders `<WalkInAdmissionForm sessions={...} />`.

`walk-in-admission-form.tsx`: client component — a session `<select>`, a text input to search/select an accepted applicant (simplest viable approach: a text input for the applicant's email or application number, resolved server-side in the action rather than building a full autocomplete/search UI — keep this minimal per the spec's explicit "minimal standalone admin page" framing, scope decision 13), and a "Admit" button calling `admitWalkIn`. Show the RPC's error text verbatim on failure (same established pattern as every other admin form in this codebase), and a success confirmation on success.

If resolving an applicant by email/application-number requires a lookup the action doesn't yet do, add that lookup to `admitWalkIn` itself (resolve the identifier to an `application_id` via a `.from('applications').select('id').eq(...)` query before calling the RPC) rather than pushing that complexity into the form component.

- [ ] **Step 4: Manual browser verification or self-review**

Same pattern as prior UI tasks.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint "src/app/[locale]/(admin)/attendance/walk-in/"`.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/(admin)/attendance/walk-in/"
git commit -m "feat: add standalone walk-in admission admin page"
```

---

### Task 8: Session edit form occupancy indicator

**Files:**
- Modify: `src/app/[locale]/(admin)/agenda/sessions/[id]/page.tsx`
- Modify: `src/app/[locale]/(admin)/agenda/sessions/[id]/session-edit-form.tsx`

Depends on Task 3 (the capacity-downsize trigger must exist for this indicator to be meaningfully paired with a real rejection path) — purely informational, no hard dependency otherwise.

- [ ] **Step 1: Read both files in full**

Read the current `page.tsx` and `session-edit-form.tsx` completely (not excerpted during research) before editing — this plan's author did not read these in full.

- [ ] **Step 2: Add the occupancy query**

In `page.tsx`, add a call to `session_effective_occupied_count` (via RPC: `.rpc('session_effective_occupied_count' as never, { p_session_id: id })`) alongside the session's existing data fetch, and pass the result to `SessionEditForm` as a new prop (e.g. `currentlyBooked: number`).

- [ ] **Step 3: Add the indicator**

In `session-edit-form.tsx`, near the existing `capacity` number input, add a small read-only text line: `Currently booked: {currentlyBooked} / {capacity}` (or the equivalent i18n-aware phrasing, following this form's existing localization convention — check whether this form uses `next-intl` translations or plain English strings like the participant-facing booking UI, and match whichever it already does).

- [ ] **Step 4: Manual browser verification or self-review**

Same pattern as prior UI tasks — this one is easier to verify since any existing session with bookings works.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint "src/app/[locale]/(admin)/agenda/sessions/[id]/"`.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/(admin)/agenda/sessions/[id]/"
git commit -m "feat: show current booking count on session edit form"
```

---

### Task 9: Full sweep and final review

**Files:**
- Modify: `tests/agenda/booking-rules-completion-live.test.ts` (if any gaps found)

- [ ] **Step 1: Full relevant-suite run**

Run: `npx vitest run tests/agenda tests/email tests/attendance` (mirrors the scope of 4c's/4d's own final sweeps, extended to include `tests/attendance` given this sub-project's edit to `scan_attempt_transactional`). Confirm zero regressions, paying particular attention to any test file exercising `cancel_booking`, `book_session`, `join_waitlist`, or `scan_attempt_transactional` specifically (the four existing functions this sub-project modifies).

- [ ] **Step 2: Full typecheck and lint**

Run: `npx tsc --noEmit` (compare any output against master's pre-existing baseline — verify via `git diff master -- <file>` that any file showing errors was genuinely untouched by this branch before dismissing it) and `npx eslint src/ tests/agenda/booking-rules-completion-live.test.ts`.

- [ ] **Step 3: Dispatch a final whole-branch code-reviewer subagent**

Covering the full diff against `master`, cross-referencing the spec, with particular attention to: does `cancel_booking`'s promotion-loop extraction genuinely preserve its exact prior behavior (diff the two full function bodies line-by-line, not just trust the migration comments); does the no-show cron's time-window query correctly bound both edges (15-minute threshold AND the lookback window, not just one); does `admit_walk_in`'s authorization and capacity-check locking hold up under the same scrutiny the spec review already gave it; is the global deadline genuinely applied as `min()` (hard ceiling) everywhere the spec claims, not accidentally as a floor or an unconditional override anywhere.

- [ ] **Step 4: Proceed to `superpowers:finishing-a-development-branch`**

Push, create a PR (reusing the title/body pattern from 4c's PR #9 / 4d's PR #10), await merge, clean up the worktree and branch — matching the exact pattern used for 4a/4b/4c/4d.
