-- override_capacity_check_in_transaction.sql
--
-- Closes a TOCTOU race found in final-branch code review: the original
-- override_allocation_assignment_transactional only re-validated that the
-- target run was still 'draft', leaving the this-run capacity re-count in
-- the calling TypeScript action as a separate, non-transactional read
-- before the write. Two concurrent overrides targeting the same near-full
-- session could both read count < capacity, both pass, and both write,
-- overshooting session.capacity for the run. Moving the count inside this
-- function makes the whole check-then-write atomic.
create or replace function override_allocation_assignment_transactional(
  p_assignment_id uuid,
  p_new_session_id uuid,
  p_overridden_by uuid,
  p_override_reason text
) returns allocation_assignments as $$
declare
  v_result allocation_assignments;
  v_run_id uuid;
  v_run_status text;
  v_capacity int;
  v_current_count int;
begin
  select aa.allocation_run_id, ar.status into v_run_id, v_run_status
  from allocation_assignments aa
  join allocation_runs ar on ar.id = aa.allocation_run_id
  where aa.id = p_assignment_id;

  if v_run_status is null then
    raise exception 'Allocation assignment % not found', p_assignment_id;
  end if;

  if v_run_status <> 'draft' then
    raise exception 'Cannot override an assignment on a % allocation run — only draft runs are editable', v_run_status;
  end if;

  select capacity into v_capacity from sessions where id = p_new_session_id;
  if v_capacity is null then
    raise exception 'Target session % not found', p_new_session_id;
  end if;

  -- Scoped to this run only (spec: "Capacity re-validation scope") — counts
  -- this run's own assignments currently pointing at the target session,
  -- any status. Runs inside the same transaction as the write below, so no
  -- concurrent override can slip in between the count and the update.
  select count(*) into v_current_count
  from allocation_assignments
  where allocation_run_id = v_run_id and session_id = p_new_session_id;

  if v_current_count >= v_capacity then
    raise exception 'Cannot assign: session % is at capacity (% / %) for this allocation run', p_new_session_id, v_current_count, v_capacity;
  end if;

  update allocation_assignments
  set session_id = p_new_session_id,
      is_manual_override = true,
      overridden_by = p_overridden_by,
      override_reason = p_override_reason,
      updated_by = p_overridden_by
  where id = p_assignment_id
  returning * into v_result;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;
