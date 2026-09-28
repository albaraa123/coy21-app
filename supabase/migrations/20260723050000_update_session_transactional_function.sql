-- update_session_transactional_function.sql
--
-- Wraps a session update and its post-write speaker-conflict re-validation
-- in one real Postgres transaction (a plpgsql function body is atomic by
-- default), so a re-validation failure actually rolls back the update —
-- closing the gap a two-step client-side approach cannot close, since
-- PostgREST/Supabase-js calls are not composable into one client transaction.
create function update_session_transactional(
  p_id uuid,
  p_session_code text, p_title_ar text, p_title_en text,
  p_description_ar text, p_description_en text,
  p_conference_day_id uuid, p_start_time timestamptz, p_end_time timestamptz,
  p_track_id uuid, p_session_type_id uuid, p_room_id uuid,
  p_language session_language, p_difficulty_level session_difficulty,
  p_capacity int, p_min_capacity int,
  p_is_mandatory boolean, p_is_public boolean,
  p_include_in_allocation boolean, p_allocation_priority int,
  p_enable_qr_checkin boolean, p_checkin_opens_at timestamptz, p_checkin_closes_at timestamptz,
  p_internal_notes text, p_updated_by uuid
) returns sessions as $$
declare
  v_result sessions;
  v_conflict_person uuid;
begin
  update sessions set
    session_code = p_session_code, title_ar = p_title_ar, title_en = p_title_en,
    description_ar = p_description_ar, description_en = p_description_en,
    conference_day_id = p_conference_day_id, start_time = p_start_time, end_time = p_end_time,
    track_id = p_track_id, session_type_id = p_session_type_id, room_id = p_room_id,
    language = p_language, difficulty_level = p_difficulty_level,
    capacity = p_capacity, min_capacity = p_min_capacity,
    is_mandatory = p_is_mandatory, is_public = p_is_public,
    include_in_allocation = p_include_in_allocation, allocation_priority = p_allocation_priority,
    enable_qr_checkin = p_enable_qr_checkin, checkin_opens_at = p_checkin_opens_at, checkin_closes_at = p_checkin_closes_at,
    internal_notes = p_internal_notes, updated_by = p_updated_by
  where id = p_id
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Session % not found', p_id;
  end if;

  -- Final re-validation: every person currently assigned to this session,
  -- checked against their other active sessions, using the session's FINAL
  -- committed-within-this-transaction time/status. This runs after the
  -- update above (so session_people's join to sessions sees the new time)
  -- and closes the multi-statement/firing-order gap described in the design
  -- spec — if this finds a conflict, the exception below rolls back the
  -- entire function body, including the update already performed above.
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
      raise exception 'Person % has a scheduling conflict with this session''s new time — the update has been rejected', v_conflict_person;
    end if;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;
