-- 20261102010000_add_waitlist_position_rpc.sql
--
-- Real participant-facing UX gap: a waitlisted participant sees only
-- "On waitlist" with no sense of queue position or how many people are
-- ahead of them -- "am I wasting my time?" has no answer in the UI
-- today. session_waitlist_select_own (20261005020000) only lets a
-- participant SELECT their own row, by design, so computing position
-- (which requires counting OTHER participants' rows on the same
-- session) needs a SECURITY DEFINER function -- a participant still
-- can't read anyone else's row directly, only this narrow 1-vs-N count.
--
-- Returns, for one (application_id, session_id) waiting entry:
--   position      -- 1-based: how many entries (including this one) have
--                    joined_at <= this one's, oldest first (matches the
--                    FIFO promotion order promote_next_waitlist_candidate
--                    already uses, per the session_waitlist_session_fifo_idx
--                    comment in the table's own migration)
--   total_waiting -- how many are on the waitlist for this session total
-- Returns no rows if the caller has no 'waiting' entry for that session
-- (already promoted, withdrawn, or never joined) -- the caller should
-- treat an empty result as "nothing to show", not an error.
create or replace function get_waitlist_position(p_application_id uuid, p_session_id uuid)
returns table ("position" int, total_waiting int)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_joined_at timestamptz;
  v_id uuid;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select joined_at, id into v_joined_at, v_id
  from session_waitlist
  where application_id = p_application_id
    and session_id = p_session_id
    and status = 'waiting';

  if v_joined_at is null then
    return;
  end if;

  -- (joined_at, id) as the tiebreak, not joined_at alone: two rows can
  -- share the same microsecond-precision timestamp under concurrent
  -- join_waitlist calls, and joined_at <= v_joined_at alone would let
  -- both such rows count each other as "ahead", inflating both
  -- positions. id is immutable and unique, making this a true total
  -- order with no ties. Note: promote_next_waitlist_candidate's own FIFO
  -- scan (`order by joined_at asc`, no secondary key -- see
  -- 20261031210000) has no equivalent tiebreak, so on the
  -- vanishingly-rare exact-timestamp tie this position number could in
  -- theory disagree with actual promotion order by one slot; not fixed
  -- here since it's a pre-existing property of the promotion function
  -- itself, out of scope for this read-only display helper.
  return query
  select
    (select count(*)::int from session_waitlist
     where session_id = p_session_id and status = 'waiting'
       and (joined_at, id) <= (v_joined_at, v_id)),
    (select count(*)::int from session_waitlist
     where session_id = p_session_id and status = 'waiting');
end;
$$;

grant execute on function get_waitlist_position(uuid, uuid) to authenticated;
