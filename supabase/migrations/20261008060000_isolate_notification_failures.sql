-- supabase/migrations/20261008060000_isolate_notification_failures.sql
--
-- Code-quality review of Task 3 (sub-project 6) found a real failure-
-- isolation gap: book_session, enforce_session_lifecycle_booking_sync(),
-- and promote_next_waitlist_candidate() each call the new
-- create_notification(...) RPC inline, unwrapped, inside their own
-- single top-level transaction -- so any exception from create_notification
-- (a constraint violation, a future bug) would roll back the ALREADY-
-- SUCCESSFUL booking/cancellation/promotion that preceded it in the same
-- transaction. This is inconsistent with updateApplicationStatusForCaller's
-- TS-side equivalent (src/app/[locale]/(admin)/applications/[id]/actions.ts),
-- which explicitly catches a create_notification RPC error and only logs
-- it, never rolling back the already-committed status change. Given this
-- lands about a week before a live conference and touches the most
-- failure-sensitive paths in the app (real session bookings, cancellations,
-- waitlist promotions), the SQL side is brought in line with the same
-- philosophy here: wrap every perform create_notification(...) call in its
-- own begin...exception block that logs via RAISE WARNING (visible in
-- Postgres/Supabase logs for debugging) and swallows the error, so a
-- notification-system failure can never prevent or undo a real booking,
-- cancellation, or promotion.
--
-- This is also a TEMPORARY dual-write (see the design rationale in
-- docs/superpowers/plans/2026-10-08-notifications-layer.md, Task 3 Step 1
-- and Task 6 Step 6): once sub-project 6's Task 6 unified
-- process-notifications cron is confirmed live and
-- process-session-notifications/route.ts is deleted, the pre-existing
-- session_notification_outbox inserts in these same functions become
-- removable in a FUTURE migration -- they are not meant to be permanent
-- alongside the new notifications writes.

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

  -- booking_confirmed notification. Resolve locale + session title
  -- directly here (same defensive ?? 'en' default pattern
  -- process-session-notifications/route.ts already uses, since
  -- preferred_language has no enum/check constraint -- free-text by
  -- convention only).
  select preferred_language into v_preferred_language from applications where id = p_application_id;
  select case when coalesce(v_preferred_language, 'en') = 'ar' then title_ar else title_en end
    into v_session_title from sessions where id = p_session_id;

  -- Isolated: a notification-system failure must never undo a booking
  -- that already succeeded. See this migration's header comment.
  begin
    perform create_notification(
      p_application_id => p_application_id,
      p_channel => 'booking_confirmed',
      p_title => case when coalesce(v_preferred_language, 'en') = 'ar'
        then 'تم تأكيد حجزك في: ' || coalesce(v_session_title, '')
        else 'Your booking is confirmed: ' || coalesce(v_session_title, '') end,
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

    -- Temporary dual-write into the unified notifications table too (see
    -- this migration's header comment for the sunset condition). Loop
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
      -- Isolated: see this migration's header comment -- a notification
      -- failure must never undo the cancellation that already committed.
      begin
        perform create_notification(
          p_application_id => v_candidate.application_id,
          p_channel => 'session_cancelled',
          p_title => case when coalesce(v_candidate.preferred_language, 'en') = 'ar'
            then 'تم إلغاء الجلسة: ' || coalesce(v_candidate.title_ar, v_candidate.title_en, '')
            else 'Session cancelled: ' || coalesce(v_candidate.title_en, v_candidate.title_ar, '') end,
          p_link_path => '/my-agenda/browse',
          p_session_id => new.id
        );
      exception when others then
        raise warning 'enforce_session_lifecycle_booking_sync (session_cancelled): create_notification failed for application_id=%, session_id=%: %', v_candidate.application_id, new.id, sqlerrm;
      end;
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

    -- Temporary dual-write into notifications (see header comment).
    for v_candidate in
      select sb.application_id, s.title_ar, s.title_en, a.preferred_language
      from session_bookings sb
      join sessions s on s.id = sb.session_id
      join applications a on a.id = sb.application_id
      where sb.session_id = new.id and sb.status = 'active'
    loop
      -- Isolated: see this migration's header comment.
      begin
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

    -- Temporary dual-write into notifications (see header comment).
    select preferred_language into v_preferred_language from applications where id = v_candidate.application_id;
    -- Isolated: see this migration's header comment -- a notification
    -- failure must never undo the promotion that already committed.
    begin
      perform create_notification(
        p_application_id => v_candidate.application_id,
        p_channel => 'waitlist_promoted',
        p_title => case when coalesce(v_preferred_language, 'en') = 'ar'
          then 'تمت ترقيتك من قائمة الانتظار: ' || coalesce(v_session.title_ar, v_session.title_en, '')
          else 'You''ve been promoted from the waitlist: ' || coalesce(v_session.title_en, v_session.title_ar, '') end,
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
