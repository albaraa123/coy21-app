-- 20261102030000_bulk_confirm_all_draft_sessions.sql
--
-- Explicit user request: confirm all 112 real agenda sessions at once,
-- via direct SQL, bypassing the one-click-per-session admin UI flow
-- (status-control.tsx) since clicking through 112 sessions individually
-- was impractical. The DB trigger enforce_session_status_transition
-- (20261101060000_allow_session_status_one_step_back.sql) only permits
-- ONE step at a time (draft -> published -> confirmed, no direct
-- draft -> confirmed jump), so this does it in two UPDATE statements,
-- each one step, inside the same transaction -- the trigger fires on
-- each row for each statement exactly as it would for any other UPDATE,
-- no bypass of the state machine itself, just skipping the UI's one-
-- session-at-a-time pacing.
--
-- Scope: every session currently in 'draft' (expected: all 112, the
-- entire real agenda -- see the pre-check below). published_at/
-- confirmed_at are set to the same transaction timestamp for every row,
-- matching what updateSessionStatus (actions.ts) itself sets on a real
-- transition, just backdated to "now" for all of them at once since
-- this is a one-time bulk catch-up, not 112 separate real approval
-- moments. updated_by is left null (not attributed to any staff
-- profile) -- this is an explicit bulk administrative action run
-- directly against the database, not a click from any specific staff
-- account, and setting it to a fabricated actor would misrepresent the
-- audit trail.
--
-- cancellation_reason is irrelevant here (only checked when transitioning
-- TO 'cancelled', never on these transitions) and is left untouched.
begin;

do $$
declare
  v_draft_count int;
  v_total_count int;
begin
  select count(*) into v_draft_count from sessions where status = 'draft';
  select count(*) into v_total_count from sessions;
  if v_draft_count <> 112 or v_total_count <> 112 then
    raise exception 'Expected exactly 112 sessions, all in draft status. Found % draft out of % total -- data has changed since this migration was written, aborting rather than guessing.', v_draft_count, v_total_count;
  end if;
end $$;

-- Step 1: draft -> published (fires enforce_session_status_transition
-- for every row; old.status = 'draft' -> new.status = 'published' is
-- explicitly allowed).
update sessions
set status = 'published', published_at = now()
where status = 'draft';

-- Step 2: published -> confirmed (same trigger, published -> confirmed
-- explicitly allowed). Runs against what step 1 just produced, in the
-- same transaction.
update sessions
set status = 'confirmed', confirmed_at = now()
where status = 'published';

-- Post-check: every session must now be confirmed, none left behind in
-- an intermediate state (would only happen if the trigger itself
-- rejected a row for some reason not anticipated by the pre-check
-- above) -- fail loudly and roll back rather than leave a silent partial
-- result.
do $$
declare
  v_confirmed_count int;
begin
  select count(*) into v_confirmed_count from sessions where status = 'confirmed';
  if v_confirmed_count <> 112 then
    raise exception 'Expected all 112 sessions to be confirmed after both updates, found % -- rolling back.', v_confirmed_count;
  end if;
end $$;

commit;
