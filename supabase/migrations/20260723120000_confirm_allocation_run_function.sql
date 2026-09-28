-- confirm_allocation_run_function.sql

-- Atomically confirms a draft allocation run: transitions the run to
-- 'confirmed' and every one of its assignments to 'confirmed' in one
-- transaction (plpgsql function bodies are atomic). Rejects if the run is
-- not currently 'draft' — a confirmed or discarded run cannot be
-- re-confirmed, per the spec's "Once confirmed, immutable" rule.
create function confirm_allocation_run_transactional(
  p_run_id uuid,
  p_confirmed_by uuid
) returns allocation_runs as $$
declare
  v_result allocation_runs;
begin
  update allocation_runs
  set status = 'confirmed', confirmed_at = now(), confirmed_by = p_confirmed_by
  where id = p_run_id and status = 'draft'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Allocation run % is not in draft status (already confirmed or discarded, or does not exist)', p_run_id;
  end if;

  update allocation_assignments
  set status = 'confirmed', updated_by = p_confirmed_by
  where allocation_run_id = p_run_id;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Discards a draft run (never confirmed, kept for audit history). Same
-- immutability rule: only a draft run can be discarded.
create function discard_allocation_run_transactional(
  p_run_id uuid
) returns allocation_runs as $$
declare
  v_result allocation_runs;
begin
  update allocation_runs
  set status = 'discarded'
  where id = p_run_id and status = 'draft'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Allocation run % is not in draft status (already confirmed or discarded, or does not exist)', p_run_id;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Overrides a single assignment's session within a draft run. Re-validates
-- hard constraints and this-run-only capacity server-side before writing —
-- hard reject on failure, no bypass (spec: Manual Override Workflow). The
-- constraint/capacity re-check itself happens in the calling server action
-- (TypeScript, reusing checkStaticHardConstraints), not in this function;
-- this function only enforces the atomicity of "the run must still be
-- draft" and the write itself.
create function override_allocation_assignment_transactional(
  p_assignment_id uuid,
  p_new_session_id uuid,
  p_overridden_by uuid,
  p_override_reason text
) returns allocation_assignments as $$
declare
  v_result allocation_assignments;
  v_run_status text;
begin
  select ar.status into v_run_status
  from allocation_assignments aa
  join allocation_runs ar on ar.id = aa.allocation_run_id
  where aa.id = p_assignment_id;

  if v_run_status is null then
    raise exception 'Allocation assignment % not found', p_assignment_id;
  end if;

  if v_run_status <> 'draft' then
    raise exception 'Cannot override an assignment on a % allocation run — only draft runs are editable', v_run_status;
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
