-- session_people_and_tags.sql
create table session_people (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  person_id uuid not null references people(id),
  role session_person_role not null,
  display_order int not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint session_people_unique_role unique (session_id, person_id, role)
);

create trigger session_people_set_updated_at before update on session_people for each row execute function extensions.moddatetime('updated_at');

create table session_tags (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  tag_id uuid not null references tags(id),
  weight numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint session_tags_unique unique (session_id, tag_id),
  constraint session_tags_weight_range check (weight >= 0 and weight <= 1)
);

create trigger session_tags_set_updated_at before update on session_tags for each row execute function extensions.moddatetime('updated_at');

create index session_people_session_idx on session_people (session_id);
create index session_people_person_idx on session_people (person_id);
-- Composite index for enforce_speaker_no_conflict's hot path (Task 7) — runs
-- on every session_people write, distinct from the plain person_id FK index.
create index session_people_person_session_idx on session_people (person_id, session_id);
create index session_tags_session_idx on session_tags (session_id);
create index session_tags_tag_idx on session_tags (tag_id);
