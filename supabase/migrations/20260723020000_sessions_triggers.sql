-- sessions_triggers.sql

-- 1. Day-match: a session's start_time/end_time, converted to Asia/Muscat,
-- must fall on the same calendar date as its conference_day_id's
-- conference_date, and must not cross midnight into a different day.
create function enforce_session_day_match() returns trigger as $$
declare
  v_conference_date date;
  v_start_date date;
  v_end_date date;
begin
  select conference_date into v_conference_date from conference_days where id = new.conference_day_id;
  if v_conference_date is null then
    raise exception 'conference_day_id % does not exist', new.conference_day_id;
  end if;

  v_start_date := (new.start_time at time zone 'Asia/Muscat')::date;
  v_end_date := (new.end_time at time zone 'Asia/Muscat')::date;

  if v_start_date <> v_end_date then
    raise exception 'Session cannot span across midnight into a different conference day (start: %, end: %)', v_start_date, v_end_date;
  end if;

  if v_start_date <> v_conference_date then
    raise exception 'Session start/end time (%) does not match its conference day (%)', v_start_date, v_conference_date;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_day_match
  before insert or update of start_time, end_time, conference_day_id on sessions
  for each row execute function enforce_session_day_match();

-- 2. Status transition: mirrors SESSION_VALID_TRANSITIONS from
-- src/lib/validation/agenda.ts exactly. Also enforces cancellation_reason
-- is set when transitioning to cancelled, as a true DB-level backstop (not
-- just Zod/server-action) — see design spec's Data Model note on
-- cancellation_reason.
create function enforce_session_status_transition() returns trigger as $$
begin
  if old.status = new.status then
    return new; -- no-op status update always allowed
  end if;

  if new.status = 'cancelled' and (new.cancellation_reason is null or trim(new.cancellation_reason) = '') then
    raise exception 'A cancellation reason is required when cancelling a session';
  end if;

  case old.status
    when 'draft' then
      if new.status not in ('published', 'cancelled') then
        raise exception 'Cannot transition session from draft to %', new.status;
      end if;
    when 'published' then
      if new.status not in ('confirmed', 'cancelled') then
        raise exception 'Cannot transition session from published to %', new.status;
      end if;
    when 'confirmed' then
      if new.status not in ('completed', 'cancelled') then
        raise exception 'Cannot transition session from confirmed to %', new.status;
      end if;
    when 'cancelled' then
      raise exception 'Cannot transition session out of cancelled (terminal state)';
    when 'completed' then
      raise exception 'Cannot transition session out of completed (terminal state)';
  end case;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_status_transition
  before update of status on sessions
  for each row execute function enforce_session_status_transition();

-- 3. Session capacity cannot exceed its room's capacity.
create function enforce_session_room_capacity() returns trigger as $$
declare
  v_room_capacity int;
begin
  select capacity into v_room_capacity from rooms where id = new.room_id;
  if v_room_capacity is null then
    raise exception 'room_id % does not exist', new.room_id;
  end if;
  if new.capacity > v_room_capacity then
    raise exception 'Session capacity (%) exceeds room capacity (%)', new.capacity, v_room_capacity;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_room_capacity
  before insert or update of capacity, room_id on sessions
  for each row execute function enforce_session_room_capacity();

-- 4. Reducing a room's capacity is rejected if any active session in that
-- room now exceeds it. Admin must first reduce/reassign conflicting
-- sessions. Deliberately does not cascade a silent capacity change onto
-- sessions (see design spec's rationale for this choice).
create function revalidate_sessions_on_room_capacity_change() returns trigger as $$
declare
  v_conflict_count int;
begin
  if new.capacity >= old.capacity then
    return new; -- only a reduction needs checking
  end if;
  select count(*) into v_conflict_count
    from sessions
    where room_id = new.id
      and status in ('draft', 'published', 'confirmed')
      and capacity > new.capacity;
  if v_conflict_count > 0 then
    raise exception 'Cannot reduce room capacity to %: % active session(s) in this room exceed that capacity', new.capacity, v_conflict_count;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger rooms_revalidate_sessions_on_capacity_change
  before update of capacity on rooms
  for each row execute function revalidate_sessions_on_room_capacity_change();

-- 5. Speaker conflict on session_people insert/update: the person being
-- assigned/reassigned must not already be on another active session whose
-- time range overlaps this one's.
create function enforce_speaker_no_conflict() returns trigger as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_conflict_count int;
begin
  select start_time, end_time into v_start, v_end from sessions where id = new.session_id;
  if v_start is null then
    raise exception 'session_id % does not exist', new.session_id;
  end if;

  select count(*) into v_conflict_count
    from session_people sp
    join sessions s on s.id = sp.session_id
    where sp.person_id = new.person_id
      and sp.id is distinct from new.id
      and sp.session_id <> new.session_id
      and s.status in ('draft', 'published', 'confirmed')
      and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_start, v_end, '[)');

  if v_conflict_count > 0 then
    raise exception 'Person % is already assigned to another session that overlaps this time slot', new.person_id;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger session_people_enforce_no_conflict
  before insert or update of session_id, person_id, role on session_people
  for each row execute function enforce_speaker_no_conflict();

-- 6. Speaker conflict on sessions time/status change: when an existing
-- session's schedule or status changes, re-check every person currently
-- assigned to it against their other active sessions.
create function enforce_speaker_no_conflict_on_session_change() returns trigger as $$
declare
  v_conflict_person uuid;
begin
  select sp.person_id into v_conflict_person
    from session_people sp
    join session_people other_sp on other_sp.person_id = sp.person_id and other_sp.session_id <> sp.session_id
    join sessions other_s on other_s.id = other_sp.session_id
    where sp.session_id = new.id
      and new.status in ('draft', 'published', 'confirmed')
      and other_s.status in ('draft', 'published', 'confirmed')
      and tstzrange(other_s.start_time, other_s.end_time, '[)') && tstzrange(new.start_time, new.end_time, '[)')
    limit 1;

  if v_conflict_person is not null then
    raise exception 'Rescheduling this session creates a conflict for person % on another active session', v_conflict_person;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_speaker_no_conflict_on_change
  before update of start_time, end_time, status on sessions
  for each row execute function enforce_speaker_no_conflict_on_session_change();
