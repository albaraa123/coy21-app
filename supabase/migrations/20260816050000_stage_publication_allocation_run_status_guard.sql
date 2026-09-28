-- 20260816050000_stage_publication_allocation_run_status_guard.sql
--
-- Closes a pre-existing, already-documented production gap (docs/superpowers/
-- specs/2026-07-31-pre-existing-test-failures-technical-debt.md item 6a,
-- deferred there pending "a real design decision"; resolved now during
-- Phase 7G-B): stage_publication_transactional had no guard rejecting a
-- non-'confirmed' allocation_runs.status on the run-publish path, unlike its
-- sibling confirm_publication_transactional, which does guard its own
-- precondition (schedule_publication_drafts.status = 'staged').
--
-- Guard applies ONLY when p_allocation_run_id is not null (the run-publish
-- path) — the change-propagation path (p_allocation_run_id null,
-- p_change_event_ids supplied instead) has no allocation_runs row to check
-- against at all and is unaffected.
--
-- Placed as the very first statement in the function body, before any
-- read/write, so a rejected call causes zero mutation. Everything else
-- below is byte-for-byte identical to the current live definition
-- (supabase/migrations/20260723190000_schedule_publication_functions.sql),
-- copied verbatim — this migration changes nothing else about the
-- function's behavior.

create or replace function stage_publication_transactional(
  p_allocation_run_id uuid,
  p_change_event_ids uuid[],
  p_staged_by uuid
) returns schedule_publication_drafts as $$
declare
  v_draft schedule_publication_drafts;
  v_fingerprint text;
  v_application_id uuid;
  v_verdict text;
  v_has_mandatory_blocker boolean;
  v_content_differs boolean;
  v_session_ids uuid[];
  v_allocation_run_status text;
