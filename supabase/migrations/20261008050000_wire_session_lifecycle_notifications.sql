-- supabase/migrations/20261008050000_wire_session_lifecycle_notifications.sql
--
-- Both bodies below are the full current definitions, fetched live via
-- pg_get_functiondef during plan-writing (2026-10-08). Every existing
-- statement is unchanged; only the new perform create_notification(...)
-- calls are additions.

create or replace function enforce_session_lifecycle_booking_sync() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_candidate record;
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

    -- NEW: dual-write into the unified notifications table too. Loop
    -- rather than a set-based insert, since create_notification resolves
    -- locale/title per application individually (consistent with every
    -- other producer in this sub-project) and is a security definer RPC
    -- call, not a plain insert that a set-based approach could batch.
    for v_candidate in
      select sb.application_id, s.title_ar, s.title_en, a.preferred_language
      from session_bookings sb
      join sessions s on s.id = sb.session_id
      join applications a on a.id = sb.application_id
      where sb.session_id = new.id and sb.status = 'session_cancelled' and sb.cancelled_at = (
        select max(cancelled_at) from session_bookings where session_id = new.id and status = 'session_cancelled'
      )
    loop
      perform create_notification(
        p_application_id => v_candidate.application_id,
        p_channel => 'session_cancelled',
        p_title => case when coalesce(v_candidate.preferred_language, 'en') = 'ar'
          then 'تم إلغاء الجلسة: ' || coalesce(v_candidate.title_ar, v_candidate.title_en, '')
          else 'Session cancelled: ' || coalesce(v_candidate.title_en, v_candidate.title_ar, '') end,
        p_link_path => '/my-agenda/browse',
        p_session_id => new.id
      );
    end loop;

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

    -- NEW: dual-write into notifications.
    for v_candidate in
      select sb.application_id, s.title_ar, s.title_en, a.preferred_language
      from session_bookings sb
      join sessions s on s.id = sb.session_id
      join applications a on a.id = sb.application_id
      where sb.session_id = new.id and sb.status = 'active'
    loop
      perform create_notification(
        p_application_id => v_candidate.application_id,
        p_channel => 'session_rescheduled',
        p_title => case when coalesce(v_candidate.preferred_language, 'en') = 'ar'
          then 'تم تغيير موعد الجلسة: ' || coalesce(v_candidate.title_ar, v_candidate.title_en, '')
          else 'Session rescheduled: ' || coalesce(v_candidate.title_en, v_candidate.title_ar, '') end,
        p_link_path => '/my-agenda',
        p_session_id => new.id,
        p_old_start_time => old.start_time,
        p_new_start_time => new.start_time
      );
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
  v_preferred_language text;
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
    -- Defense-in-depth, not closing a distinct gap: Postgres's FOR
    -- UPDATE / EvalPlanQual re-check already excludes a row a
    -- concurrent leave_waitlist withdrew before this loop's lock on
    -- it was granted, so this branch should be unreachable in
    -- practice -- kept as a guard against relying on undocumented
    -- planner behavior staying stable across a future Postgres
    -- version.
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

    -- NEW: dual-write into notifications.
    select preferred_language into v_preferred_language from applications where id = v_candidate.application_id;
    perform create_notification(
      p_application_id => v_candidate.application_id,
      p_channel => 'waitlist_promoted',
      p_title => case when coalesce(v_preferred_language, 'en') = 'ar'
        then 'تمت ترقيتك من قائمة الانتظار: ' || coalesce(v_session.title_ar, v_session.title_en, '')
        else 'You''ve been promoted from the waitlist: ' || coalesce(v_session.title_en, v_session.title_ar, '') end,
      p_link_path => '/my-agenda',
      p_session_id => p_session_id
    );

    exit promotion;
  end loop;
end;
$$;
