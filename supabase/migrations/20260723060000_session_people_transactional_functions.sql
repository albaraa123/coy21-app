-- session_people_transactional_functions.sql
--
-- Transactional RPCs backing session-people assignment writes and the
-- combined schedule+assignment update. Mirrors the pattern established in
-- 20260723050000_update_session_transactional_function.sql: a plpgsql
-- function body is atomic by default, so wrapping multi-statement writes in
-- one function closes the gap a two-step client-side approach cannot close
-- (PostgREST/Supabase-js calls are not composable into one client
-- transaction).

create function assign_session_person_transactional(
  p_session_id uuid, p_person_id uuid, p_role session_person_role,
  p_display_order int, p_is_primary boolean, p_updated_by uuid
) returns session_people as $$
declare
  v_result session_people;
begin
  insert into session_people (session_id, person_id, role, display_order, is_primary, updated_by)
  values (p_session_id, p_person_id, p_role, p_display_order, p_is_primary, p_updated_by)
  returning * into v_result;
  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

create function remove_session_person(p_session_people_id uuid) returns void as $$
begin
  delete from session_people where id = p_session_people_id;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Combined schedule (start/end/room) + full assignment-set replacement for a
-- session, re-validated for speaker conflicts against the FINAL committed
-- state within this same transaction. This is what makes the "reschedule
-- alone is fine, assignment alone is fine, but the two together conflict"
-- scenario detectable and atomically rejectable — a two-step client
-- reschedule-then-reassign could commit the reschedule, then fail the
-- reassignment re-validation, leaving the session mid-air.
create function update_session_and_assignments_transactional(
  p_id uuid,
  p_start_time timestamptz, p_end_time timestamptz, p_room_id uuid,
  p_updated_by uuid,
  p_new_assignments jsonb -- array of {person_id, role, display_order, is_primary}
) returns sessions as $$
declare
  v_result sessions;
  v_conflict_person uuid;
  v_assignment jsonb;
begin
  update sessions set start_time = p_start_time, end_time = p_end_time, room_id = p_room_id, updated_by = p_updated_by
  where id = p_id
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Session % not found', p_id;
  end if;

  delete from session_people where session_id = p_id;

  for v_assignment in select * from jsonb_array_elements(p_new_assignments) loop
    insert into session_people (session_id, person_id, role, display_order, is_primary, updated_by)
    values (
      p_id,
      (v_assignment->>'person_id')::uuid,
      (v_assignment->>'role')::session_person_role,
      coalesce((v_assignment->>'display_order')::int, 0),
      coalesce((v_assignment->>'is_primary')::boolean, false),
      p_updated_by
    );
  end loop;

  if v_result.status in ('draft', 'published', 'confirmed') then
    select sp.person_id into v_conflict_person
      from session_people sp
      join session_people other_sp on other_sp.person_id = sp.person_id and other_sp.session_id <> sp.session_id
      join sessions other_s on other_s.id = other_sp.session_id
      where sp.session_id = p_id
        and other_s.status in ('draft', 'published', 'confirmed')
        and tstzrange(other_s.start_time, other_s.end_time, '[)') && tstzrange(v_result.start_time, v_result.end_time, '[)')
      limit 1;

    if v_conflict_person is not null then
      raise exception 'Person % has a scheduling conflict created by this combined update — the entire operation has been rejected', v_conflict_person;
    end if;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;
