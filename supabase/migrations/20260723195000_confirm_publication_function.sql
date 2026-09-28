-- confirm_publication_function.sql

-- NOTE: this file's timestamp (195000) predates 20260723200000/201000, but
-- this function's body was edited (via create-or-replace, applied live and
-- committed here) AFTER those two migrations existed, and now references
-- schedule_publication_draft_items.reassigned_session_id — a column
-- 201000 adds. This works today only because v_item below is declared as
-- an untyped `record`, so PL/pgSQL defers field-reference resolution
-- until first execution rather than validating it at CREATE FUNCTION
-- time. If v_item is ever changed to
-- schedule_publication_draft_items%rowtype, this migration would need to
-- be renumbered to run after 201000, or it would fail to apply on a fresh
-- database.

-- Confirm: re-validates the fingerprint against current committed source
-- state (rejects with 'expired' if source data moved since staging);
-- acquires a transaction-scoped advisory lock keyed on the draft's source
-- identity (prevents concurrent publish interleaving); writes new
-- schedule_publications/schedule_publication_items rows only for
-- participants whose draft item verdict is 'publishable' (idempotent —
-- 'no_change' participants get no new row, 'blocked_mandatory' rows with
-- no resolution are skipped entirely); all in one short atomic
-- transaction. Rule 8's atomicity applies to this function's own writes.
create function confirm_publication_transactional(
  p_draft_id uuid,
  p_confirmed_by uuid
) returns schedule_publication_drafts as $$
declare
  v_draft schedule_publication_drafts;
  v_current_fingerprint text;
  v_lock_key bigint;
  v_item record;
  v_new_publication_id uuid;
  v_next_revision int;
  v_session record;
  v_speakers jsonb;
  v_session_ids uuid[];
  v_sorted_event_ids text;
  v_prior_publication_id uuid;
