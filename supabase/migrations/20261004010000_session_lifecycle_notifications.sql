-- 20261004010000_session_lifecycle_notifications.sql
--
-- Closes the gap where none of the three admin code paths that can cancel
-- a session (updateSessionStatus) or change its time
-- (updateSession/update_session_transactional,
-- updateSessionScheduleAndAssignments/update_session_and_assignments_transactional)
-- touch session_bookings or send any notification. A trigger-based fix
-- (not per-action) guarantees correctness regardless of which path -- or
-- any future path -- performs the write, mirroring the existing
-- schedule_change_events precedent (20260723180000_schedule_change_detection_triggers.sql)
-- for the same reason. See
-- docs/superpowers/specs/2026-10-01-session-cancellation-reschedule-design.md
-- for full design rationale.
--
-- Requires 20261004000000_add_session_cancelled_booking_status.sql to have
-- already been applied (adds the 'session_cancelled' enum value this
-- migration references).

-- ---------------------------------------------------------------------------
-- 1. Notification outbox -- narrowly scoped to this feature (two
--    notification types only, no generic payload jsonb column, per YAGNI).
--    Triggers cannot send HTTP requests; a separate cron job (Task 4) drains
--    this table and performs the actual send.
-- ---------------------------------------------------------------------------

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

-- No client-facing RLS -- written only by the trigger below (runs in the
-- same transaction as the sessions UPDATE, not SECURITY DEFINER itself
-- since triggers run with the privileges of the table owner by default)
-- and read only by the outbox-processing cron's service-role client.
alter table session_notification_outbox enable row level security;
-- (No policies created -- RLS enabled with zero policies denies all access
-- to non-service-role callers, matching the lockdown pattern used for
-- allocation_assignments-adjacent internal tables.)

-- ---------------------------------------------------------------------------
-- 2. The lifecycle trigger
-- ---------------------------------------------------------------------------

create function enforce_session_lifecycle_booking_sync() returns trigger as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    -- Session was just cancelled: mark every active booking as
    -- session_cancelled (distinct from participant-voluntary 'cancelled')
    -- and queue one notification per affected booking. Uses a writable CTE
    -- (UPDATE ... RETURNING feeding INSERT ... SELECT) to capture exactly
    -- the rows this statement updated, rather than a second lookup query
    -- that would need some other way to identify "the rows I just
    -- touched" (e.g. re-matching on cancelled_at = now() -- correct since
    -- now() is stable within one statement/transaction, but an indirect,
    -- easier-to-get-wrong way to express the same thing; the CTE form
    -- below is the one to actually implement, not an alternative to
    -- consider).
    with just_cancelled as (
      update session_bookings
      set status = 'session_cancelled', cancelled_at = now()
      where session_id = new.id and status = 'active'
      returning id, application_id, session_id
    )
    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
    select id, application_id, session_id, 'session_cancelled' from just_cancelled;

  elsif (new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time)
        and new.status <> 'cancelled' then
    -- Session's time changed (not a cancellation): bookings stay valid,
    -- queue one reschedule notification per active booking. This SELECT
    -- reads session_bookings without locking it (only the sessions row is
    -- locked for this UPDATE's duration) -- a concurrent book_session()
    -- landing a new active booking right now is correctly swept up (it's
    -- genuinely active at commit), and a concurrent cancel_booking() takes
    -- its own row-level FOR UPDATE lock on that specific booking, so the
    -- worst case is a benign notification-timing race (an extra reschedule
    -- email for a booking cancelled a moment later), never incorrect
    -- session_bookings state.
    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type, old_start_time, new_start_time)
    select id, application_id, session_id, 'session_rescheduled', old.start_time, new.start_time
    from session_bookings
    where session_id = new.id and status = 'active';
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_lifecycle_booking_sync
  after update of status, start_time, end_time on sessions
  for each row execute function enforce_session_lifecycle_booking_sync();

-- ---------------------------------------------------------------------------
-- 3. cancel_booking() must also treat 'session_cancelled' as "already
--    cancelled" -- otherwise a participant voluntarily cancelling an
--    already-session-cancelled booking falls through to the deadline check
--    and could succeed in a confusing double-cancel.
-- ---------------------------------------------------------------------------

create or replace function cancel_booking(
  p_booking_id     uuid,
  p_application_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking  session_bookings%rowtype;
  v_session  sessions%rowtype;
  v_deadline timestamptz;
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
  v_deadline := coalesce(v_session.booking_deadline, v_session.start_time - interval '3 hours');

  if now() > v_deadline then
    raise exception 'Cannot cancel after the booking deadline';
  end if;

  update session_bookings
  set status = 'cancelled', cancelled_at = now()
  where id = p_booking_id;
end;
$$;

grant execute on function cancel_booking(uuid, uuid) to authenticated;