begin
  if p_allocation_run_id is not null then
    select status into v_allocation_run_status from allocation_runs where id = p_allocation_run_id;
    if v_allocation_run_status is null then
      raise exception 'Allocation run % not found', p_allocation_run_id;
    end if;
    if v_allocation_run_status <> 'confirmed' then
      raise exception 'Allocation run % is not confirmed (status: %) — only a confirmed allocation run can be staged for publication', p_allocation_run_id, v_allocation_run_status;
    end if;
  end if;

  v_fingerprint := compute_publication_fingerprint(p_allocation_run_id, p_change_event_ids);

  -- Resolved once, up front, for the change-propagation path's
  -- content_differs check below, via the same shared helper
  -- compute_publication_fingerprint uses internally — never duplicated
  -- inline, so the two can't drift apart again.
  if p_allocation_run_id is null then
    v_session_ids := resolve_change_event_session_ids(p_change_event_ids);
  end if;

  insert into schedule_publication_drafts (
    allocation_run_id, triggered_by_change_event_ids, staged_by, source_fingerprint, status
  ) values (
    p_allocation_run_id, p_change_event_ids, p_staged_by, v_fingerprint, 'staged'
  ) returning * into v_draft;

  if p_allocation_run_id is not null then
    -- Candidate participants: every accepted application with at least one
    -- assignment in this run.
    for v_application_id in
      select distinct application_id from allocation_assignments where allocation_run_id = p_allocation_run_id
    loop
      select exists (
        select 1 from allocation_issues ai
        join sessions s on s.id = ai.session_id
        where ai.allocation_run_id = p_allocation_run_id
          and ai.application_id = v_application_id
          and ai.issue_type in ('unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
          and s.is_mandatory = true
      ) into v_has_mandatory_blocker;

      -- content_differs: true if there is no current active
      -- schedule_publications row for this application, or if this run's
      -- assignment set for the participant differs from the active
      -- revision's items (compared on session_id set).
      select not exists (
        select 1 from schedule_publications sp
        where sp.application_id = v_application_id and sp.status = 'active'
          and (
            select array_agg(aa.session_id order by aa.session_id)
            from allocation_assignments aa
            where aa.allocation_run_id = p_allocation_run_id and aa.application_id = v_application_id
          ) = (
            select array_agg(spi.session_id order by spi.session_id)
            from schedule_publication_items spi
            where spi.schedule_publication_id = sp.id and spi.item_status = 'active'
          )
      ) into v_content_differs;

      if v_has_mandatory_blocker then
        v_verdict := 'blocked_mandatory';
      elsif not v_content_differs then
        v_verdict := 'no_change';
      else
        v_verdict := 'publishable';
      end if;

      insert into schedule_publication_draft_items (schedule_publication_draft_id, application_id, verdict, blocker_details)
      values (
        v_draft.id,
        v_application_id,
        v_verdict,
        case when v_has_mandatory_blocker then
          (select jsonb_agg(jsonb_build_object('issue_type', ai.issue_type, 'session_id', ai.session_id))
           from allocation_issues ai join sessions s on s.id = ai.session_id
           where ai.allocation_run_id = p_allocation_run_id and ai.application_id = v_application_id
             and ai.issue_type in ('unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
             and s.is_mandatory = true)
        else null end
      );
    end loop;
  else
    -- Change-propagation path: candidate participants are those with an
    -- active schedule_publication_items row referencing a session in
    -- v_session_ids (resolved from the change events). Blocking is driven
    -- by change_type = 'cancelled' on ANY affected item — mandatory or
    -- elective — not by allocation_issues (which don't apply to a
    -- change-propagation batch). Per the spec's Change Propagation
    -- Policy, a cancellation "must pick reassignment or explicit 'confirm
    -- cancelled' resolution... before any draft including this
    -- participant can be confirmed" — that requirement is not scoped to
    -- mandatory sessions, so an elective session's cancellation blocks
    -- exactly the same way a mandatory one does. (An earlier version of
    -- this check incorrectly scoped blocking to is_mandatory = true only,
    -- which let an elective cancellation silently reach confirm with no
    -- admin review — fixed here.)
    --
    -- content_differs: unlike the run-publish path, we can't compare
    -- session-id sets (the session assignment itself hasn't changed, only
    -- its frozen fields) — instead compare the recomputed frozen fields
    -- (start_time, end_time, room_id, and the session_people-derived
    -- speaker set) against the currently-stored frozen values on the
    -- active item. This mirrors compute_publication_fingerprint's own
    -- change-propagation hash inputs, so a truly no-op change event (e.g.
    -- a session_people row updated then immediately reverted before this
    -- batch was staged) correctly classifies as no_change rather than
    -- spuriously bumping the participant's revision_number.
    for v_application_id in
      select distinct sp.application_id
      from schedule_publications sp
      join schedule_publication_items spi on spi.schedule_publication_id = sp.id
      join schedule_change_events sce on sce.session_id = spi.session_id
      where sp.status = 'active' and spi.item_status in ('active', 'stale', 'pending_review')
        and sce.id = any(p_change_event_ids)
    loop
      select exists (
        select 1
        from schedule_publications sp
        join schedule_publication_items spi on spi.schedule_publication_id = sp.id
        join schedule_change_events sce on sce.session_id = spi.session_id
        where sp.application_id = v_application_id and sp.status = 'active'
          and sce.id = any(p_change_event_ids) and sce.change_type = 'cancelled'
      ) into v_has_mandatory_blocker;

      select exists (
        select 1
        from schedule_publications sp
        join schedule_publication_items spi on spi.schedule_publication_id = sp.id
        join sessions s on s.id = spi.session_id
        where sp.application_id = v_application_id and sp.status = 'active'
          and spi.session_id = any(v_session_ids)
          and (
            spi.start_time is distinct from s.start_time
            or spi.end_time is distinct from s.end_time
            or spi.room_name_en is distinct from (select r.name_en from rooms r where r.id = s.room_id)
            or spi.speakers is distinct from (
              select coalesce(jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp2.role)), '[]'::jsonb)
              from session_people sp2 join people p on p.id = sp2.person_id
              where sp2.session_id = s.id
            )
          )
      ) into v_content_differs;

      if v_has_mandatory_blocker then
        v_verdict := 'blocked_mandatory';
      elsif not v_content_differs then
        v_verdict := 'no_change';
      else
        v_verdict := 'publishable';
      end if;

      insert into schedule_publication_draft_items (schedule_publication_draft_id, application_id, verdict)
      values (v_draft.id, v_application_id, v_verdict);
    end loop;
  end if;

  return v_draft;
end;
$$ language plpgsql set search_path = public, pg_temp;