begin
  select * into v_draft from schedule_publication_drafts where id = p_draft_id and status = 'staged';
  if v_draft.id is null then
    raise exception 'Draft % is not in staged status (already confirmed, expired, discarded, or does not exist)', p_draft_id;
  end if;

  -- Sort before joining so two drafts over the same underlying change-event
  -- set, built from arrays passed in a different order, still hash to the
  -- same advisory lock key and correctly mutually exclude each other.
  if v_draft.triggered_by_change_event_ids is not null then
    select string_agg(id::text, ',' order by id) into v_sorted_event_ids
    from unnest(v_draft.triggered_by_change_event_ids) as id;
  end if;
  v_lock_key := hashtext(coalesce(v_draft.allocation_run_id::text, v_sorted_event_ids));
  if not pg_try_advisory_xact_lock(v_lock_key) then
    raise exception 'Another publication for this source is already in progress';
  end if;

  if v_draft.allocation_run_id is null then
    v_session_ids := resolve_change_event_session_ids(v_draft.triggered_by_change_event_ids);
  end if;

  v_current_fingerprint := compute_publication_fingerprint(v_draft.allocation_run_id, v_draft.triggered_by_change_event_ids);
  if v_current_fingerprint <> v_draft.source_fingerprint then
    -- Note: PL/pgSQL has no autonomous transactions, so an update here
    -- cannot durably persist a status change while this same invocation
    -- also raises an exception — Postgres rolls back every write this
    -- function made once the exception propagates, including this one.
    -- The draft is therefore left in 'staged', not 'expired', after this
    -- rejection; re-confirming the same draft re-detects the drift and
    -- re-rejects it identically every time, so this has no data-integrity
    -- consequence, only a cosmetic one (the 'expired' status value is
    -- unreachable via this path as currently designed). Marking a draft
    -- 'expired' for observability would require either a caller-side
    -- follow-up write after catching this exception, or restructuring
    -- this function to return rather than raise on drift — deferred
    -- rather than solved with a workaround here.
    raise exception 'Source data changed since this draft was staged — re-stage before publishing';
  end if;

  -- Ordered by application_id: makes processing order deterministic and
  -- reproducible across runs (otherwise cursor order depends on
  -- unspecified physical row order) — a harmless, cheap guarantee to have
  -- regardless of any specific test's needs.
  for v_item in
    select * from schedule_publication_draft_items
    where schedule_publication_draft_id = p_draft_id
      and (verdict = 'publishable' or (verdict = 'blocked_mandatory' and resolution is not null))
    order by application_id
  loop
    -- Supersede the current active revision for this participant, if any
    -- — capturing its id directly rather than re-deriving "most recent
    -- superseded" later, so the change-propagation carry-forward below
    -- has no implicit ordering dependency on this statement having run
    -- first (previously relied on `status = 'superseded' order by
    -- revision_number desc limit 1`, correct today but fragile against a
    -- future reordering).
    update schedule_publications set status = 'superseded'
    where application_id = v_item.application_id and status = 'active'
    returning id into v_prior_publication_id;

    select coalesce(max(revision_number), 0) + 1 into v_next_revision
    from schedule_publications where application_id = v_item.application_id;

    insert into schedule_publications (application_id, allocation_run_id, revision_number, status, source_fingerprint, published_by)
    values (
      v_item.application_id,
      coalesce(v_draft.allocation_run_id, (select allocation_run_id from schedule_publications where application_id = v_item.application_id order by revision_number desc limit 1)),
      v_next_revision, 'active', v_current_fingerprint, p_confirmed_by
    ) returning id into v_new_publication_id;

    -- The gap item (below, for a publish_with_gap-resolved mandatory
    -- blocker) and the participant's real assigned-session items (the loop
    -- further below) are intentionally NOT mutually exclusive: a
    -- publish_with_gap resolution means "no assignment exists for the
    -- mandatory slot this participant was blocked on" — there is no
    -- allocation_assignments row for that slot, so the loop below simply
    -- never produces an item for it. The gap item fills exactly that
    -- specific missing slot, while the loop below still correctly
    -- publishes every OTHER real assignment (e.g. their electives) the
    -- participant does have. The two paths write disjoint items by
    -- construction, not by an explicit guard.
    if v_item.resolution = 'override_publish_with_gap' then
      insert into schedule_publication_items (schedule_publication_id, session_id, is_mandatory, item_status, gap_reason)
      values (v_new_publication_id, null, true, 'active', v_item.override_reason);
    end if;

    -- A 'reassigned' resolution (reassign_blocked_participant_transactional,
    -- Task 10) means the participant's blocked mandatory slot was pointed
    -- at a different session — reassigned_session_id, on the draft item
    -- itself, not allocation_assignments (which has no row for this
    -- participant+slot; that's exactly why it was blocked). Publish that
    -- session's current data directly, same shape as the run-publish loop
    -- below but sourced from the draft item's reassignment instead of an
    -- allocation_assignments row. Disjoint from both the gap-item branch
    -- above (mutually exclusive resolution values, checked by the enum
    -- constraint) and the allocation_assignments loop below (no row exists
    -- for this participant+slot on the run-publish path, or the loop below
    -- is skipped entirely on the change-propagation path).
    if v_item.resolution = 'reassigned' then
      select s.*, r.name_ar as room_name_ar, r.name_en as room_name_en
      into v_session
      from sessions s join rooms r on r.id = s.room_id
      where s.id = v_item.reassigned_session_id;

      select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp.role))
      into v_speakers
      from session_people sp join people p on p.id = sp.person_id
      where sp.session_id = v_session.id;

      insert into schedule_publication_items (
        schedule_publication_id, session_id, session_title_ar, session_title_en,
        room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers, item_status
      ) values (
        v_new_publication_id, v_session.id, v_session.title_ar, v_session.title_en,
        v_session.room_name_ar, v_session.room_name_en,
        v_session.start_time, v_session.end_time, v_session.is_mandatory,
        coalesce(v_speakers, '[]'::jsonb), 'active'
      );
    end if;

    if v_draft.allocation_run_id is not null then
      for v_session in
        select s.*, r.name_ar as room_name_ar, r.name_en as room_name_en, aa.suitability_score, aa.is_low_confidence
        from allocation_assignments aa
        join sessions s on s.id = aa.session_id
        join rooms r on r.id = s.room_id
        where aa.allocation_run_id = v_draft.allocation_run_id and aa.application_id = v_item.application_id
      loop
        select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp.role))
        into v_speakers
        from session_people sp join people p on p.id = sp.person_id
        where sp.session_id = v_session.id;

        insert into schedule_publication_items (
          schedule_publication_id, session_id, session_title_ar, session_title_en,
          room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
          suitability_score, item_status
        ) values (
          v_new_publication_id, v_session.id, v_session.title_ar, v_session.title_en,
          v_session.room_name_ar, v_session.room_name_en,
          v_session.start_time, v_session.end_time, v_session.is_mandatory,
          coalesce(v_speakers, '[]'::jsonb), v_session.suitability_score, 'active'
        );
      end loop;
    else
      -- Change-propagation path: carry forward EVERY item from the
      -- participant's prior active (now-superseded, id captured above in
      -- v_prior_publication_id) revision — the underlying session
      -- assignment hasn't changed, only some sessions' frozen display
      -- fields have. For items whose session_id is one of this batch's
      -- affected sessions, refresh the frozen fields from current live
      -- state (mirrors what stage_publication_transactional's
      -- content_differs check already compared against); every other
      -- item is carried forward verbatim, regardless of its current
      -- item_status (not filtered to 'active' — a 'stale'/'pending_review'
      -- item from an unrelated earlier change batch must not be silently
      -- dropped just because this confirm call is about a different
      -- session).
      --
      -- This branch never needs to decide a 'cancelled' item_status
      -- itself: stage_publication_transactional's blocker check now
      -- treats ANY cancelled session referenced by an active item as
      -- blocking (mandatory or elective — see that function's comment),
      -- so a draft item can only reach this loop at all if either (a) no
      -- affected session was cancelled, or (b) it was cancelled and the
      -- blocker was explicitly resolved. Resolution handling (updating
      -- the carried-forward item to reflect that resolution) is Task 10's
      -- concern once reassign_blocked_participant_transactional exists;
      -- this function does not yet special-case a resolved cancellation
      -- and will simply carry the item's frozen fields forward unchanged
      -- if session_id is not in v_session_ids, or refresh them from
      -- (still-cancelled) live session state if it is — deliberately not
      -- guessing an item_status transition that belongs to a resolution
      -- step this function doesn't implement.
      for v_session in
        select spi.id as item_id, spi.session_id, spi.session_title_ar, spi.session_title_en,
          spi.room_name_ar, spi.room_name_en, spi.start_time, spi.end_time, spi.is_mandatory,
          spi.speakers, spi.suitability_score, spi.explanation_summary, spi.gap_reason, spi.item_status,
          s.id as live_session_id, s.title_ar as live_title_ar, s.title_en as live_title_en,
          r.name_ar as live_room_name_ar, r.name_en as live_room_name_en,
          s.start_time as live_start_time, s.end_time as live_end_time,
          s.is_mandatory as live_is_mandatory
        from schedule_publication_items spi
        left join sessions s on s.id = spi.session_id
        left join rooms r on r.id = s.room_id
        where spi.schedule_publication_id = v_prior_publication_id
      loop
        if v_session.session_id is not null and v_session.session_id = any(v_session_ids) then
          select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp2.role))
          into v_speakers
          from session_people sp2 join people p on p.id = sp2.person_id
          where sp2.session_id = v_session.session_id;

          insert into schedule_publication_items (
            schedule_publication_id, session_id, session_title_ar, session_title_en,
            room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
            suitability_score, explanation_summary, item_status
          ) values (
            v_new_publication_id, v_session.session_id, v_session.live_title_ar, v_session.live_title_en,
            v_session.live_room_name_ar, v_session.live_room_name_en,
            v_session.live_start_time, v_session.live_end_time, v_session.live_is_mandatory,
            coalesce(v_speakers, '[]'::jsonb), v_session.suitability_score, v_session.explanation_summary,
            v_session.item_status
          );
        else
          insert into schedule_publication_items (
            schedule_publication_id, session_id, session_title_ar, session_title_en,
            room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
            suitability_score, explanation_summary, gap_reason, item_status
          ) values (
            v_new_publication_id, v_session.session_id, v_session.session_title_ar, v_session.session_title_en,
            v_session.room_name_ar, v_session.room_name_en,
            v_session.start_time, v_session.end_time, v_session.is_mandatory,
            v_session.speakers, v_session.suitability_score, v_session.explanation_summary,
            v_session.gap_reason, v_session.item_status
          );
        end if;
      end loop;
    end if;
  end loop;

  update schedule_publication_drafts set status = 'confirmed' where id = p_draft_id;
  select * into v_draft from schedule_publication_drafts where id = p_draft_id;
  return v_draft;
end;
$$ language plpgsql set search_path = public, pg_temp;
