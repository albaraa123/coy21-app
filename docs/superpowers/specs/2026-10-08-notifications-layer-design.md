# Notifications Layer — Design Spec

Sub-project 6 of 6 — the final piece of the original COY21 platform roadmap. Sub-projects 1–5 (including 4a–4e, 5a, 5b) are merged to `master` on the real COY21 project (`vfwcbkjvinbtcntwjrzq`) and freshly re-verified via live tests.

**Timeline constraint:** the conference is in ~1 week. Implementation must finish with at least 3 days of buffer before the event, leaving time for deployment and a dry run.

## Problem

The platform has no unified notification system. Today:

- `session_notification_outbox` (introduced in sub-project 4c, `supabase/migrations/20261004010000_session_lifecycle_notifications.sql`) handles exactly 3 narrowly-scoped event types (`session_cancelled`, `session_rescheduled`, `waitlist_promoted`), drained by a 5-minute cron (`src/app/api/cron/process-session-notifications/route.ts`) into email only. Its own design doc explicitly states it is "not a general-purpose notification queue" (YAGNI, by design, at the time).
- Two other crons (`session-reminders`, `travel-reminders`) send email directly from a time-window query, with no outbox/queue at all.
- There is no in-app notification UI anywhere (confirmed: no bell, toast, or list component exists), no push/FCM infrastructure, and no generic `notifications` table.
- Several real events that should notify a participant currently don't: application acceptance/rejection, and session booking confirmation.
- There is no way for organizers to broadcast an announcement to all accepted participants.

## Scope Decision

**In scope:**
- Two channels only: email (existing Resend infrastructure, through the existing `sendEmailGuarded` sandbox-mode gate) and an in-app notification bell on the participant shell (`/my-agenda` and sibling `(shell)` routes only — not the admin or scanner UIs).
- One unified `notifications` table and one unified distribution mechanism (Realtime broadcast for the bell, a single per-minute cron for email) replacing the narrower `session_notification_outbox` pattern going forward.
- Nine event channels: `application_accepted`, `application_rejected`, `booking_confirmed`, `session_cancelled`, `session_rescheduled`, `waitlist_promoted`, `session_reminder`, `travel_reminder`, `announcement`.
- A minimal admin page for organizers to compose and send a broadcast announcement.
- Migrating the existing 3 session-lifecycle event types (and the 2 time-window cron reminders) onto the new unified table and distribution path.

**Explicitly out of scope (deferred, not forgotten):**
- WhatsApp and push notifications (channels only, infra not built).
- Staff-facing notifications (scanner/admin UIs get no bell in this sub-project).
- Per-user notification preferences/opt-out settings.
- Historical backfill — the new `notifications` table starts empty. `session_notification_outbox` is left untouched as a silent archive of pre-cutover rows; it gets no bell/retroactive migration.
- Per-recipient delivery tracking for the broadcast announcement (one row succeeds/fails as a batch, not per-recipient retry).

## Architecture — Database

### New table: `notifications`

```sql
create type notification_channel as enum (
  'application_accepted', 'application_rejected',
  'booking_confirmed',
  'session_cancelled', 'session_rescheduled', 'waitlist_promoted',
  'session_reminder', 'travel_reminder',
  'announcement'
);
create type notification_status as enum ('pending', 'sent', 'failed');

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references applications(id) on delete cascade,  -- NULL only for is_broadcast = true rows
  is_broadcast    boolean not null default false,
  channel         notification_channel not null,
  title           text not null,   -- pre-rendered, locale-resolved at insert time (see below)
  body            text,
  link_path       text,            -- relative in-app path the bell navigates to on click
  session_id      uuid references sessions(id) on delete set null,
  old_start_time  timestamptz,     -- session_rescheduled only
  new_start_time  timestamptz,     -- session_rescheduled only
  email_status    notification_status not null default 'pending',
  error_message   text,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint notifications_broadcast_application_id_check
    check ((is_broadcast and application_id is null) or (not is_broadcast and application_id is not null))
);

create index notifications_pending_idx on notifications (created_at) where email_status = 'pending';
create index notifications_application_feed_idx on notifications (application_id, created_at desc) where not is_broadcast;
```

**`title`/`body` are pre-rendered, not computed at read time.** Each producer (the RPC/trigger that inserts the row) resolves the recipient's `preferred_language` at insert time and writes the final display string directly — mirrors how `resend.ts`'s existing email functions already branch per-locale. This keeps the bell's read query a plain `select *`, with no join-time i18n logic.

