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

**Shared promotion helper, extracted from `cancel_booking`'s current promotion loop.** Reading `cancel_booking`'s authoritative current body (`20261005045000_fix_promotion_recheck_comment.sql`) confirms the promotion loop depends only on `v_session` (for `session_id`/`start_time`/`end_time`, used in the FIFO scan and both conflict-overlap checks) — it never uses the cancelling participant's own `application_id` anywhere. That makes extraction clean: the helper takes just the session id, re-selects the session row itself, and the *reason* a seat freed up (voluntary cancellation vs. no-show) is irrelevant to the promotion logic itself. `cancel_booking` is updated to call this helper in place of its current inline loop (pure refactor, no behavior change — verified by keeping its existing test suite green); the no-show function calls the same helper.

```sql
create function promote_next_waitlist_candidate(p_session_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session         sessions%rowtype;
  v_candidate        record;
  v_new_booking_id   uuid;
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
```

This also closes a gap the spec review caught: the earlier draft's no-show sketch never queued a `waitlist_promoted` notification, meaning a no-show-triggered promotion would have silently differed from a cancellation-triggered one. Reusing the exact same helper makes that impossible by construction — both call sites get identical promotion behavior, including the notification, with no duplicated logic to drift.

**No-show detection function:**

```sql
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
```

**Idempotency — per-booking, not per-session.** The original draft of this spec used a single `sessions.no_show_processed_at` timestamp to prevent the cron from reprocessing a session twice. Spec review correctly identified this as a latent bug: if a new active booking is created on a session *after* that session's one no-show pass already ran (e.g., a waitlist promotion triggered by an earlier no-show on the *same* session, or simply a late walk-in admission before the session's own no-show sweep), a session-level marker would permanently block that later booking from ever being checked — it would stay `active` forever even if its holder never shows up.

Fixed by moving the idempotency check to the row being evaluated, which is also simpler: the function's own `where ... not exists (select 1 from attendance_records ...)` check only needs to additionally exclude bookings already marked `no_show`, which it already does implicitly (the `where sb.status = 'active'` clause excludes them — a booking only gets evaluated once, since the function flips it to `'no_show'` the first time and it never matches `status = 'active'` again). **No separate marker column is needed at all** — `sessions.no_show_processed_at` is removed from the Data Model section entirely. The cron route's own query for *which sessions to call* `process_session_no_shows()` **on** still needs a time filter (`start_time + interval '15 minutes' <= now()`), but does not need a processed-marker — calling the function again for a session with zero remaining un-admitted active bookings is a correct, cheap no-op (the loop simply finds no rows), so re-invoking it every 5 minutes for the same session indefinitely is harmless, not wasteful in any way that matters at this scale.

