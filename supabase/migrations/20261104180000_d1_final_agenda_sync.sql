-- Syncs Day 1 (D1) sessions with the final confirmed agenda.
--
-- Scope, per explicit user instruction:
--   1. 8 sessions -> status = 'cancelled' (confirmed zero bookings before
--      this migration was written; see the D1-compare check run earlier
--      in the session).
--   2. D1-38 "Pacific Youth Intersectional Justice Work: In the Time of
--      Ecocide" does not exist yet -> inserted as status = 'draft'.
--   3. D1-15 and D1-30 ("UNFCCC Reform: Why It Matters Now" and "From
--      Seed to Cycle: Ecological Production and Sustainability
--      Workshop") moved to D2 in the real agenda -> hard-deleted from D1
--      per explicit user instruction ("احذفهم"), confirmed zero bookings
--      before this migration was written.
--   4. The other 26 D1 sessions already match the final agenda exactly
--      (start_time, end_time, room, session_type, track all compared
--      programmatically against the live DB before writing this
--      migration) -- no UPDATE needed for them, so none is issued here.
--
-- Idempotent: cancelling an already-cancelled row is a no-op update: it
-- unconditionally re-sets the same values, so a UPDATE ... WHERE
-- session_code = X AND status <> 'cancelled' guard makes a re-run touch
-- zero rows the second time. The insert uses a NOT EXISTS guard so a
-- re-run never double-inserts D1-38. The delete targets specific
-- session_codes and is naturally idempotent (a second run deletes zero
-- rows once they're gone).
begin;

do $$
begin
  if not exists (select 1 from rooms where code = 'R01') then
    raise exception 'Expected room R01 not found — refusing to proceed on an unexpected schema/data state';
  end if;
  if not exists (select 1 from session_types where code = 'SDE') then
    raise exception 'Expected session_type SDE not found — refusing to proceed on an unexpected schema/data state';
  end if;
  if not exists (select 1 from tracks where name_en = 'Side Event') then
    raise exception 'Expected track "Side Event" not found — refusing to proceed on an unexpected schema/data state';
  end if;
end $$;

-- 1. Cancel the 8 confirmed-removed sessions.
update sessions
set status = 'cancelled',
    cancelled_at = now(),
    cancellation_reason = 'Removed from the final confirmed D1 agenda',
    updated_at = now()
where session_code in ('D1-10', 'D1-11', 'D1-12', 'D1-20', 'D1-22', 'D1-23', 'D1-25', 'D1-32')
  and status <> 'cancelled';

-- 2. Insert D1-38 as draft, only if it doesn't already exist.
insert into sessions (
  session_code, title_en, title_ar, description_en, description_ar,
  start_time, end_time, conference_day_id, room_id, session_type_id, track_id,
  status, language, difficulty_level, capacity, min_capacity,
  is_mandatory, is_public, admission_policy, enable_qr_checkin, include_in_allocation
)
select
  'D1-38',
  'Pacific Youth Intersectional Justice Work: In the Time of Ecocide',
  'عمل الشباب في المحيط الهادئ من أجل العدالة التقاطعية: في زمن الإبادة البيئية',
  'Hosted by: Alliance for Future Generations Fiji',
  'تنظيم: Alliance for Future Generations Fiji',
  '2026-11-05T11:00:00+00:00', -- 14:00 Istanbul (+03)
  '2026-11-05T11:45:00+00:00', -- 14:45 Istanbul (+03)
  (select conference_day_id from sessions where session_code = 'D1-01' limit 1),
  (select id from rooms where code = 'R01'),
  (select id from session_types where code = 'SDE'),
  (select id from tracks where name_en = 'Side Event'),
  'draft',
  'en',
  'all_levels',
  (select capacity from rooms where code = 'R01'),
  0,
  false,
  true,
  'open',
  false,
  true
where not exists (select 1 from sessions where session_code = 'D1-38');

-- 3. Hard-delete the two sessions that moved to D2.
delete from sessions
where session_code in ('D1-15', 'D1-30');

commit;
