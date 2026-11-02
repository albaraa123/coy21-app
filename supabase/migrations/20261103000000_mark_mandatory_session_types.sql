begin;

-- Every session's is_mandatory came in false from the original agenda
-- population migration (20261101010000_add_full_conference_agenda_d1_d2_d3.sql).
-- Confirmed live: Registration (REG), Plenary (PLN), Break (BRK), and Culture
-- (CUL) sessions are mandatory for every participant -- only Side Event (SDE)
-- is a real elective choice. The participant-facing Browse page (My Agenda)
-- currently shows a "Book" button on every session regardless of type,
-- letting participants "skip" mandatory sessions like Registration and
-- Opening Plenary, which is wrong. This migration corrects the underlying
-- data; a follow-up code change hides the Book button for is_mandatory
-- sessions.
do $$
declare
  v_wrong_count int;
begin
  select count(*) into v_wrong_count
  from sessions s
  join session_types st on st.id = s.session_type_id
  where st.code in ('REG', 'PLN', 'BRK', 'CUL')
    and s.is_mandatory = true;

  if v_wrong_count <> 0 then
    raise exception 'Expected 0 sessions of type REG/PLN/BRK/CUL already marked mandatory, found %', v_wrong_count;
  end if;
end $$;

update sessions s
set is_mandatory = true
from session_types st
where st.id = s.session_type_id
  and st.code in ('REG', 'PLN', 'BRK', 'CUL');

do $$
declare
  v_mandatory_count int;
  v_elective_count int;
begin
  select count(*) into v_mandatory_count
  from sessions s
  join session_types st on st.id = s.session_type_id
  where st.code in ('REG', 'PLN', 'BRK', 'CUL')
    and s.is_mandatory = true;

  select count(*) into v_elective_count
  from sessions s
  join session_types st on st.id = s.session_type_id
  where st.code = 'SDE'
    and s.is_mandatory = false;

  if v_mandatory_count <> 23 then
    raise exception 'Expected 23 mandatory sessions (REG=1, PLN=10, BRK=11, CUL=1), got %', v_mandatory_count;
  end if;

  if v_elective_count <> 89 then
    raise exception 'Expected 89 elective SDE sessions unchanged, got %', v_elective_count;
  end if;
end $$;

commit;
