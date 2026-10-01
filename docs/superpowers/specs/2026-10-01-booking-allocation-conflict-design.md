# Booking/Allocation Conflict Unification — Design

**Sub-project:** 4b of the Sessions/Booking/Work-Groups roadmap item (sub-project 4 of 6 in the overall COY21 platform plan).

## 1. Problem

Two independent systems can place a participant into a session:

1. **Self-service booking** (`session_bookings`, `book_session()`/`cancel_booking()` RPCs, built 2026-08-23) — a participant books their own elective sessions through `/my-agenda/browse`.
2. **Allocation** (`allocation_assignments`, built via the admin-run `runAllocation()` algorithm, confirmed via `confirm_allocation_run_transactional()`, 2026-07-23) — staff run an algorithm that assigns each participant a personal schedule, including mandatory sessions. This is the system that actually drives door-level admission (`src/lib/attendance/scan-attempt.ts` reads `allocation_assignments`, never `session_bookings`).

These two systems are fully data-isolated: no SQL function, trigger, or application code anywhere reads from both tables in the same operation (confirmed by exhaustive grep across every migration and every `src/` file). Each independently checks time-conflict and capacity only against its own table:

- `book_session()` (`supabase/migrations/20260823020000_session_bookings.sql:85-143`) checks conflicts only against other `session_bookings` rows, and capacity only via `session_active_booking_count()` (same file, lines 73-77), which counts only `session_bookings` rows.
- The allocation algorithm (`src/lib/allocation/run-allocation.ts`) checks conflicts and capacity only against its own in-memory candidate list for the current run.

This means a participant can be assigned to a mandatory session by the algorithm, then separately self-book a time-conflicting elective session through the (more UI-prominent) booking flow — with neither system aware of the collision, and no capacity counter reflecting the other system's occupancy. `/my-agenda` (self-bookings) and `/schedule` (published allocation) are two separate pages with zero merge logic, so a participant with both never sees a warning.

**Scope decisions (confirmed with user):**
- Fix is **one-directional**: `book_session()` must respect existing confirmed allocations. The allocation algorithm itself stays blind to `session_bookings` (not changed in this sub-project).
- Conflict: **strict prevention** — `book_session()` rejects a booking that time-overlaps a confirmed allocation assignment for the same participant (not just a warning).
- Capacity: **unified** — a session's remaining capacity, as enforced by `book_session()`, is `sessions.capacity` minus (active `session_bookings` count + confirmed `allocation_assignments` count) for that session.
- Source of truth for "confirmed": `allocation_assignments` where `status = 'confirmed'`, read directly (not via `schedule_publication_items`, since publication can lag behind confirmation and the spec intentionally checks against the closer-to-real-time source).
- Pre-existing conflicting data (bookings made before this fix existed, now conflicting with a confirmed allocation): **no automatic cleanup**. A read-only diagnostic query is provided for the team to review manually; no booking is cancelled or modified by this sub-project.

**Explicitly out of scope:** merging the `/my-agenda` and `/schedule` UI into one view; any change to the allocation algorithm, confirmation, or publication pipeline; any change to `cancel_booking()` (a participant can still freely cancel their own booking up to the deadline, regardless of allocation state — this was never in conflict, since cancelling only removes a row).

## 2. `book_session()` changes

Migration `supabase/migrations/20261003000000_book_session_respects_allocation.sql` does `create or replace function book_session(...)`, keeping the existing signature, authorization check, session-row lock, status check, and deadline check unchanged. Two additions, inserted between the existing deadline check and the existing capacity check:

**Capacity check (replaces the existing one):** `session_active_booking_count(p_session_id)` is replaced by a new combined count. Rather than overloading the existing function's meaning, a new function `session_effective_occupied_count(p_session_id uuid) returns int` is added:

```sql
create function session_effective_occupied_count(p_session_id uuid) returns int
language sql stable as $$
  select
    (select count(*)::int from session_bookings where session_id = p_session_id and status = 'active')
    +
    (select count(*)::int from allocation_assignments where session_id = p_session_id and status = 'confirmed');
$$;
```

