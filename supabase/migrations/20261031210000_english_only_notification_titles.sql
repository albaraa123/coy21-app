-- supabase/migrations/20261031210000_english_only_notification_titles.sql
--
-- Product decision (2026-10-31): every email COY21 sends must be English
-- only, regardless of a participant's preferred_language. The TypeScript
-- side of this (process-notifications/route.ts, session-reminders/route.ts,
-- applications/[id]/actions.ts) was fixed in the same change; this
-- migration closes the other half of the gap -- three SECURITY DEFINER
-- functions (book_session, enforce_session_lifecycle_booking_sync,
-- promote_next_waitlist_candidate) that each branched on
-- coalesce(preferred_language, 'en') = 'ar' to bake Arabic text directly
-- into the notification row's p_title, independent of the TS layer
-- entirely.
--
-- Redefines all three functions from their latest prior definition
-- (20261008060000_isolate_notification_failures.sql) with ONLY the
-- locale branching removed from each notification title -- every other
-- line (locking, capacity/deadline/conflict checks, the
-- begin...exception...raise warning isolation wrapper, the
-- session_notification_outbox dual-write) is unchanged. preferred_language
-- is no longer read at all in any of the three (it had no other use in
-- these functions besides the title branch being removed).

drop function if exists book_session(uuid, uuid);

create or replace function book_session(p_application_id uuid, p_session_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session       sessions%rowtype;
  v_booking_id    uuid;
  v_count         int;
  v_deadline      timestamptz;
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

create or replace function enforce_session_lifecycle_booking_sync() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_candidate record;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    with just_cancelled as (
      update session_bookings
      set status = 'session_cancelled', cancelled_at = now()
      where session_id = new.id and status = 'active'
      returning id, application_id, session_id
    )
    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
    select id, application_id, session_id, 'session_cancelled' from just_cancelled;

    -- Temporary dual-write into the unified notifications table (see
    -- 20261008060000's header comment for the sunset condition) --
    -- English only (2026-10-31).
    for v_candidate in
      select sb.application_id, s.title_ar, s.title_en
      from session_bookings sb
      join sessions s on s.id = sb.session_id
      where sb.session_id = new.id and sb.status = 'session_cancelled' and sb.cancelled_at = (
        select max(cancelled_at) from session_bookings where session_id = new.id and status = 'session_cancelled'
      )
    loop
      begin
        perform create_notification(
          p_application_id => v_candidate.application_id,
          p_channel => 'session_cancelled',
          p_title => 'Session cancelled: ' || coalesce(v_candidate.title_en, v_candidate.title_ar, ''),
          p_link_path => '/my-agenda/browse',
          p_session_id => new.id
        );
      exception when others then
        raise warning 'enforce_session_lifecycle_booking_sync (session_cancelled): create_notification failed for application_id=%, session_id=%: %', v_candidate.application_id, new.id, sqlerrm;
      end;
    end loop;

  elsif (new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time)
        and new.status <> 'cancelled' then
    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type, old_start_time, new_start_time)
    select id, application_id, session_id, 'session_rescheduled', old.start_time, new.start_time
    from session_bookings
    where session_id = new.id and status = 'active';

    -- Temporary dual-write into notifications -- English only (2026-10-31).
    for v_candidate in
      select sb.application_id, s.title_ar, s.title_en
      from session_bookings sb
      join sessions s on s.id = sb.session_id
      where sb.session_id = new.id and sb.status = 'active'
    loop
      begin
        perform create_notification(
          p_application_id => v_candidate.application_id,
          p_channel => 'session_rescheduled',
          p_title => 'Session rescheduled: ' || coalesce(v_candidate.title_en, v_candidate.title_ar, ''),
          p_link_path => '/my-agenda',
          p_session_id => new.id,
          p_old_start_time => old.start_time,
          p_new_start_time => new.start_time
        );
      exception when others then
        raise warning 'enforce_session_lifecycle_booking_sync (session_rescheduled): create_notification failed for application_id=%, session_id=%: %', v_candidate.application_id, new.id, sqlerrm;
      end;
    end loop;
  end if;

  return new;
end;
$$;

create or replace function promote_next_waitlist_candidate(p_session_id uuid) returns void
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
    values (v_new_booking_id, v_candidate.application_id, p_session_id, 'waitlist_promoted');

    -- Temporary dual-write into notifications -- English only (2026-10-31).
    begin
      perform create_notification(
        p_application_id => v_candidate.application_id,
        p_channel => 'waitlist_promoted',
        p_title => 'You''ve been promoted from the waitlist: ' || coalesce(v_session.title_en, v_session.title_ar, ''),
        p_link_path => '/my-agenda',
        p_session_id => p_session_id
      );
    exception when others then
      raise warning 'promote_next_waitlist_candidate: create_notification failed for application_id=%, session_id=%: %', v_candidate.application_id, p_session_id, sqlerrm;
    end;

    exit promotion;
  end loop;
end;
$$;
