# Session Cancellation/Reschedule Lifecycle for Self-Service Bookings — Design

**Sub-project:** 4c of the Sessions/Booking/Work-Groups roadmap item (sub-project 4 of 6 in the overall COY21 platform plan).

## 1. Problem

Three separate admin code paths can cancel a session (`status → 'cancelled'`) or change its time (`start_time`/`end_time`): `updateSessionStatus` (status-only), `updateSession` (generic edit, delegates to `update_session_transactional`), and `updateSessionScheduleAndAssignments` (combined reschedule + speaker reassignment, delegates to `update_session_and_assignments_transactional`). None of these three paths — nor any DB trigger — reads or writes `session_bookings` or sends any notification. Confirmed by exhaustive investigation:

- `enforce_session_status_transition()` and `enforce_speaker_no_conflict_on_session_change()` (`supabase/migrations/20260723020000_sessions_triggers.sql`) validate status transitions and re-check *speaker* conflicts only — neither references `session_bookings`.
- `/my-agenda` (`src/app/[locale]/(participant)/(shell)/my-agenda/page.tsx:30-51`) queries `session_bookings` filtered only on `.eq('status', 'active')`, with no join-filter on `sessions.status`. A cancelled session's booking renders identically to a live one — no visual distinction, no warning.
- The session-reminder cron (`src/app/api/cron/session-reminders/route.ts`) is a fully stateless periodic query with no run-history or sent-log — it naturally re-reads the current `start_time` on every invocation (so a reschedule is harmless to it), but it has zero mechanism to retract or correct a reminder already sent before a late cancellation/reschedule.
- No "choose a replacement session" flow exists anywhere in the codebase, even partially. The only unrelated precedent (`src/lib/program-attendance/session-alternatives.ts`) belongs to the separate QR-admission system and never touches `session_bookings`.

**Scope decisions (confirmed with user):**
- On session cancellation: every active `session_bookings` row for that session is **automatically marked cancelled** (not left dangling), and an **immediate** notification email is sent.
- On a time change (no status change): existing bookings **stay valid automatically** at the new time (no re-confirmation required from the participant), and a notification email is sent informing them of the new time. No conflict re-check against the participant's other bookings is performed in this sub-project — the booking simply follows its session to the new time, participant is notified, no automated resolution of any resulting conflict.
- "Choose a replacement" (mentioned in the original request) has **no existing infrastructure of any kind** to build on. Scope for this sub-project is narrowed to: the cancellation email links directly to the existing `/my-agenda/browse` page so the participant can self-serve a replacement there. No new picker UI, no suggested-alternatives logic.
- The DB-level fix lives in a **trigger on `sessions`**, not in any of the three admin server actions individually — guarantees correctness regardless of which of the three paths (or any future path) performs the write, mirroring the existing `schedule_change_events` precedent (`supabase/migrations/20260723180000_schedule_change_detection_triggers.sql`) for the same reason.
- Triggers cannot send HTTP requests (no email client inside Postgres). The trigger writes to a new outbox table; a new cron job drains it and performs the actual send via the existing `sendEmailGuarded` infrastructure. Same reliability pattern as the existing reminder cron (runs every few minutes, no single point of failure if one run is missed).
- The outbox table is **narrowly scoped to this feature** (not a general-purpose notification queue) — two notification types only (`session_cancelled`, `session_rescheduled`), no generic `payload jsonb` column, per YAGNI.
- The existing reminder cron is **left unmodified** — it is stateless and always re-reads the live `start_time`, so a reschedule is already handled correctly without any change; this was independently confirmed, not assumed.

**A conflict discovered during design, resolved explicitly:** `/my-agenda`'s query (`page.tsx:49-51`) filters `session_bookings.status = 'active'`. If cancellation reused the existing `'cancelled'` enum value (the one `cancel_booking()` already writes for a participant's own voluntary cancellation), the booking would simply vanish from `/my-agenda` instead of showing a cancellation badge — indistinguishable from the participant having cancelled it themselves. Resolved: a **third `booking_status` enum value, `'session_cancelled'`**, is added, used only by the new trigger (never by `cancel_booking()`, which continues to use `'cancelled'` for participant-initiated cancellations). `/my-agenda`'s query is updated to also fetch `'session_cancelled'` rows and render them with a distinct badge, instead of filtering them out.

## 2. Schema changes

Migration `supabase/migrations/20261004000000_session_lifecycle_notifications.sql`:

```sql
alter type booking_status add value 'session_cancelled';
```