The cron route (mirroring `process-session-notifications`'s exact structure: `CRON_SECRET` bearer-token guard, 5-minute cadence) queries `sessions where start_time + interval '15 minutes' <= now() and status = 'confirmed'` (bounded to a reasonable recent time window — exact window size is a planning-stage detail, e.g. "started within the last 2 hours," to avoid an ever-growing scan as the conference progresses) and calls `process_session_no_shows()` once per matching session.

**Concurrency note** (spec review correctly flagged the original draft's silence on this): `process_session_no_shows` now takes `for update of sb` on each candidate booking before flipping its status, the same lock discipline `promote_next_waitlist_candidate`'s own loop already uses — this protects against the cron racing a concurrent `cancel_booking`/`leave_waitlist` call for the same booking. `cancel_booking` already takes its own `for update` lock on the specific `session_bookings` row it's cancelling, so the two paths cannot corrupt each other's write; whichever acquires the row lock first wins, and the other's conflicting update simply won't find a matching `status = 'active'` row to act on by the time it proceeds (Postgres's standard lock-then-re-evaluate behavior, the same `EvalPlanQual` mechanism 4d's `20261005045000` migration comment already documents in detail for this exact codebase).

**Within-pass promotion feedback is safe by construction, not by luck.** Each no-show flip inside the loop may call `promote_next_waitlist_candidate`, which inserts a brand-new `active` `session_bookings` row for this same session. PL/pgSQL's `for v_booking in <query> loop` materializes its result set once, when the cursor opens — so a row inserted *during* the loop's execution is never a candidate the same loop iteration could see or act on. The newly-promoted booking cannot be immediately flipped back to `no_show` within the same `process_session_no_shows` call; it's only eligible for evaluation on a later pass (correctly covered by testing item 6's "a booking added to the session after the first pass is still correctly evaluated on the next pass").

## Walk-In Admission

New SECURITY DEFINER RPC, `admit_walk_in(p_application_id uuid, p_session_id uuid)`, modeled structurally on `book_session`'s shape (same row-lock-then-validate flow) but with deliberately narrower validation per the scope decisions above.

**Authorization: `is_staff()`, decided now, not deferred.** The original draft deferred this to planning with a comment claiming it would "mirror `scan_attempt_transactional`'s own staff/scanner authorization" — spec review correctly caught that this doesn't hold up: reading `scan_attempt_transactional`'s current authoritative body shows it has **no in-function role check at all**; its real authorization happens in TypeScript (`verifyScannerScope`, called before the RPC) and the RPC itself trusts its caller, reachable from the "non-scope-limited" admission-review override path with no role gate inside the function. There is nothing to mirror. Since the new standalone admin page this spec introduces (scope decision 13) has no described TypeScript-side pre-check of its own, `admit_walk_in`'s own `is_staff()` check is the **sole** authorization gate for this feature — so it's decided here, explicitly, rather than left open: `is_staff()` (the existing helper from the staff-role-consolidation work), same as every other staff-only RPC in this codebase.

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
  if not is_staff() then
    raise exception 'Not authorized';
  end if;

  if not exists (select 1 from applications where id = p_application_id and status = 'accepted') then
    raise exception 'Application not found or not accepted';
  end if;

  -- The for update lock held here for the rest of this function's
  -- transaction is what makes the capacity check below safe against two
  -- concurrent admit_walk_in calls for the same session: a second call
  -- blocks on this same lock until the first commits (or rolls back),
  -- so the two calls' capacity reads can never interleave -- the second
  -- call's read happens only after the first's insert has committed,
  -- always seeing the up-to-date admitted count. Same serialization
  -- mechanism book_session already relies on for its own capacity
  -- check.
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
    -- attendance_records_no_duplicate_active (one active admission per
    -- application+session) can still fire here despite the pre-check
    -- above, under the same kind of race this codebase already hit and
    -- fixed once in join_waitlist (20261005035000) -- re-raise the same
    -- clean message instead of surfacing a raw constraint error.
    raise exception 'This participant has already been admitted to this session';
  end;

  return v_booking_id;
end;
$$;
```

Added two things beyond the original draft, both flagged by spec review: (1) a `v_session.status <> 'confirmed'` check mirroring `book_session`'s own session-status gate (the original draft said it was "modeled on `book_session`'s shape" but omitted this, with no stated reason — now closed, since there's no reason a `draft`/`cancelled` session should accept a walk-in); (2) an explicit `attendance_records`-side duplicate check plus a `unique_violation` handler around the insert, closing the race where someone already admitted via the normal QR flow (with no `session_bookings` row — e.g., a flexible/priority admission) could otherwise hit `attendance_records_no_duplicate_active`'s unique index as a raw, uncaught error.

**Access path for `compute_time_slot_group_key_for_session()` — works, but via a different mechanism than its existing callers, worth stating explicitly rather than leaving implicit.** That function's `EXECUTE` privilege was explicitly revoked from `public`/`anon`/`authenticated` and granted only to `service_role` (`20260814100000_scan_qr_attempt_transactional.sql`). Its only existing callers today (`scan_attempt_transactional`/`scan_qr_attempt_transactional`) are themselves plain (not `security definer`) functions granted only to `service_role` — they're invoked from a trusted server-side API route using the service-role key, never directly by an `authenticated` client; that's *their* access path. `admit_walk_in` takes a different one: it **is** `security definer`, so Postgres runs its body — including this nested call — as the function's *owner*, not as the calling `authenticated` staff user. The owner role is never in the revoked list, so the call succeeds once `admit_walk_in` itself exists, with no additional grant needed on `compute_time_slot_group_key_for_session`. A planning-stage implementer should rely on this reasoning (ownership via `security definer`), not on the unrelated `service_role` grant the function's existing callers happen to use.

No deadline check (scope decision 11 implies this is irrelevant at the door — a walk-in happens *during* the session, not before it), no time-conflict check, no waitlist interaction (a walk-in bypasses the waitlist entirely — the participant is being seated directly by staff judgment).

**Re-admission after no-show — explicitly out of scope, noted here rather than silently left ambiguous.** Spec review asked what happens if a participant marked `no_show` later shows up physically. Answer: `admit_walk_in` handles this correctly without any special-casing, because its only duplicate check is against `status = 'active'` bookings/admissions — a `no_show` booking doesn't block it. Calling `admit_walk_in` again creates a *second* `session_bookings` row (`source = 'walk_in'`) alongside the original now-`no_show` one. This is accepted as correct, not a bug: the two rows accurately represent what happened (the original booking really did go unattended at the 15-minute mark; the walk-in is a distinct, later admission event), and no code path needs them merged or deduplicated for this sub-project's scope.

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
6. No-show cron idempotency: a second `process_session_no_shows()` call for the same session makes no further changes to bookings already marked `no_show`; a booking added to the session *after* the first pass (e.g., a late waitlist promotion) is still correctly evaluated on the next pass, since idempotency is per-booking (via `status = 'active'`), not a session-level marker.
7. `admit_walk_in` succeeds when admitted count < capacity; rejects at capacity.
8. `admit_walk_in` rejects a duplicate (participant already has an active booking for this session).
9. `admit_walk_in` creates both a `session_bookings` row (`source = 'walk_in'`) and a linked `attendance_records` row atomically; both are visible via the normal `/my-agenda` and `session_effective_occupied_count()` query paths exactly as a self-service booking would be.
10. `scan_attempt_transactional` correctly populates `attendance_records.booking_id` when a matching active booking exists, and leaves it NULL when none exists (both cases, live).
11. `book_session` (ordinary self-service booking, unrelated to walk-in) still produces `session_bookings.source = 'self_service'` after this column's addition — a simple regression check confirming the new column's default doesn't silently break the existing booking path.
12. `admit_walk_in` rejects a participant already admitted via the normal QR scan flow with no prior `session_bookings` row (the `attendance_records`-side duplicate case, distinct from test 8's `session_bookings`-side case) — covers both the pre-check and, if feasible to construct live, the `unique_violation` fallback path.
13. A no-show-triggered promotion queues a `waitlist_promoted` outbox notification identical in shape to a cancellation-triggered one (same `promote_next_waitlist_candidate` helper, both call sites) — confirms parity, not just that *a* promotion happened.

## Out of Scope

- **The second walk-in case** (a participant who booked self-service but arrives late) — deferred to a future sub-project; the original request's "two cases" is intentionally narrowed to one for 4e, confirmed with the user.
- **Integrating walk-in admission into the existing scanner UI** (`scanner-client.tsx` and its `resolve-admission-decision`/`result-presentation` layer) — 4e ships a working RPC and a separate, simple standalone admin page; folding this into the scanner's existing decision/override system is deferred as its own future task.
- **No-show/walk-in analytics or reporting** beyond the `/my-agenda` badge — the mechanism (status tracking, seat release) is in scope; dashboards or aggregate reports are not.
- **Retroactive processing** of sessions already past their 15-minute no-show threshold at the moment this ships — the cron only acts going forward from deployment.
- **Dropping confirmed-dead legacy columns** (`enable_qr_checkin`, `checkin_opens_at`, `checkin_closes_at` — explicitly documented as dead in the Phase 6 spec) that a future cleanup migration was already expected to remove — unrelated to this sub-project's scope, left untouched. (`is_mandatory` is a separate, actively-used column in the allocation domain, not part of this dead-column group — not touched here either, but for a different reason: it's live, not dead.)
