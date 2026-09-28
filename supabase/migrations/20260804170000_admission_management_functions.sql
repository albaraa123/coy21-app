-- admission_management_functions.sql
create or replace function correct_attendance_transactional(
  p_attendance_id uuid,
  p_corrected_by uuid,
  p_reason text
) returns attendance_records as $$
declare
  v_result attendance_records;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A correction reason is required';
  end if;

  update attendance_records
  set status = 'corrected', correction_reason = p_reason
  where id = p_attendance_id and status = 'admitted'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Attendance record % not found or not in admitted status', p_attendance_id;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

create or replace function transfer_attendance_transactional(
  p_attendance_id uuid,
  p_new_session_id uuid,
  p_new_time_slot_group_key text,
  p_transferred_by uuid,
  p_reason text
) returns attendance_records as $$
declare
  v_old attendance_records;
  v_new attendance_records;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A transfer reason is required';
  end if;

  select * into v_old from attendance_records where id = p_attendance_id and status = 'admitted';
  if v_old.id is null then
    raise exception 'Attendance record % not found or not in admitted status', p_attendance_id;
  end if;

  update attendance_records
  set status = 'transferred_out', correction_reason = p_reason
  where id = p_attendance_id;

  -- p_new_time_slot_group_key is computed by the caller via
  -- computeTimeSlotGroupKeyForSession (Task 9) for p_new_session_id,
  -- immediately before calling this RPC — never recomputed here, same
  -- rationale as scan_attempt_transactional (Task 11).
  -- entry_type is always 'override' for the transferred-in row, regardless
  -- of the original admission's entry_type (priority/flexible) — a transfer
  -- is a manual, exceptional intervention that doesn't re-derive priority or
  -- flexible eligibility for the destination session. This is deliberate,
  -- not a bug: the participant permanently vacates their original pool.
  insert into attendance_records (application_id, session_id, time_slot_group_key, status, entry_type, scanned_by, superseded_attendance_id, correction_reason)
  values (v_old.application_id, p_new_session_id, p_new_time_slot_group_key, 'admitted', 'override', p_transferred_by, v_old.id, p_reason)
  returning * into v_new;

  return v_new;
end;
$$ language plpgsql set search_path = public, pg_temp;