**`email_status` tracks only the email channel's delivery outcome and must never gate the bell.** The bell's unread/read state is driven entirely by `read_at`/`notification_broadcast_reads` and by Realtime row-insertion events (see Architecture — Realtime below) — it is fully independent of `email_status`'s value or timing. A row can show in the bell seconds after insert while `email_status` is still `pending` (the email cron runs on its own 1-minute cycle); this is expected, not a bug. Do not write any bell-side logic that checks `email_status`.

RLS: `enable row level security`, with exactly two `select` policies, no `insert`/`update`/`delete` policy (all writes go through the `security definer` `create_notification`/`create_announcement` RPCs — see Writer RPCs below for exactly which functions are and aren't `security definer` — same GRANT-discipline pattern as `session_notification_outbox`):

```sql
create policy notifications_own_select on notifications
  for select to authenticated
  using (not is_broadcast and application_id in (
    select id from applications where applicant_id = auth.uid()
  ));

create policy notifications_broadcast_select on notifications
  for select to authenticated
  using (is_broadcast = true);
```

### New table: `notification_broadcast_reads`

Per-user read tracking for broadcast rows (a shared `read_at` column on `notifications` itself would conflict across readers of the same row):

```sql
create table notification_broadcast_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  application_id  uuid not null references applications(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, application_id)
);
```

RLS: one `select`/`insert` policy restricted to the caller's own `application_id` (via `mark_notification_read`, see below — not direct client writes).

### Writer RPCs

`create_notification(...)` itself must be `security definer` (so it can write to `notifications` regardless of its caller's own privileges), never called directly by a client — this is the sole write path, enforced by GRANT discipline, not RLS. Its callers are NOT all `security definer` themselves, and don't need to be: Postgres runs a `security definer` function with the definer's rights no matter what context calls it, so a plain (non-`security definer`) trigger function, or a different `security definer` function, can both call it safely. Specifically:

- `create_notification(...)` — internal helper (not directly granted to `authenticated`), `security definer`, called from other RPCs/triggers to insert one personal row. Takes `p_application_id`, `p_channel`, `p_title`, `p_body`, `p_link_path`, `p_session_id default null`, `p_old_start_time default null`, `p_new_start_time default null`.
- `create_announcement(p_title text, p_body text)` — staff-only (`coalesce(is_staff(), false)` check, following the `ops_dashboard_snapshot()` precedent for the NULL-vs-false anon bypass), inserts exactly one `is_broadcast = true` row. **Decision needed in the implementation plan**: `ops_dashboard_snapshot()` additionally allows `or auth.role() = 'service_role'` alongside its `coalesce(is_staff(), false)` check, since a service-role caller (e.g. this codebase's own live test fixtures) also has a NULL `auth.uid()` and would otherwise be rejected. If `create_announcement` is ever called from a live test or any other service-role context, it needs the same carve-out; if it's genuinely only ever called from a real staff session, it can stay as the narrower check. The plan should make this choice explicitly rather than copy the precedent blindly.
- `mark_notification_read(p_notification_id uuid)` — verifies the row belongs to the caller (via `applications.applicant_id = auth.uid()`) for personal rows, or inserts into `notification_broadcast_reads` for broadcast rows; rejects otherwise.

**Callers of `create_notification`, by trust boundary (verified against current code, not assumed):**
- `book_session` (`supabase/migrations/20261003000000_book_session_respects_allocation.sql`) IS itself `security definer` — a `security definer` function calling another `security definer` function, which Postgres handles without issue.
- `enforce_session_lifecycle_booking_sync()` (the session-lifecycle trigger) and `promote_next_waitlist_candidate()` (the waitlist-promotion helper) are BOTH plain `language plpgsql set search_path = public, pg_temp` functions today — neither is `security definer`. This is fine and does not need to change: `create_notification`'s own `security definer` is what grants it write access, independent of whether its caller is elevated. Do not "fix" these two functions to add `security definer` during implementation — that would be an unnecessary, unrelated privilege escalation; they already have whatever rights they need (they already write `session_notification_outbox` today without it).
- `updateApplicationStatusForCaller` (TS, `src/app/[locale]/(admin)/applications/[id]/actions.ts`) is not a SQL caller at all — it's a Server Action already running with an injected service-role client, a different trust boundary entirely, and calls `create_notification` as an ordinary RPC the same way it calls `accept_application_and_issue_number` today.

### Event wiring (where each channel is produced)

| Channel | Producer | Insertion point |
|---|---|---|
| `application_accepted` / `application_rejected` | `updateApplicationStatusForCaller` (`src/app/[locale]/(admin)/applications/[id]/actions.ts`, TS, not SQL) | Immediately after the status `.update()` succeeds (current line 72's success path), before the function returns — calls a new `create_notification` RPC directly from the Server Action, since this status change is TS-driven, not RPC-driven |
| `booking_confirmed` | `book_session` RPC (`supabase/migrations/20261003000000_book_session_respects_allocation.sql`) | After `insert into session_bookings ... returning id into v_booking_id` (current lines 120-122), before `return v_booking_id` |
| `session_cancelled` / `session_rescheduled` | existing trigger `enforce_session_lifecycle_booking_sync()` (`20261004010000_session_lifecycle_notifications.sql`) | Replaces its current `insert into session_notification_outbox` with `insert into notifications` (same trigger, same firing conditions, new target table) |
| `waitlist_promoted` | existing shared helper `promote_next_waitlist_candidate()` (`20261006040000_no_show_detection_and_promotion_helper.sql`) | Same replacement: target `notifications` instead of `session_notification_outbox` |
| `session_reminder` / `travel_reminder` | existing crons `src/app/api/cron/session-reminders/route.ts`, `src/app/api/cron/travel-reminders/route.ts` | Each cron's "found a recipient" branch inserts a `notifications` row (via `create_notification` RPC or direct service-role insert) instead of calling `sendEmailGuarded` directly — the new unified email cron (below) becomes the actual sender |
| `announcement` | new admin page → `create_announcement` RPC | One row, `is_broadcast = true` |

`session_notification_outbox` itself is left entirely unmodified and unused going forward — no new writes, no deletion, a silent pre-cutover archive.

## Architecture — Realtime (the bell)

Mirrors sub-project 5a's broadcast-via-trigger pattern exactly (`supabase/migrations/20261006071000_ops_dashboard_snapshot.sql`), with two channels instead of one:

```sql
create or replace function notify_participant_notification() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.is_broadcast then
    perform realtime.send(
      jsonb_build_object('id', new.id), 'change', 'notifications-broadcast', true
    );
  else
    perform realtime.send(
      jsonb_build_object('id', new.id), 'change',
      'notifications-' || new.application_id::text, true
    );
  end if;
  return new;
end;
$$;

create trigger notifications_notify_participant
  after insert on notifications
  for each row execute function notify_participant_notification();
```

Companion `realtime.messages` RLS policies (two — one per channel-name shape), following the exact drop-then-create pattern 5a's migration established (no `create policy if not exists` in Postgres):

```sql
create policy notifications_broadcast_channel_select on realtime.messages
  for select to authenticated
  using (extension = 'broadcast' and realtime.topic() = 'notifications-broadcast');

create policy notifications_personal_channel_select on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'notifications-' || (
      select id::text from applications where applicant_id = auth.uid() limit 1
    )
  );
```

The `limit 1` subquery is only correct because `applications` has a unique index enforcing at most one row per `applicant_id` (`applications_one_per_applicant`, `supabase/migrations/20260721202027_applications_table.sql`) — this policy's correctness is architecturally load-bearing on that constraint remaining in place. If that uniqueness is ever relaxed, this policy would silently start picking an arbitrary one of several applications rather than erroring.

**Client side**: a new Client Component (e.g. `src/components/shell/notification-bell.tsx`) imported into `Topbar` (`src/components/shell/topbar.tsx`, inserted into the existing `gap-3` flex div alongside `<UserMenu>`, line ~65-67 — the established pattern for adding client-interactive elements there, per `UserMenu`'s own precedent). Subscribes to both the caller's personal channel and the shared broadcast channel (two `supabase.channel(...)` subscriptions, `{ config: { private: true } }`), debounced refetch on broadcast (mirroring ops-dashboard's 1.5s debounce / 5s max-wait pattern), plus a 30-second fallback poll — same two-layer resilience as 5a.

On load and on refetch: a single query joining personal + broadcast rows, read-state resolved client-side by checking `read_at` (personal) or presence in a fetched set of the user's own `notification_broadcast_reads` rows (broadcast) — or, more simply, one `get_my_notifications()` RPC that does this join server-side and returns a unified, already-read-flagged list. (Left as an implementation-plan decision: RPC vs. two-query client join — functionally equivalent, RPC avoids exposing `notification_broadcast_reads` to direct client select.)

## Architecture — Email cron

**New unified cron** replaces `process-session-notifications`, and `session-reminders`/`travel-reminders` are modified to stop sending email directly (see Event wiring table). Runs every 1 minute (`vercel.json`: `"schedule": "* * * * *"`), same `CRON_SECRET` Bearer-token guard (`timingSafeEqual`, fail-closed) as the existing cron.

Per pending row (batch size TBD in the plan, following the existing `BATCH_SIZE = 25` precedent):
- `is_broadcast = false`: look up the application's profile email/locale, dispatch to the matching email function (new or existing in `src/lib/email/resend.ts`), update `email_status`.
- `is_broadcast = true`: query all `applications where status = 'accepted'` **at send time** (not at `create_announcement`'s insert time — an applicant whose status changes away from `accepted` in the narrow window between announcement creation and the cron picking it up is silently excluded; this is accepted as an edge case given the 1-minute cron interval, not separately handled), send in batches via `Promise.all` (mirroring `travel-reminders`' existing 10-at-a-time batching to avoid serverless timeout), then mark the single row `sent` with an `error_message` summary if any batch member failed (no per-recipient retry). Note `sent` here is overloaded to mean "batch dispatch attempted, possibly with partial failures recorded in `error_message`" rather than "delivered successfully" — a 3-way value (e.g. adding `partial`) would be more honest than reusing the single-send `sent`/`failed` enum for a batch outcome, but is left as a judgment call for the implementation plan rather than forced here, since `error_message` already preserves the detail losslessly.

Every email dispatch still goes through `sendEmailGuarded`/`fetchEmailSettings` unchanged — the sandbox-mode kill switch applies to every new notification email exactly as it does today.

## Architecture — Admin announcement page

A new, minimal admin page (route TBD in the plan, e.g. `src/app/[locale]/(admin)/announcements/`) gated by `is_staff()` (`coalesce(is_staff(), false)`, same NULL-anon-bypass precedent as `ops_dashboard_snapshot()`): a title field, a body field, a send button. Calls `create_announcement(p_title, p_body)`. No history/list view of past announcements in this scope (YAGNI, matches the narrow-scope decision) — the spec's own Testing Requirements will note this as a known, deliberate gap.

## Non-Goals

- WhatsApp/push notification channels.
- Staff-facing (admin/scanner UI) notification bell.
- Per-user notification preferences or opt-out.
- Historical backfill of `session_notification_outbox` into `notifications`.
- Per-recipient delivery retry for broadcast announcements.
- An admin UI to view/edit/resend past announcements.

## Testing Requirements

1. Each of the 6 personal-event producers (`application_accepted`, `application_rejected`, `booking_confirmed`, `session_cancelled`, `session_rescheduled`, `waitlist_promoted`) inserts exactly one `notifications` row with the correct `channel`/`application_id`/`title`, AND the correct locale: an applicant with `preferred_language = 'ar'` gets an Arabic `title` (not just a non-empty one), matching the per-producer locale-resolution logic each one independently implements.
2. `create_announcement` inserts exactly one row with `is_broadcast = true`, `application_id = null`.
3. RLS: a user cannot `select` another user's personal rows; every authenticated user can `select` broadcast rows.
4. `mark_notification_read` rejects marking another user's personal notification as read; broadcast reads correctly insert into `notification_broadcast_reads` keyed to the caller.
5. The unified email cron: pending rows only, correct status transitions (`pending → sent`/`failed`), respects `sendEmailGuarded` sandbox mode (a sandboxed send never reaches the real recipient).
6. Broadcast email dispatch: sends to every `accepted` application AS OF THE CRON'S SEND TIME (not creation time — verify an application that transitions away from `accepted` after `create_announcement` but before the cron runs is correctly excluded, confirming the lazy-evaluation timing documented in Architecture — Email cron), batches correctly, marks the single row `sent` after the batch completes even if some individual sends failed (captured in `error_message`).
7. The bell: loads the full personal+broadcast feed on mount; receives a Realtime broadcast and refetches within the debounce window; the 30s fallback poll independently catches an update if the broadcast channel is silently missed.
8. `session-reminders`/`travel-reminders` crons, after modification, still correctly identify the same recipients on the same time windows as before (25–35 min / no travel_legs row, 2026-11-05 cutoff) — only the dispatch mechanism changes (row insert vs. direct send).
9. `is_staff()` NULL-vs-false gate is correctly applied (`coalesce(...)`) on both `create_announcement` and the admin page's own data-loading path — an anonymous or service-role caller must not bypass the staff check.
10. The `notifications_broadcast_application_id_check` constraint rejects any attempt to insert a row that is both `is_broadcast = true` and has a non-null `application_id`, or vice versa.
