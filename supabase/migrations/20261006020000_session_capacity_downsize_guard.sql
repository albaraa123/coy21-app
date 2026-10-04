-- 20261006020000_session_capacity_downsize_guard.sql
--
-- Rejects reducing a session's capacity below its current booking +
-- allocation occupancy, mirroring revalidate_sessions_on_room_capacity_change's
-- exact reject-don't-cascade pattern
-- (20260723020000_sessions_triggers.sql, trigger #4). See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 6.
--
-- Concurrency: an ordinary UPDATE sessions SET capacity = ... takes the
-- same row-level lock on that session as book_session/join_waitlist/
-- admit_walk_in's own `select ... for update` -- a capacity-reducing
-- update and a concurrent new booking/allocation for the same session
-- can never interleave; whichever transaction commits first is fully
-- visible to the other's occupancy read. No explicit locking needed
-- here beyond what UPDATE already does intrinsically.

create function enforce_session_capacity_vs_bookings() returns trigger as $$
declare
  v_occupied int;
begin
  if new.capacity >= old.capacity then
    return new; -- only a reduction needs checking
  end if;
  v_occupied := session_effective_occupied_count(new.id);
  if new.capacity < v_occupied then
    raise exception 'Cannot reduce session capacity to %: % booking(s)/allocation(s) already occupy this session', new.capacity, v_occupied;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_capacity_vs_bookings
  before update of capacity on sessions
  for each row execute function enforce_session_capacity_vs_bookings();
