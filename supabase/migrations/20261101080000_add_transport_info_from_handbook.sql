-- 20261101080000_add_transport_info_from_handbook.sql
--
-- Adds the most practically useful transport details from the official
-- COY21 Delegates Handbook (section 10.2 "Getting Around Antalya") to
-- the "Transport" local_info_section, which previously held only one
-- item (Taxi App / BiTaksi). Purely additive -- the existing BiTaksi row
-- is untouched, just re-ordered to sit after the new rows.
--
-- Scope: the handbook's transport chapter is much longer (city buses,
-- dolmus, walking/cycling, car rental, SIM cards, etc.) -- this adds only
-- what a delegate most needs to actually get from the airport/their
-- accommodation to the venue: the one tram line that serves the
-- university, how to pay for it, and airport transfer options. Further
-- handbook sections can be added in later passes if useful.
begin;

do $$
declare
  v_section_id uuid;
  v_item_count int;
begin
  select id into v_section_id from local_info_sections where title = 'Transport';
  if v_section_id is null then
    raise exception 'Expected a local_info_sections row titled ''Transport'' -- none found, aborting';
  end if;

  select count(*) into v_item_count from local_info_items where section_id = v_section_id;
  if v_item_count <> 1 then
    raise exception 'Expected exactly 1 existing item under Transport (Taxi App), found %. Data has likely already changed -- aborting rather than guessing.', v_item_count;
  end if;
end $$;

-- Re-number the existing Taxi App row to make room ahead of it (was 30,
-- now last in the new ordering).
update local_info_items
set sort_order = 50
where section_id = (select id from local_info_sections where title = 'Transport')
  and label = 'Taxi App';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Tram to Campus', 'T3 line (Muze to Varsak) stops at Akdeniz Universitesi. Runs roughly 05:30-23:50.', 10
from local_info_sections where title = 'Transport';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Transport Card', 'AntalyaKart — buy the standard (non-student) card, 100 TL, full-fare journey 42 TL. Cash is not accepted on trams/buses.', 20
from local_info_sections where title = 'Transport';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'From Antalya Airport (AYT)', 'T1A tram to the city centre is cheapest; HAVA coaches (~45 min) are good with heavy luggage; licensed taxis/BiTaksi also available. Allow 30-45 min to reach campus.', 30
from local_info_sections where title = 'Transport';

insert into local_info_items (section_id, label, value, sort_order)
select id, 'Live Routes', 'Google Maps and Moovit show live bus/tram routes in English.', 40
from local_info_sections where title = 'Transport';

commit;
