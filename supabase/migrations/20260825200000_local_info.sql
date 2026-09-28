-- local_info: editable sections, items, and images for the Local Info Hub.
-- Managed by super_admin and participants_communications_manager via the admin UI.
-- Read by authenticated participants via RLS.

create table local_info_sections (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table local_info_items (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references local_info_sections(id) on delete cascade,
  label       text not null,
  value       text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create table local_info_images (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid references local_info_sections(id) on delete set null,
  caption     text,
  storage_url text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create index on local_info_items(section_id);
create index on local_info_images(section_id);

-- RLS
alter table local_info_sections enable row level security;
alter table local_info_items    enable row level security;
alter table local_info_images   enable row level security;

-- Participants can read active sections/items/images
create policy "participants read active sections"
  on local_info_sections for select
  using (is_active = true and auth.uid() is not null);

create policy "participants read items"
  on local_info_items for select
  using (auth.uid() is not null);

create policy "participants read images"
  on local_info_images for select
  using (auth.uid() is not null);

-- Admins (communications + super_admin) have full access
create policy "admin full access sections"
  on local_info_sections for all
  using (current_user_role() in ('super_admin', 'participants_communications_manager'))
  with check (current_user_role() in ('super_admin', 'participants_communications_manager'));

create policy "admin full access items"
  on local_info_items for all
  using (current_user_role() in ('super_admin', 'participants_communications_manager'))
  with check (current_user_role() in ('super_admin', 'participants_communications_manager'));

create policy "admin full access images"
  on local_info_images for all
  using (current_user_role() in ('super_admin', 'participants_communications_manager'))
  with check (current_user_role() in ('super_admin', 'participants_communications_manager'));

grant select, insert, update, delete on local_info_sections to authenticated;
grant select, insert, update, delete on local_info_items    to authenticated;
grant select, insert, update, delete on local_info_images   to authenticated;

-- Seed with the current hardcoded data so existing content isn't lost
insert into local_info_sections (title, sort_order) values
  ('Emergency Numbers', 1),
  ('Key Contacts',      2),
  ('Transport',         3),
  ('Safety & Health',   4);

insert into local_info_items (section_id, label, value, sort_order)
select s.id, v.label, v.value, v.sort_order
from local_info_sections s
join (values
  ('Emergency Numbers', 'Police',               '155',                                        1),
  ('Emergency Numbers', 'Ambulance',            '112',                                        2),
  ('Emergency Numbers', 'Fire',                 '110',                                        3),
  ('Emergency Numbers', 'COY21 Emergency Line', 'TBC by Organising Team',                    4),
  ('Key Contacts',      'Registration Desk',    'Main Entrance — opens 08:00 daily',          1),
  ('Key Contacts',      'Info Desk',            'Lobby Level 1',                              2),
  ('Key Contacts',      'Medical Point',        'Near Cafeteria, Ground Floor',               3),
  ('Key Contacts',      'Lost & Found',         'Security Desk, Main Entrance',               4),
  ('Transport',         'Shuttle to venue',     'Departs every 30 min from hotel lobby',      1),
  ('Transport',         'Taxi app',             'BiTaksi (local) / Uber available',           2),
  ('Transport',         'Airport code',         'AYT — Antalya International Airport',        3),
  ('Safety & Health',   'Water',                'Tap water not recommended — use bottled',    1),
  ('Safety & Health',   'Currency',             'Turkish Lira (TRY). ATMs widely available.', 2),
  ('Safety & Health',   'Prayer times',         'Prayer room available — ask at Info Desk',   3)
) as v(section_title, label, value, sort_order) on s.title = v.section_title;
