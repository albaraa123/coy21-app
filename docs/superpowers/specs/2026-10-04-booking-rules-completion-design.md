# Booking Rules Completion (4e) Design

**Sub-project:** 4e of the Sessions/Booking/Work-Groups roadmap item (sub-project 4 of 6 in the overall COY21 platform plan). Builds on 4a (timezone unification), 4b (booking/allocation conflict unification), 4c (session cancellation/reschedule lifecycle), and 4d (work-group waitlist) — all merged to `master`.

## Problem

Four booking rules from the original project request were never built:

1. **A general booking closing deadline** — a single platform-wide cutoff, distinct from the existing per-session `booking_deadline`.
2. **Room-capacity downsizing after bookings exist** — no guard currently prevents reducing a session's `capacity` below its active booking count.
3. **No-show seat release** — a booked-but-absent participant's seat is never freed today; nothing in the codebase even detects a no-show.
4. **Walk-in attendance** — a participant who never booked a session self-service but shows up at the door has no admission path (one of two cases from the original request; the second, a participant who booked but arrives late, is explicitly deferred — see Out of Scope).

Investigation found two previously-unrelated systems that this work must bridge for the first time:

- **`session_bookings`** (self-service booking, built in 4a–4d): records who *intends* to attend a session.
- **`attendance_records`/`scan_attempts`** (Phase 6 QR admission, a fully separate door-entry system): records who *actually* showed up, decided independently of `session_bookings` via an `admission_policy`/priority-pool/QR-scan layer that has never referenced `session_bookings` at all.

"No-show" has no meaning without linking these two — you cannot know someone didn't show up for *their own booking* unless attendance can be traced back to a specific booking. Walk-in admission needs the same link in reverse: a walk-in participant has no booking yet, so admitting them must create one.

## Scope Decisions

All confirmed with the user during brainstorming:

1. **Link attendance to bookings.** A new nullable `attendance_records.booking_id` column, filled in by `scan_attempt_transactional` (the sole write authority for `attendance_records`, per its own code comment) whenever a matching active `session_bookings` row exists for the scanned participant+session. NULL when none exists (e.g., a flexible/priority-pool admission with no prior self-service booking) — not an error, just unlinked.
2. **No-show is computed by elapsed time, not an active check-in window.** A session's bookings are evaluated 15 minutes after `start_time`, regardless of whether that session has QR check-in meaningfully configured (`enable_qr_checkin` is a confirmed-dead placeholder column per the Phase 6 spec — not consulted by any code today, and not consulted here either). Simplicity over precision: a universal rule needs no per-session configuration.
3. **Walk-in scope: one case only.** A participant with an accepted `applications` row who never booked this specific session requests entry at the door. The second case the original request implied (a participant who booked but arrives late) is explicitly deferred — see Out of Scope.
4. **Global deadline is a hard ceiling, not a floor.** `effective_deadline = min(global_booking_deadline, per-session effective deadline)`. A global deadline can only make booking close *earlier* across the board; it never reopens or extends a session whose own deadline is already earlier. Applies uniformly to `book_session`, `join_waitlist`, and `cancel_booking` — exactly mirroring how the existing per-session deadline already gates all three today (`leave_waitlist` has no deadline check today and stays that way).
5. **Global deadline storage: new `conference_settings` singleton table**, modeled directly on the existing `email_settings` table (the only precedent for a single-row settings table in this codebase) — `id boolean primary key default true`, `super_admin`-only write access.
6. **Session capacity downsizing: reject outright**, mirroring the existing `revalidate_sessions_on_room_capacity_change` trigger's own pattern exactly (reject with a clear error naming the current count; never silently cascade a status change onto overflow bookings).
7. **No-show releases the seat through the same FIFO waitlist-promotion logic 4d already built** (`cancel_booking`'s promotion loop) — only for sessions whose type has `enable_waitlist = true`, exactly matching 4d's existing scope boundary.
8. **No-show gets its own distinct `booking_status` enum value, `'no_show'`** (not a reuse of `'cancelled'`), mirroring 4c's own precedent for `'session_cancelled'` — so `/my-agenda` can render a clearly distinct state instead of conflating a no-show with a voluntary cancellation.
9. **Walk-in bookings reuse the existing `'active'` status**, distinguished instead by a new `session_bookings.source` column (`'self_service' | 'walk_in'`). Chosen over a dedicated status value specifically because it requires zero changes to any existing `status = 'active'` check site (`cancel_booking`, `/my-agenda`, `session_effective_occupied_count`, the no-show cron) — a walk-in booking behaves identically to a self-service one everywhere except where `source` is explicitly consulted (nowhere, in this sub-project — `source` exists purely for future reporting).
10. **Walk-in admission capacity check: live admitted headcount, not booking/allocation count.** `count(attendance_records where session_id = X and status = 'admitted') < sessions.capacity` — the question at the door is "is there a physically open seat right now," which `session_effective_occupied_count()` (bookings + allocations, ignoring whether anyone showed up) does not answer. A session can be "full" by booking count but have physically empty seats from no-shows; walk-in must see the live-admitted number, not the reservation number.
11. **Walk-in admission performs zero time-conflict checking.** The participant is already physically standing at this specific session's door; whether they also hold a conflicting booking elsewhere is the door staff's call to make, not a system rejection — mirrors the same reasoning already applied to the Phase 6 admission system's own override path.
12. **Walk-in creates both a `session_bookings` row (`source = 'walk_in'`) and an `attendance_records` row (linked via `booking_id`), atomically, in one new RPC (`admit_walk_in`).** This makes a walk-in participant's session show up normally in `/my-agenda` and count correctly toward `session_effective_occupied_count()` for any *other* session they might later try to book (closing a real self-conflict gap, not just a reporting nicety).
13. **Walk-in admission caller: the same scanner operator / door staff who already runs the existing QR scanning flow**, via a **new, separate, simple admin page** — explicitly *not* integrated into the existing `scanner-client.tsx` UI and its `resolve-admission-decision`/`result-presentation` decision layer. That UI is substantially more complex than initially scoped (its own override system, result-presentation mapping, scanner-scope re-verification), and correctly integrating a new affordance into it is a distinct task this sub-project explicitly defers — see Out of Scope. 4e delivers a fully working `admit_walk_in` RPC plus a minimal standalone admin page (pick a session, pick an accepted applicant, confirm) that calls it directly.

## Data Model

### `conference_settings` (new table)

```sql
create table conference_settings (
  id boolean primary key default true,
  constraint conference_settings_singleton check (id = true),
  global_booking_deadline timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);
insert into conference_settings (id) values (true);
```

RLS mirrors `email_settings` exactly: staff can read, only `super_admin` can write (via a dedicated RPC or direct update gated by role check — final shape decided during planning, following whatever `email_settings`'s own write path actually does).

### `session_effective_deadline()` — replaces 8 duplicated inline calculations

The existing `session_effective_deadline(p_session sessions)` function (defined in 4a's migration, confirmed dead code — never actually called by any of the 8 call sites that each reimplement its formula inline) is replaced:

```sql
create or replace function session_effective_deadline(p_session sessions) returns timestamptz
language sql stable as $$
  select least(
    coalesce((select global_booking_deadline from conference_settings), 'infinity'::timestamptz),
    coalesce(p_session.booking_deadline, p_session.start_time - interval '3 hours')
  );
$$;
```

`book_session`, `join_waitlist`, and `cancel_booking` are each updated (`create or replace function`, no other logic changes) to call `session_effective_deadline(v_session)` instead of their current inline `coalesce(...)` expression. `leave_waitlist` is untouched (no deadline check, by design, unchanged from 4d).

### `booking_status` enum extension

```sql
alter type booking_status add value 'no_show';
```

Own isolated migration, per this repo's established `ALTER TYPE ... ADD VALUE`-must-commit-first convention (same pattern as every prior enum extension in 4c/4d).

### `session_bookings.source` (new column)

```sql
alter table session_bookings add column source text not null default 'self_service'
  check (source in ('self_service', 'walk_in'));
```

### `sessions.no_show_processed_at` (new column)

```sql
alter table sessions add column no_show_processed_at timestamptz;
```

Idempotency marker for the no-show cron — mirrors the existing timestamp-marker pattern already used elsewhere on `sessions` (`published_at`, `confirmed_at`, `cancelled_at`).

### `attendance_records.booking_id` (new column)

```sql
alter table attendance_records add column booking_id uuid references session_bookings(id);
```

Nullable — a scan that results in admission via the priority/flexible/restricted decision tree may have no corresponding self-service booking at all; that is a normal, expected NULL, not an error state.

### `attendance_records.entry_type` check constraint

The existing constraint (`check (entry_type in ('priority', 'flexible', 'override'))`) is widened to include `'walk_in'`:

```sql
alter table attendance_records drop constraint attendance_records_entry_type_check;
alter table attendance_records add constraint attendance_records_entry_type_check
  check (entry_type in ('priority', 'flexible', 'override', 'walk_in'));
```

(A plain `text` + `check` column, not a Postgres enum — altering it is a single migration, no isolation requirement.)

## Session Capacity Downsize Guard

New trigger on `sessions`, mirroring `revalidate_sessions_on_room_capacity_change`'s exact shape (same file family, same `set search_path = public, pg_temp` convention, same reject-don't-cascade philosophy):

```sql
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

Uses `session_effective_occupied_count()` (the existing 4b function: active `session_bookings` + confirmed `allocation_assignments`) — the same combined count `book_session`/`join_waitlist` already enforce, so this guard's notion of "occupied" matches booking reality exactly, with no second source of truth.

## No-Show Detection and Seat Release

New SQL function, called by a new cron route mirroring `process-session-notifications`'s exact structure (CRON_SECRET bearer-token guard, 5-minute cadence, stateless per-row processing):

```sql
create function process_session_no_shows(p_session_id uuid) returns void
language plpgsql as $$
declare
  v_booking record;
  v_enable_waitlist boolean;
begin
  select st.enable_waitlist into v_enable_waitlist
  from sessions s join session_types st on st.id = s.session_type_id
  where s.id = p_session_id;

  for v_booking in
    select sb.id, sb.application_id
    from session_bookings sb
    where sb.session_id = p_session_id
      and sb.status = 'active'
      and not exists (
        select 1 from attendance_records ar
        where ar.booking_id = sb.id and ar.status = 'admitted'
      )
  loop
    update session_bookings set status = 'no_show' where id = v_booking.id;

    if coalesce(v_enable_waitlist, false) then
      -- Re-run the same FIFO/conflict-skip/cross-waitlist-withdrawal
      -- promotion logic cancel_booking() already implements (4d), scoped
      -- to this one freed seat. Exact mechanism (a shared helper function
      -- both cancel_booking and this call into, vs. duplicated inline
      -- logic) is a planning-stage decision — see plan.
      perform promote_next_waitlist_candidate(p_session_id, v_booking.application_id);
    end if;
  end loop;

  update sessions set no_show_processed_at = now() where id = p_session_id;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

The cron route queries `sessions where start_time + interval '15 minutes' <= now() and no_show_processed_at is null`, calling `process_session_no_shows()` once per matching session. Note: extracting `cancel_booking`'s inline promotion loop into a shared `promote_next_waitlist_candidate()` helper (rather than duplicating ~40 lines of FIFO/conflict-check/cross-withdrawal SQL a second time) is the clear right call here — the exact extraction shape is a planning-stage decision, not a design-stage one, since it requires re-reading `cancel_booking`'s current full body line-by-line to do safely.

## Walk-In Admission

New SECURITY DEFINER RPC, `admit_walk_in(p_application_id uuid, p_session_id uuid)`, modeled structurally on `book_session`'s shape (same auth-check pattern, same row-lock-then-validate flow) but with deliberately narrower validation per the scope decisions above:

```sql
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
  -- Caller authorization: staff only (not the applicant themselves --
  -- this is a door-staff action). Exact role check mirrors whatever
  -- scan_attempt_transactional's own staff/scanner authorization
  -- currently requires -- confirmed during planning.
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

  insert into session_bookings (application_id, session_id, source)
  values (p_application_id, p_session_id, 'walk_in')
  returning id into v_booking_id;

  insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, booking_id)
  values (p_application_id, p_session_id, compute_time_slot_group_key_for_session(p_session_id), 'walk_in', auth.uid(), v_booking_id);

  return v_booking_id;
end;
$$;
```

No deadline check (scope decision 11 implies this is irrelevant at the door — a walk-in happens *during* the session, not before it), no time-conflict check, no waitlist interaction (a walk-in bypasses the waitlist entirely — the participant is being seated directly by staff judgment).

`scan_attempt_transactional` (the existing Phase 6 function, current authoritative version in `20260928000000_scan_attempt_transactional_scope_check.sql`) is separately modified to populate `attendance_records.booking_id` on its own existing `insert into attendance_records (...)` statement (line ~183), adding a lookup:

```sql
select id into v_matched_booking_id from session_bookings
where application_id = p_application_id and session_id = p_session_id and status = 'active';
```

...and passing `v_matched_booking_id` as the new `booking_id` value. This is the one change to the existing QR scan path — everything else about that function (the advisory lock, the admission-policy decision tree, the scanner-scope re-check) is untouched.

## UI Changes

- **New admin page** (location: likely `(admin)/settings/` alongside the existing settings area) for `super_admin` to view/set/clear `global_booking_deadline`.
- **New admin page** (location: likely `(admin)/attendance/` alongside the existing `admissions`/`scanners` pages) for staff to admit a walk-in: select a session, select/search an accepted applicant, confirm. Calls `admit_walk_in` directly. Explicitly standalone, not integrated into the existing scanner UI (scope decision 13).
- **Admin session edit form**: add a read-only "Currently booked: N / capacity" indicator near the capacity input, so staff see occupancy before attempting a downsize that the new trigger will reject. The capacity field's existing save-error surface already shows RPC error text verbatim (same pattern as every other admin form in this codebase), so the trigger's rejection message requires no new error-handling code — only the informational indicator is new.
- **`/my-agenda`**: add a `noShow` Badge variant (same pattern as `sessionCancelled`/`waitlisted` from prior sub-projects) so a no-show booking renders distinctly from a voluntary cancellation.

## Testing Requirements

Live integration tests, following the established conventions from 4c/4d's live test files (`runId`-suffixed fixtures, dedicated room per session, signed-in participant client for `auth.uid()`-gated RPCs, careful `afterAll` cleanup ordering):

1. `session_effective_deadline()` returns the earlier of the global deadline and the per-session effective deadline, in both directions (global earlier wins; per-session earlier wins; global NULL falls back to per-session only).
2. `book_session`/`join_waitlist`/`cancel_booking` each reject past the computed effective deadline (global-driven case specifically, not just the pre-existing per-session case already covered by 4a/4b tests).
3. Session capacity downsize is rejected when the new capacity would be below `session_effective_occupied_count()`; succeeds when at or above it.
4. No-show cron: an active booking with no `attendance_records` row 15+ minutes after session start is marked `no_show`; a booking with a matching admitted attendance record is left `active`.
5. No-show seat release triggers waitlist promotion only when the session's type has `enable_waitlist = true`; no promotion attempt occurs otherwise.
6. No-show cron idempotency: a second cron pass over an already-processed session (`no_show_processed_at` set) makes no further changes.
7. `admit_walk_in` succeeds when admitted count < capacity; rejects at capacity.
8. `admit_walk_in` rejects a duplicate (participant already has an active booking for this session).
9. `admit_walk_in` creates both a `session_bookings` row (`source = 'walk_in'`) and a linked `attendance_records` row atomically; both are visible via the normal `/my-agenda` and `session_effective_occupied_count()` query paths exactly as a self-service booking would be.
10. `scan_attempt_transactional` correctly populates `attendance_records.booking_id` when a matching active booking exists, and leaves it NULL when none exists (both cases, live).

## Out of Scope

- **The second walk-in case** (a participant who booked self-service but arrives late) — deferred to a future sub-project; the original request's "two cases" is intentionally narrowed to one for 4e, confirmed with the user.
- **Integrating walk-in admission into the existing scanner UI** (`scanner-client.tsx` and its `resolve-admission-decision`/`result-presentation` layer) — 4e ships a working RPC and a separate, simple standalone admin page; folding this into the scanner's existing decision/override system is deferred as its own future task.
- **No-show/walk-in analytics or reporting** beyond the `/my-agenda` badge — the mechanism (status tracking, seat release) is in scope; dashboards or aggregate reports are not.
- **Retroactive processing** of sessions already past their 15-minute no-show threshold at the moment this ships — the cron only acts going forward from deployment.
- **Dropping the four confirmed-dead legacy columns** (`is_mandatory`, `enable_qr_checkin`, `checkin_opens_at`, `checkin_closes_at`) that the Phase 6 spec already flagged for future cleanup — unrelated to this sub-project's scope, left untouched.
