-- 20261101060000_allow_session_status_one_step_back.sql
--
-- Relaxes the sessions status transition trigger from pure forward-only
-- (draft -> published -> confirmed -> completed, cancel from anywhere
-- except completed) to allow stepping back exactly one stage:
-- published -> draft and confirmed -> published are now permitted, in
-- addition to everything the original trigger already allowed.
--
-- Reasoning: this conference's 112-session agenda will be confirmed in
-- batches as content firms up, not all at once -- the one-way-only rule
-- meant any premature "confirmed" click had no way back except cancelling
-- the session outright (a destructive, audited, terminal action) even
-- for a simple "actually, not ready yet" correction. One-step-back covers
-- that real workflow without opening the door to arbitrary jumps (e.g.
-- confirmed -> draft directly, or completed -> anything) that would make
-- the status field meaningless as a sequential approval record.
--
-- completed remains the one true terminal state in both directions: no
-- session that has actually happened can be un-completed or
-- re-completed. cancelled remains terminal exactly as before. Mirrors
-- src/lib/validation/agenda.ts's SESSION_VALID_TRANSITIONS exactly --
-- keep both in sync if this ever changes again.
create or replace function enforce_session_status_transition() returns trigger as $$
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
      if new.status not in ('draft', 'confirmed', 'cancelled') then
        raise exception 'Cannot transition session from published to %', new.status;
      end if;
    when 'confirmed' then
      if new.status not in ('published', 'completed', 'cancelled') then
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
