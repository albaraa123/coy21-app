-- supabase/migrations/20261008040000_wire_booking_confirmed_notification.sql
--
-- Body below is book_session's full current definition, fetched live via
-- pg_get_functiondef against vfwcbkjvinbtcntwjrzq during plan-writing
-- (2026-10-08) -- everything up to and including the session_bookings
-- insert is UNCHANGED from the current live function; the only addition
-- is the booking_confirmed notification block immediately after it.
drop function if exists book_session(uuid, uuid);

create or replace function book_session(p_application_id uuid, p_session_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session       sessions%rowtype;
  v_booking_id    uuid;
  v_count         int;
  v_deadline      timestamptz;
  v_preferred_language text;
  v_session_title text;
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

  -- NEW: booking_confirmed notification. Resolve locale + session title
  -- directly here (same defensive ?? 'en' default pattern
  -- process-session-notifications/route.ts already uses, since
  -- preferred_language has no enum/check constraint -- free-text by
  -- convention only).
  select preferred_language into v_preferred_language from applications where id = p_application_id;
  select case when coalesce(v_preferred_language, 'en') = 'ar' then title_ar else title_en end
    into v_session_title from sessions where id = p_session_id;

  perform create_notification(
    p_application_id => p_application_id,
    p_channel => 'booking_confirmed',
    p_title => case when coalesce(v_preferred_language, 'en') = 'ar'
      then 'تم تأكيد حجزك في: ' || coalesce(v_session_title, '')
      else 'Your booking is confirmed: ' || coalesce(v_session_title, '') end,
    p_link_path => '/my-agenda',
    p_session_id => p_session_id
  );

  return v_booking_id;
end;
$$;

grant execute on function book_session(uuid, uuid) to authenticated;
