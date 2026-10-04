# Work-Group Waitlist Design

**Sub-project:** 4d of the Sessions/Booking/Work-Groups roadmap item (sub-project 4 of 6 in the overall COY21 platform plan). Builds on 4a (timezone unification), 4b (booking/allocation conflict unification), and 4c (session cancellation/reschedule lifecycle sync) — all already merged to `master`.

## Problem

The original project request calls for "سعة مجموعات العمل (work-group capacity) وإغلاق الحجز عند الامتلاء" — work-group capacity and automatic booking closure when full. Investigation found that "work-group" is not a concept that exists anywhere in the codebase today: it is only the name of this sub-project in the roadmap. `session_types` is a generic, admin-managed lookup table (`code`, `name_ar`, `name_en`, `is_active`) with no reserved codes and no type-specific behavior anywhere in the code.

The generic capacity-closure behavior already exists and applies uniformly to every session type: `book_session()` rejects booking past capacity with `'Session is full'`, using the server-side `session_effective_occupied_count()` function (`session_bookings` + confirmed `allocation_assignments`). Separately, `/my-agenda/browse` (`src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx`) already shows a "Full" badge and hides the booking button once the session's booked count reaches `capacity` — but it computes this client-side by re-deriving the same count itself (one query counting active `session_bookings` rows, plus the `session_allocation_confirmed_counts()` RPC for confirmed allocations, merged into a page-local `countMap`; `isFull = bookedCount >= s.capacity`), **not** by calling `session_effective_occupied_count()` directly — that SQL function has no RLS/grant path reachable from the page today; it's only invoked from inside `book_session()`'s own SECURITY DEFINER context. The two code paths compute the same number via parallel logic, which is how 4b guaranteed the displayed count never drifts from what the RPC enforces. No changes are needed to reproduce that baseline behavior for work-group sessions — a work-group is simply a session with a small `capacity` value.

What's actually missing, confirmed through brainstorming with the user, is a **waitlist**: when a work-group session is full, participants should be able to join a waitlist instead of being turned away, and be promoted automatically and immediately when a seat opens up.

## Scope Decisions

All decisions below were confirmed with the user during brainstorming (each is the option explicitly chosen, not assumed):

