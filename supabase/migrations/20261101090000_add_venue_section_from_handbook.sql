-- 20261101090000_add_venue_section_from_handbook.sql
--
-- Adds a new "Venue" local_info_section from the official COY21
-- Delegates Handbook (sections 2.1 "When and Where", 2.3 "Registration
-- & Accreditation", 5.1 "Host Venue", 5.2 "Venue Overview") -- none of
-- this (address, opening times, what to bring to registration) existed
-- anywhere in local_info before this migration. Placed after Transport
-- (sort_order 4) in the existing Emergency Numbers / Key Contacts /
-- Transport sequence.
--
-- Deliberately excludes the Meals & Catering Schedule (handbook section
-- 6.1): the per-day lunch time table did not extract cleanly from the
-- PDF and the day-to-time mapping could not be confirmed -- left for a
-- separate pass once that's verified directly against the handbook,
-- rather than guessing at a schedule delegates would actually rely on.
begin;

do $$
declare
  v_existing_id uuid;
begin
  select id into v_existing_id from local_info_sections where title = 'Venue';
  if v_existing_id is not null then
    raise exception 'A local_info_sections row titled ''Venue'' already exists (id %) -- aborting rather than creating a duplicate.', v_existing_id;
  end if;
end $$;

insert into local_info_sections (title, sort_order, is_active)
values ('Venue', 4, true);

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Address', 'Akdeniz Universitesi, Dumlupinar Bulvari, 07058 Kampus, Konyaalti, Antalya', 10
from local_info_sections where title = 'Venue';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Gates Open — Thu 5 Nov', '8:00 AM', 20
from local_info_sections where title = 'Venue';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Gates Open — Fri 6 Nov', '8:30 AM', 30
from local_info_sections where title = 'Venue';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Gates Open — Sat 7 Nov', '9:00 AM', 40
from local_info_sections where title = 'Venue';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'What to Bring to Registration', 'A valid passport or photo ID matching your registration, and your registration confirmation email (printed or on your phone). Under 18: bring a signed parent/guardian consent form.', 50
from local_info_sections where title = 'Venue';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Badge Rules', 'Wear it visibly at all times inside the venue. It is personal — cannot be shared or lent. Lost badge? Report immediately to the Information Desk.', 60
from local_info_sections where title = 'Venue';

commit;
