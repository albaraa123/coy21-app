-- 20261101070000_fix_emergency_contacts_from_handbook.sql
--
-- Corrects the "Emergency Numbers" local_info_section content to match
-- the real, official COY21 Delegates Handbook (section 2.4 "Emergency
-- Contacts"), which this content predates and disagrees with:
--
-- 1. The handbook states 112 is the single number to call for ANY
--    emergency in Turkiye (police, ambulance, fire -- "free, 24 hours,
--    works from any phone"). The existing rows instead split this into
--    three separate Turkish numbers (Police 155, Ambulance 112, Fire
--    110) with no mention that 112 alone covers all three. Replaced
--    with one row matching the handbook's own guidance exactly.
--
-- 2. The existing "COY21 Emergency Line" row named a safeguarding
--    contact (Ayan Valizada, +994997368333) that does not appear
--    anywhere in the handbook at all -- a different person entirely.
--    The handbook's real emergency contacts are Nibras (+1 647 624
--    8404, international delegates) and Alia Sherif (+90 535 795 2072,
--    local delegates). Both added as their own rows; the old row is
--    deleted, not just relabeled, since the old number cannot be
--    confirmed against the handbook and should not stay live pointing
--    at an unconfirmed contact for a safety-critical use case.
begin;

-- Safety guard: abort if the section this migration targets doesn't
-- exist or doesn't look like what this migration expects (defends
-- against running this against a database that has already diverged).
do $$
declare
  v_section_id uuid;
  v_item_count int;
begin
  select id into v_section_id from local_info_sections where title = 'Emergency Numbers';
  if v_section_id is null then
    raise exception 'Expected a local_info_sections row titled ''Emergency Numbers'' -- none found, aborting';
  end if;

  select count(*) into v_item_count from local_info_items where section_id = v_section_id;
  if v_item_count <> 4 then
    raise exception 'Expected exactly 4 existing items under Emergency Numbers, found %. Data has likely already changed -- aborting rather than guessing.', v_item_count;
  end if;
end $$;

delete from local_info_items
where section_id = (select id from local_info_sections where title = 'Emergency Numbers');

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Emergency (Police / Ambulance / Fire)', '112 — free, 24 hours, from any phone', 10
from local_info_sections where title = 'Emergency Numbers';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'COY21 Emergency Contact — International Delegates', 'Nibras — tel:+16476248404', 20
from local_info_sections where title = 'Emergency Numbers';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'COY21 Emergency Contact — Local Delegates', 'Alia Sherif — tel:+905357952072', 30
from local_info_sections where title = 'Emergency Numbers';

commit;