`book_session()`'s capacity check becomes `v_count := session_effective_occupied_count(p_session_id); if v_count >= v_session.capacity then raise exception 'Session is full'; end if;` — same exception text as today (no consumer currently pattern-matches this specific message, confirmed by grep, so no contract to preserve here unlike the day-match trigger in sub-project 4a).

**Conflict check (new, added after the existing `session_bookings`-vs-`session_bookings` conflict check):**

```sql
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
```

Distinct exception text (`'Time conflict with an assigned session'` vs. the existing `'Time conflict with an existing booking'`) so the two conflict sources remain distinguishable in logs and could later drive different UI copy, without requiring any UI change in this sub-project (the existing error-handling in `src/app/[locale]/(participant)/(shell)/my-agenda/actions.ts` just surfaces `error.message` as-is; no new logic is required for this sub-project's UI to already show the distinct message string).

`session_active_booking_count()` is **not deleted** — nothing else references it today, but removing a function in the same migration that a different team member might be mid-edit on is unnecessary risk for a one-line savings; it simply becomes unused. (Consistent with the project's established preference against adding back-compat shims for things actively removed — but this is different: it's an existing, still-valid helper nobody currently calls, not a deprecated shim.)

## 3. Capacity display fix — `/my-agenda/browse`

`src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx:58-66` currently builds `countMap` from `session_bookings` only, using the participant-scoped `createClient()`. Participants have no RLS access to `allocation_assignments` (staff-only `is_staff()` policy), so this page cannot query that table directly.

New function, same migration as above:

```sql
create function session_allocation_confirmed_counts() returns table(session_id uuid, confirmed_count int)
language sql stable security definer set search_path = public, pg_temp as $$
  select session_id, count(*)::int as confirmed_count
  from allocation_assignments
  where status = 'confirmed'
  group by session_id;
$$;

revoke execute on function session_allocation_confirmed_counts() from public;
grant execute on function session_allocation_confirmed_counts() to authenticated;
```

Returns only aggregate counts per session (no participant identity, no individual assignment data) — safe to expose to any authenticated participant without loosening `allocation_assignments`' own RLS. `browse/page.tsx` calls this via `supabase.rpc('session_allocation_confirmed_counts')` and merges the result into `countMap` (added to, not replacing, the existing `session_bookings`-derived counts), so `bookedCount`/`isFull` in the rendered UI matches exactly what `book_session()` will actually enforce — eliminating the "looks available, booking gets rejected" confusion this gap would otherwise cause once the RPC fix ships.

## 4. Diagnostic query for pre-existing conflicts

A plain SQL query (not a migration, saved as `scripts/diagnose-booking-allocation-conflicts.sql`, run manually and reviewed by the team — never executed automatically) finds every active `session_bookings` row whose participant also has a confirmed `allocation_assignments` row for a time-overlapping session:

```sql
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

## 5. Testing

Live tests (`tests/agenda/booking-allocation-conflict-live.test.ts`, against the scratch project), covering every scenario named in the original request plus the ones this design introduces:

- `book_session()` rejects a booking that time-overlaps a `confirmed` allocation assignment for the same participant (`'Time conflict with an assigned session'`).
- `book_session()` **allows** a booking that time-overlaps a `proposed` (not yet confirmed) allocation assignment — only `confirmed` counts.
- `book_session()` rejects when combined (`session_bookings` + confirmed `allocation_assignments`) occupancy already equals `sessions.capacity`, even if `session_bookings` alone is under capacity.
- `book_session()` still succeeds for a session with zero allocation assignments at all (no regression on the existing, already-tested behavior from the original migration).
- `session_allocation_confirmed_counts()` returns correct per-session aggregate counts and is callable by an `authenticated` role with no staff privileges (RLS/grant check).
- The diagnostic query (tested by direct execution against a fixture, not as an RPC) correctly identifies a known-conflicting fixture pair and correctly excludes a non-conflicting one.

## 6. Files touched (summary)

**New:**
- `supabase/migrations/20261003000000_book_session_respects_allocation.sql`
- `scripts/diagnose-booking-allocation-conflicts.sql`
- `tests/agenda/booking-allocation-conflict-live.test.ts`

**Modified:**
- `src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx`