1. **What distinguishes a work-group session from any other session, behaviorally**: nothing except capacity and the waitlist flag described below. No new session fields, no new allocation treatment, no visual distinction beyond what's described in this spec.
2. **Waitlist is opt-in per session type**, not hardcoded to a `'work_group'` string code. A new `session_types.enable_waitlist` boolean column lets staff enable waitlist behavior for any session type via the existing session-type admin UI — more robust than matching a magic string, and not limited to one type if staff want it elsewhere later.
3. **Promotion is automatic and immediate** when a seat opens up — no staff action required, no participant action required beyond having joined the waitlist.
4. **No cap on waitlist size**, and a participant **may join multiple waitlists for time-overlapping sessions simultaneously** (e.g., two concurrent work-groups they're both interested in). This mirrors how `book_session()` already allows browsing without eagerly blocking on potential future conflicts — the conflict check happens at the point of commitment (promotion), not at the point of intent (joining the waitlist).
5. **Promotion triggers only on voluntary participant cancellation** (`cancel_booking()`), not on staff-initiated session cancellation (which produces `session_cancelled` bookings per 4c). Rationale: when staff cancel a session entirely, the session itself is gone — there is nothing left to promote anyone *into*. Promotion only makes sense when an individual seat frees up on a session that is still running.
6. **Conflict handling at promotion time**: if the next person in line (FIFO) has a time conflict with another booking or confirmed allocation they already hold, they are skipped (left in the waitlist, untouched) and the next candidate is tried, down the line, until either someone is promoted or the waitlist is exhausted.
7. **Cross-waitlist cleanup on promotion**: if the promoted participant was also waitlisted for any other session whose time range overlaps the one they were just promoted into, those other waitlist entries are automatically withdrawn — they can no longer be promoted into something that would now conflict with their new booking.
8. **Email notification on promotion**, via the same outbox + cron pattern introduced in 4c (`session_notification_outbox` + `process-session-notifications` cron), not a new delivery mechanism.
9. **Manual withdrawal** is supported — a participant can leave a waitlist voluntarily before being promoted, mirroring the existing cancel-booking UX pattern.
10. **No visible queue position.** The UI shows only "On waitlist" / "In the waitlist" text, never a rank or ETA (e.g., not "you are #3"). Simpler to build and avoids a number that becomes misleading the moment someone else withdraws or is skipped for a conflict.
11. **No special handling if staff disable `enable_waitlist` on a session type after people have already joined.** Those entries simply stay `'waiting'` with no promotion path (since `cancel_booking()`'s promotion step re-checks the live flag), but manual withdrawal (decision #9) remains available to them at any time. Accepted as a rare edge case not worth a dedicated auto-withdrawal mechanism.
12. **`join_waitlist` rejects a session that is not `published`/`confirmed`**, mirroring `book_session()`'s own status check exactly (`raise exception 'Session is not open for booking'` when `status not in ('published', 'confirmed')`). Found as a gap during plan review — the original RPC design below omitted this despite being "modeled directly on `book_session()`'s structure" — and confirmed with the user: a `draft`/`cancelled` session should never accumulate waitlist entries that can never be promoted.

## Data Model

### `session_types.enable_waitlist`

```sql
alter table session_types add column enable_waitlist boolean not null default false;
```

Admin-managed via the existing session-type CRUD UI (`src/app/[locale]/(admin)/agenda/session-types/`) — add one checkbox field to the existing form. No migration of existing rows needed; defaults to `false`, preserving current behavior for every session type until staff explicitly opt one in.

### `session_waitlist` table

```sql
create type waitlist_status as enum ('waiting', 'promoted', 'withdrawn');

create table session_waitlist (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  session_id     uuid not null references sessions(id) on delete cascade,
  status         waitlist_status not null default 'waiting',
  joined_at      timestamptz not null default now(),
  promoted_at    timestamptz,
  withdrawn_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One active ('waiting') waitlist entry per participant per session.
create unique index session_waitlist_active_unique
  on session_waitlist (application_id, session_id) where status = 'waiting';

-- FIFO scan for promotion: oldest 'waiting' row per session first.
create index session_waitlist_session_fifo_idx
  on session_waitlist (session_id, joined_at) where status = 'waiting';
```

`waitlist_status` is a dedicated enum, not a reuse of `booking_status` — "waiting / promoted / withdrawn" has no semantic overlap with booking's `active / cancelled / session_cancelled`, and conflating them would make both harder to reason about.

`updated_at` follows this repo's universal per-table convention (every table has one) and gets the same `moddatetime`-style auto-touch trigger `session_bookings` and other tables already use; no RPC needs to set it explicitly.

RLS: participants can `SELECT` their own rows only (via `applications.applicant_id = auth.uid()` join, matching the `session_bookings` pattern); staff (`registration_admission_manager`, `super_admin`) get full access. **No direct INSERT/UPDATE/DELETE policy for anyone** — all writes go through the two SECURITY DEFINER RPCs below, matching the `session_bookings` convention exactly. This is a *different* RLS philosophy from 4c's `session_notification_outbox`, which has zero policies and relies entirely on this repo's GRANT-discipline convention (no table is ever granted to `authenticated`/`anon` unless a traced code path needs it) — `session_waitlist` needs real participant-facing SELECT policies because, unlike the outbox, participants legitimately read their own rows directly from the client (to render "On waitlist" state), so RLS does real access-control work here, not just a redundant second layer.

**FIFO-under-concurrency guarantee:** `join_waitlist`'s session-row `for update` lock (step 2 below) serializes all concurrent joins for the same session through that lock, so `joined_at` ordering is guaranteed to reflect true commit order with no sub-second tie-break ambiguity — two participants racing to join the same session's waitlist cannot get out-of-order `joined_at` values relative to each other.

### `session_notification_type` extension

```sql
alter type session_notification_type add value 'waitlist_promoted';
```

Per this repo's established convention (see 4c's own precedent, and `20260804110000_add_scanner_device_role.sql`), this must be its own migration file, committed before any later migration in this feature references the new enum value.

## RPC Changes

### `join_waitlist(p_application_id uuid, p_session_id uuid) returns uuid`

New SECURITY DEFINER RPC, modeled directly on `book_session()`'s structure:

1. Authorization: caller must own `p_application_id` (same `auth.uid()` check as `book_session`).
2. Lock the session row (`for update`), same as `book_session`, to avoid racing a concurrent capacity change.
3. Reject if the session is not `published`/`confirmed` (same `status not in ('published', 'confirmed')` check as `book_session`, same `'Session is not open for booking'` message) — a `draft`/`cancelled` session should never accumulate waitlist entries that can never be promoted (scope decision #12).
4. Reject if the session's type does not have `enable_waitlist = true` — the error message should make clear this session doesn't support waitlisting (distinct from "full").
5. Reject if the session is **not** actually full (`session_effective_occupied_count(p_session_id) < capacity`) — a participant should book normally, not waitlist, while seats remain. This keeps `join_waitlist` from becoming a backdoor around capacity.
6. Reject if the booking deadline has passed (same `booking_deadline` / `start_time - interval '3 hours'` fallback logic as `book_session`).
7. Reject if the participant already holds an active booking for this exact session (no reason to waitlist for something you're already in).
8. Insert into `session_waitlist` with `status = 'waiting'`. The partial unique index makes a duplicate join for the same session a clean constraint violation, which the RPC should catch and turn into a clear "already on the waitlist" exception (mirroring how `cancel_booking` turns an already-cancelled booking into a clear exception rather than a raw constraint error).

Deliberately **not** checked at join time: time conflicts with other bookings/waitlist entries. Per scope decision #4, conflict checking is deferred to promotion time.

### `leave_waitlist(p_application_id uuid, p_session_id uuid) returns void`

New SECURITY DEFINER RPC:

1. Authorization: same ownership check.
2. Find the caller's `'waiting'` row for this session; if none exists, raise a clear exception ("not on this waitlist" — distinct from a silent no-op, matching how `cancel_booking` rejects an already-cancelled booking rather than silently succeeding).
3. Mark it `'withdrawn'`, set `withdrawn_at = now()`.

### `cancel_booking()` — modified

After the existing cancellation logic (marking the booking `'cancelled'`), add a promotion step, gated on the cancelled booking's session having `enable_waitlist = true` on its type:

```sql
-- (inside cancel_booking, after the booking is marked cancelled)
if v_session_enable_waitlist then
  <<promotion>>
  for v_candidate in
    select sw.id, sw.application_id
    from session_waitlist sw
    where sw.session_id = v_booking.session_id
      and sw.status = 'waiting'
    order by sw.joined_at asc
  loop
    -- Skip candidates with a time conflict against their own active
    -- bookings or confirmed allocation assignments (same conflict
    -- shape as book_session's own checks).
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

    -- Promote this candidate.
    insert into session_bookings (application_id, session_id)
    values (v_candidate.application_id, v_booking.session_id)
    returning id into v_new_booking_id;

    update session_waitlist
    set status = 'promoted', promoted_at = now()
    where id = v_candidate.id;

    -- Withdraw any other now-conflicting waitlist entries this same
    -- participant held (scope decision #7).
    update session_waitlist sw2
    set status = 'withdrawn', withdrawn_at = now()
    from sessions s2
    where sw2.session_id = s2.id
      and sw2.application_id = v_candidate.application_id
      and sw2.status = 'waiting'
      and tstzrange(s2.start_time, s2.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)');

    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
    values (v_new_booking_id, v_candidate.application_id, v_booking.session_id, 'waitlist_promoted');

    exit promotion; -- only one promotion per vacated seat
  end loop;
end if;
```

(Pseudocode above; `v_new_booking_id uuid` is an additional local variable the final PL/pgSQL declares alongside the function's existing `v_booking`/etc.) Only one seat was vacated, so at most one promotion happens per `cancel_booking()` call — no loop-until-full behavior, which keeps this a straightforward extension of a single cancellation rather than a general backfill job. If every candidate in the loop is skipped for a time conflict, the loop ends naturally without ever reaching `exit promotion`: zero rows are promoted, the vacated seat simply stays empty, and every skipped waitlist entry is left untouched in `'waiting'` (eligible for the next vacancy).

## Email Notification

New function in `src/lib/email/resend.ts`, `sendWaitlistPromotionNotificationEmail({ to, fullName, sessionTitle, locale })`, following the exact shape of 4c's `sendSessionCancellationNotificationEmail`/`sendSessionRescheduleNotificationEmail` — same template structure, same `sendEmailGuarded` wrapping. Links to `/my-agenda` (not `/my-agenda/browse`, since the participant now has an actual booking to see, unlike 4c's cancellation email which links to browse because there's nothing left to see).

The existing `process-session-notifications` cron (`src/app/api/cron/process-session-notifications/route.ts`, introduced in 4c) gets one additional `case`/branch for `notification_type = 'waitlist_promoted'`, calling the new email function. No new cron, no new outbox table — this is purely additive to 4c's existing infrastructure.

## UI Changes

### `/my-agenda/browse`

- The query backing this page must start selecting `session_types.enable_waitlist` (currently the page doesn't join `session_types` at all — confirmed by investigation) and must also fetch the signed-in participant's own `session_waitlist` rows for the visible sessions. `isFull` stays computed exactly as it is today (the page-local `countMap`, built from the active-`session_bookings` count query plus the `session_allocation_confirmed_counts()` RPC) — the waitlist feature reads this existing boolean, it does not introduce a new count source or call `session_effective_occupied_count()` from the page.
- When a session `isFull` **and** its type has `enable_waitlist = true`:
  - If the participant has no `'waiting'` row for it: show a "Join waitlist" button (calls `join_waitlist`) in place of the current hidden/disabled state.
  - If the participant already has a `'waiting'` row for it: show "On waitlist" text with a "Leave waitlist" action (calls `leave_waitlist`), mirroring the existing "Booked ✓" pattern.
- When a session `isFull` and its type does **not** have `enable_waitlist = true`: unchanged — current "Full" badge, no booking action, exactly as today.

### `/my-agenda`

- Add a "Waitlisted" section (or inline badge within the existing day-grouped list — exact placement to be finalized during planning, likely inline given the page already groups by day) showing sessions the participant is currently waitlisted for, each with a "Leave waitlist" button.
- Reuses the `Badge` component (`src/components/ui/badge.tsx`) with a new `waitlisted` variant, following the same extension pattern established in 4c when `sessionCancelled` was added.
- On promotion, the entry disappears from the waitlisted section and appears as a normal active booking on its conference day — no special "just promoted" UI state is required; the booking looks identical to any other booking once created, and the email is the promotion signal.

## Testing Requirements

Live integration tests (matching 4c's bar — real seeded sessions/rooms/applicants against the scratch Supabase project, following the `tests/agenda/session-lifecycle-notifications-live.test.ts` conventions for fixture isolation and cleanup):

1. `join_waitlist` succeeds only when the session is full and its type has `enable_waitlist = true`.
2. `join_waitlist` rejects when the session is not full (participant should book normally).
3. `join_waitlist` rejects when the session's type does not have `enable_waitlist = true`.
4. `join_waitlist` rejects a duplicate join (already has a `'waiting'` row for this session).
4b. `join_waitlist` rejects when the caller already holds an active booking for the same session (distinct from the duplicate-waitlist-join case above).
5. `leave_waitlist` succeeds and marks the row `'withdrawn'`.
6. `leave_waitlist` rejects when the caller has no `'waiting'` row for that session.
7. Promotion happens in FIFO order (earliest `joined_at` wins) when a seat frees up via `cancel_booking`.
8. Promotion skips a candidate with a time conflict and promotes the next eligible candidate instead.
9. Promotion withdraws the newly-promoted participant's other time-overlapping waitlist entries.
10. Promotion inserts exactly one `session_notification_outbox` row with `notification_type = 'waitlist_promoted'`.
11. Staff-initiated session cancellation (the 4c path, producing `session_cancelled` bookings) does **not** trigger any promotion — confirms scope decision #5 holds and the two cancellation paths stay properly isolated.
12. A participant can hold waitlist entries on two time-overlapping sessions simultaneously without error (confirms scope decision #4 — no conflict check at join time).
13. When every candidate in the waitlist has a time conflict, the vacated seat stays unfilled (zero promotions) and every skipped entry remains `'waiting'`, untouched, for the next vacancy.
14. RLS: a participant cannot `SELECT` another participant's `session_waitlist` row, and cannot write to `session_waitlist` directly (bypassing `join_waitlist`/`leave_waitlist`) — mirrors the existing RLS test coverage pattern for `session_bookings`.

## Out of Scope

- Any change to the allocation/clustering pipeline — it remains entirely session-type-blind, as confirmed by investigation. Work-group sessions are not auto-assigned via allocation; they are purely self-service bookable (optionally with a waitlist).
- Any visual/UX distinction for work-group sessions beyond the waitlist affordance itself (no icon, no special color, no separate browse section).
- A staff-facing waitlist management UI (viewing/reordering/manually promoting from the waitlist) — promotion is fully automatic per scope decision #3; staff can already see `session_waitlist` rows via the database/RLS staff-access policy if needed, but no dedicated admin screen is being built.
- Batch/backfill promotion beyond one seat per cancellation — if multiple seats free up in quick succession, each is handled by its own `cancel_booking()` call promoting independently, which is already correct; there is no scenario requiring a "promote N people at once" code path.
