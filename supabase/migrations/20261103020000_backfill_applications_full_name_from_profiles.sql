begin;

-- One-time backfill, paired with the ongoing sync added to saveIdentity()
-- (my-profile/actions.ts): applications.full_name and profiles.full_name
-- have never been kept in sync -- a participant correcting their name on
-- My Profile (which writes profiles.full_name) never updated
-- applications.full_name, which QR display, admission lookup, funding,
-- travel ops, and notification emails all read directly. Going forward
-- saveIdentity() mirrors every save; this migration catches up every
-- EXISTING mismatch once, for every participant who already corrected
-- their name before this sync existed, not just the one tester account
-- that surfaced the bug.
--
-- Scope: only rows where applicant_id is set (a claimed account with a
-- real profiles row to copy from) AND the two names actually differ --
-- never touches a draft application with no claimed account yet, and
-- never writes a no-op update to rows that already match.
do $$
declare
  v_mismatch_count int;
begin
  select count(*) into v_mismatch_count
  from applications a
  join profiles p on p.id = a.applicant_id
  where a.applicant_id is not null
    and a.full_name is distinct from p.full_name;

  raise notice 'Backfilling % application(s) whose full_name differs from their profile', v_mismatch_count;
end $$;

update applications a
set full_name = p.full_name
from profiles p
where p.id = a.applicant_id
  and a.applicant_id is not null
  and a.full_name is distinct from p.full_name;

do $$
declare
  v_remaining_mismatch_count int;
begin
  select count(*) into v_remaining_mismatch_count
  from applications a
  join profiles p on p.id = a.applicant_id
  where a.applicant_id is not null
    and a.full_name is distinct from p.full_name;

  if v_remaining_mismatch_count <> 0 then
    raise exception 'Expected 0 remaining mismatches after backfill, found %', v_remaining_mismatch_count;
  end if;
end $$;

commit;
