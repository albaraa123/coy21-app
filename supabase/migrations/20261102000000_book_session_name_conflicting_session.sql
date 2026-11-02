-- 20261102000000_book_session_name_conflicting_session.sql
--
-- Real participant-facing UX gap: book_session's two conflict-check
-- exceptions ("Time conflict with an existing booking" / "Time conflict
-- with an assigned session") never named the conflicting session, even
-- though the function's own query already has it in scope. A participant
-- who hits this had to leave the browse page, open My Agenda, and
-- visually scan for whichever booking overlapped -- the error message
-- itself answered "what" (a conflict) but not "which" (with what).
--
-- Fix: both conflict queries now select the conflicting session's
-- title_en (English only, matching this function's existing
-- English-only notification convention from 20261031210000) and append
-- it after a colon, keeping the original "Time conflict with an
-- existing booking" / "Time conflict with an assigned session" prefix
-- verbatim (not reworded to "your existing booking" etc.) --
-- tests/agenda/booking-allocation-conflict-live.test.ts asserts on that
-- exact prefix via toContain(), so the prefix must stay byte-for-byte
-- identical; only the ": <title>" suffix is new. No change to when a
-- conflict is raised, only what the message says. Redefined from the
-- latest prior definition (20261031210000_english_only_notification_
-- titles.sql) -- every other line (locking, capacity/deadline checks,
-- the notification insert) unchanged.
drop function if exists book_session(uuid, uuid);

create or replace function book_session(p_application_id uuid, p_session_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session               sessions%rowtype;
  v_booking_id            uuid;
  v_count                 int;
  v_deadline              timestamptz;
  v_session_title         text;
  v_conflicting_title     text;
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

  v_deadline := session_effective_deadline(v_session);
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  -- Capacity check (combined: session_bookings + confirmed allocation_assignments)
  v_count := session_effective_occupied_count(p_session_id);
  if v_count >= v_session.capacity then
    raise exception 'Session is full';
  end if;

  -- Conflict check: any active booking for this participant that overlaps?
  -- Names the conflicting session in the exception message so the
  -- participant doesn't have to go check My Agenda to find it.
  select s.title_en into v_conflicting_title
  from session_bookings sb
  join sessions s on s.id = sb.session_id
  where sb.application_id = p_application_id
    and sb.status = 'active'
    and tstzrange(s.start_time, s.end_time, '[)') &&
        tstzrange(v_session.start_time, v_session.end_time, '[)')
  limit 1;

  if v_conflicting_title is not null then
    raise exception 'Time conflict with an existing booking: %', v_conflicting_title;
  end if;

  select s.title_en into v_conflicting_title
  from allocation_assignments aa
  join sessions s on s.id = aa.session_id
  where aa.application_id = p_application_id
    and aa.status = 'confirmed'
    and tstzrange(s.start_time, s.end_time, '[)') &&
        tstzrange(v_session.start_time, v_session.end_time, '[)')
  limit 1;

  if v_conflicting_title is not null then
    raise exception 'Time conflict with an assigned session: %', v_conflicting_title;
  end if;

  insert into session_bookings (application_id, session_id)
  values (p_application_id, p_session_id)
  returning id into v_booking_id;

  -- booking_confirmed notification -- English only (2026-10-31).
  select title_en into v_session_title from sessions where id = p_session_id;

  -- Isolated: a notification-system failure must never undo a booking
  -- that already succeeded (20261008060000_isolate_notification_failures.sql).
  begin
    perform create_notification(
      p_application_id => p_application_id,
      p_channel => 'booking_confirmed',
      p_title => 'Your booking is confirmed: ' || coalesce(v_session_title, ''),
      p_link_path => '/my-agenda',
      p_session_id => p_session_id
    );
  exception when others then
    raise warning 'book_session: create_notification failed for application_id=%, session_id=%: %', p_application_id, p_session_id, sqlerrm;
  end;

  return v_booking_id;
end;
$$;

grant execute on function book_session(uuid, uuid) to authenticated;