(Postgres requires `ALTER TYPE ... ADD VALUE` to run in its own transaction/migration step before the new value can be referenced in the same migration's later statements in some Postgres versions — the implementation plan must verify this against the actual Supabase Postgres version and split into two migration files if needed, rather than assuming a single file works.)

New table:

```sql
create type session_notification_type as enum ('session_cancelled', 'session_rescheduled');
create type session_notification_status as enum ('pending', 'sent', 'failed');

create table session_notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references session_bookings(id) on delete cascade,
  application_id  uuid not null references applications(id) on delete cascade,
  session_id      uuid not null references sessions(id) on delete cascade,
  notification_type session_notification_type not null,
  old_start_time  timestamptz,  -- set only for 'session_rescheduled'
  new_start_time  timestamptz,  -- set only for 'session_rescheduled'
  status          session_notification_status not null default 'pending',
  error_message   text,         -- set only when status = 'failed'
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

create index session_notification_outbox_pending_idx
  on session_notification_outbox (status) where status = 'pending';
```

No client-facing RLS is needed — this table is written only by the trigger (`SECURITY DEFINER` context, same as other trigger-written tables in this codebase) and read only by the cron job's service-role client. RLS is enabled with no policies (staff/service-role only, matching the `allocation_assignments`-style lockdown pattern), since no participant or staff UI ever queries this table directly.

## 3. The trigger

A new trigger function, `enforce_session_lifecycle_booking_sync()`, fires `after update of status, start_time, end_time on sessions, for each row`. Logic:

- If `new.status = 'cancelled' and old.status is distinct from 'cancelled'`: for every `session_bookings` row with `session_id = new.id and status = 'active'`, set `status = 'session_cancelled'`, `cancelled_at = now()`, and insert one `session_notification_outbox` row (`notification_type = 'session_cancelled'`) per affected booking.
- Else if (`new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time`) and `new.status <> 'cancelled'`: for every `session_bookings` row with `session_id = new.id and status = 'active'`, insert one `session_notification_outbox` row (`notification_type = 'session_rescheduled'`, `old_start_time = old.start_time`, `new_start_time = new.start_time`) — no change to the booking row itself.
- Both branches are mutually exclusive by construction (a single `UPDATE` can change status to cancelled or change times, and the cancellation branch takes priority if somehow both changed in one statement — matches the existing `sessions_record_change_event` trigger's same mutual-exclusivity pattern for its two event types).
- `AFTER` trigger (not `BEFORE`) because it only needs to react to a committed state change, not validate/block it — this is purely additive side-effect logic, consistent with `sessions_record_change_event` (also `AFTER UPDATE`).

This trigger runs in addition to (not instead of) the existing `sessions_enforce_status_transition`, `sessions_enforce_speaker_no_conflict_on_change`, and `sessions_change_detection` triggers — all four fire independently on the same `UPDATE`.

## 4. `cancel_booking()` compatibility fix

`cancel_booking()` (`supabase/migrations/20260823020000_session_bookings.sql:151-191`) checks `if v_booking.status = 'cancelled' then raise exception 'Booking is already cancelled';`. This check must also catch `'session_cancelled'`, or a participant attempting to voluntarily cancel an already-session-cancelled booking would fall through to the deadline check and potentially succeed in a confusing double-cancel (overwriting `cancelled_at`, though the row was already effectively dead). Fixed in the same migration: `if v_booking.status in ('cancelled', 'session_cancelled') then raise exception 'Booking is already cancelled';`.

## 5. Email functions

Two new functions in `src/lib/email/resend.ts`, following `sendClassificationChangeNotificationEmail`'s established shape exactly (`locale: 'ar' | 'en'` param, ternary-branched subject/body, `fetchEmailSettings()` + `sendEmailGuarded()`):

```typescript
export async function sendSessionCancellationNotificationEmail(params: {
  to: string;
  fullName: string;
  sessionTitle: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }>

export async function sendSessionRescheduleNotificationEmail(params: {
  to: string;
  fullName: string;
  sessionTitle: string;
  oldStartTime: string; // ISO, formatted via formatConferenceTime/formatConferenceDate in the email body
  newStartTime: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }>
```

The cancellation email's body includes a direct link to `/my-agenda/browse` (using `config.appUrl`, same pattern as `sendLoginDetailsEmail`'s `loginUrl` construction) so the participant can self-serve a replacement session — this is the entire scope of the "choose a replacement" requirement for this sub-project, per the scope decision in section 1.

Both functions reuse `src/lib/datetime/conference-time.ts`'s `formatConferenceTime`/`formatConferenceDate` (from sub-project 4a) to render times in Europe/Istanbul, not raw ISO strings.

## 6. The outbox-processing cron

New route `src/app/api/cron/process-session-notifications/route.ts`, following `session-reminders/route.ts`'s exact structure (same `CRON_SECRET` Bearer-token guard, same fail-closed-on-missing-secret behavior, same service-role client pattern):

1. Query up to N (e.g. 100, to bound a single run) `session_notification_outbox` rows where `status = 'pending'`, oldest first.
2. For each: resolve the booking's `application_id` to `profiles(full_name, email)` and `applications.preferred_language`, and the session's current title (`sessions.title_en`/`title_ar`). Locale resolution follows the exact precedent in `src/app/[locale]/(participant)/(bare)/register/actions.ts:78` — `(application.preferred_language as 'ar' | 'en') ?? 'en'`. Note the existing reminder cron (`session-reminders/route.ts`) sends English-only with no locale resolution at all; this new cron introduces genuine bilingual support that the reminder cron lacks, rather than copying its English-only behavior.
3. Call the appropriate email function based on `notification_type`.
4. On success: `status = 'sent'`, `sent_at = now()`. On failure: `status = 'failed'`, `error_message` set — **not retried automatically** in this sub-project (a `'failed'` row is a signal for manual staff follow-up, not an auto-retry queue; adding retry logic is explicitly out of scope, consistent with YAGNI).
5. Idempotency: once a row's `status` leaves `'pending'`, it is never re-processed — the partial index on `status = 'pending'` makes each run's query cheap and naturally excludes already-processed rows, so running the cron twice in quick succession (or with overlapping invocations) cannot double-send *for the same outbox row*. A real concurrent-overlap race (two cron invocations picking up the same still-`'pending'` row simultaneously, before either has updated its status) is not prevented by this design — deliberately: the existing reminder cron (`session-reminders/route.ts`) has this identical unaddressed theoretical race and the team has accepted that risk level for a low-frequency, small-blast-radius notification system. No `for update skip locked` row-claim is added in this sub-project, matching that precedent exactly.

Invocation frequency: every few minutes (exact cadence decided in the implementation plan, consistent with the existing reminder cron's 5-minute cadence).

## 7. `/my-agenda` UI changes

`page.tsx`'s query (`.eq('status', 'active')`) is changed to `.in('status', ['active', 'session_cancelled'])` so cancelled-by-session-cancellation bookings remain visible (not silently dropped). `agenda-day.tsx`'s `Booking`/`Session` types and rendering gain a `status` field; a booking with `status = 'session_cancelled'` renders with a distinct badge (e.g. a red "Session Cancelled" pill where the `CancelButton` currently sits) and the `CancelButton` itself is hidden for these rows (nothing to cancel — already cancelled). Participant-voluntary-cancelled (`status = 'cancelled'`) bookings continue to be filtered out entirely, unchanged from current behavior — only the new `'session_cancelled'` status gains visibility.

## 8. Testing

Live tests (`tests/agenda/session-lifecycle-notifications-live.test.ts`, against the scratch project):

- Cancelling a session with an active booking: the booking's status flips to `'session_cancelled'`, `cancelled_at` is set, exactly one `session_notification_outbox` row is created with `notification_type = 'session_cancelled'`.
- Cancelling a session with multiple active bookings: one outbox row per booking, no cross-contamination of `booking_id`.
- Cancelling a session with no active bookings: zero outbox rows created (no spurious rows).
- Changing a session's `start_time` (no status change) with an active booking: the booking's `status` stays `'active'` (unchanged), exactly one outbox row created with `notification_type = 'session_rescheduled'` and correct `old_start_time`/`new_start_time`.
- Changing a session's `room_id` only (no time change): zero outbox rows (not a reschedule from the participant's perspective).
- `cancel_booking()` rejects an attempt to cancel an already-`session_cancelled'` booking with `'Booking is already cancelled'`.
- The outbox-processing cron: sends the correct email type per row, transitions `status` to `'sent'`, does not re-process already-`'sent'`/`'failed'` rows on a second run.
- `/my-agenda`'s query returns both `'active'` and `'session_cancelled'` bookings, excludes `'cancelled'` (participant-voluntary) bookings — verified at the query level, not just UI rendering.

## 9. Files touched (summary)

**New:**
- `supabase/migrations/20261004000000_session_lifecycle_notifications.sql` (and a second migration file if `ALTER TYPE ... ADD VALUE` requires transaction isolation — determined during implementation)
- `src/app/api/cron/process-session-notifications/route.ts`
- `tests/agenda/session-lifecycle-notifications-live.test.ts`

**Modified:**
- `src/lib/email/resend.ts` (two new exported functions)
- `src/app/[locale]/(participant)/(shell)/my-agenda/page.tsx` (query filter)
- `src/app/[locale]/(participant)/(shell)/my-agenda/agenda-day.tsx` (badge rendering, type updates)

**Out of scope for this sub-project (explicitly):** any change to the existing session-reminder cron; any "choose a replacement" picker UI beyond a link to the existing browse page; any change to the allocation system or `schedule_publication_items`; retry logic for failed outbox sends; a `for update skip locked` concurrency-safe row-claim (flagged as an open question for the plan to resolve, not pre-decided here).
