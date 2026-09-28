-- reassign_blocked_participant_function.sql

-- Resolves a blocked_mandatory draft item by pointing it at a different
-- session, entirely within the still-staged draft. Never mutates Phase 4's
-- allocation_assignments/allocation_runs — those stay untouched; only this
-- draft's proposed publication content changes. Cannot reuse Phase 4's
-- override_allocation_assignment_transactional, which hard-rejects unless
-- the target run is 'draft' status, and Phase 5 only ever operates on
-- 'confirmed' runs.
--
-- Does NOT re-check hard constraints (status/inclusion/language/
-- difficulty) — that happens in the calling server action via
-- checkStaticHardConstraints (see Task 16), which must run and reject
-- BEFORE this RPC is ever called. This RPC only re-validates the one
-- genuinely SQL-native concern (this-draft capacity) and performs the
-- write.
create function reassign_blocked_participant_transactional(
  p_draft_item_id uuid,
  p_new_session_id uuid,
  p_reassigned_by uuid
) returns schedule_publication_draft_items as $$
declare
  v_item schedule_publication_draft_items;
  v_draft_status text;
  v_session_capacity int;
  v_current_count int;
begin
  -- NOTE: the plan's given SQL used a single
  --   select spdi.*, spd.status into v_item, v_draft_status
  -- but Postgres rejects mixing a record target (v_item receiving spdi.*)
  -- with an additional scalar target in the same INTO list
  -- (SQLSTATE 42601: "record variable cannot be part of multiple-item INTO
  -- list") — confirmed live against the hosted project; the migration does
  -- not apply as originally written. Split into two statements with
  -- identical join/filter semantics; behavior is unchanged.
  select spdi.* into v_item
  from schedule_publication_draft_items spdi
  where spdi.id = p_draft_item_id;

  select spd.status into v_draft_status
  from schedule_publication_drafts spd
  where spd.id = v_item.schedule_publication_draft_id;

  if v_item.id is null then
    raise exception 'Draft item % not found', p_draft_item_id;
  end if;
  if v_item.verdict <> 'blocked_mandatory' then
    raise exception 'Draft item % is not blocked_mandatory (verdict is %)', p_draft_item_id, v_item.verdict;
  end if;
  if v_draft_status <> 'staged' then
    raise exception 'Cannot reassign on a % draft — only staged drafts are editable', v_draft_status;
  end if;

  select capacity into v_session_capacity from sessions where id = p_new_session_id;
  if v_session_capacity is null then
    raise exception 'Target session % not found', p_new_session_id;
  end if;

  -- This-draft-scoped capacity: count draft items ALREADY reassigned to
  -- THIS SPECIFIC target session within this same draft. Scoped by
  -- reassigned_session_id (added because schedule_publication_draft_items
  -- originally had no column recording which session a reassignment
  -- pointed at, making this recount count every reassigned item in the
  -- whole draft regardless of target session — found and fixed after
  -- live verification showed reassigning to a different, empty session
  -- was incorrectly rejected just because an unrelated session was full).
  -- Approximate by design for this within-draft correction step and
  -- re-validated for real at Confirm time by the same session's real
  -- capacity constraint already enforced elsewhere in the system.
  select count(*) into v_current_count
  from schedule_publication_draft_items
  where schedule_publication_draft_id = v_item.schedule_publication_draft_id
    and verdict = 'publishable' and resolution = 'reassigned'
    and reassigned_session_id = p_new_session_id;

  if v_current_count >= v_session_capacity then
    raise exception 'Cannot reassign: session % is at capacity (% / %) within this draft', p_new_session_id, v_current_count, v_session_capacity;
  end if;

  update schedule_publication_draft_items
  set verdict = 'publishable', resolution = 'reassigned', reassigned_session_id = p_new_session_id
  where id = p_draft_item_id
  returning * into v_item;

  return v_item;
end;
$$ language plpgsql set search_path = public, pg_temp;
