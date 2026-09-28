-- sessions_table.sql
create extension if not exists btree_gist;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null unique,
  title_ar text not null,
  title_en text not null,
  description_ar text,
  description_en text,
  conference_day_id uuid not null references conference_days(id),
  start_time timestamptz not null,
  end_time timestamptz not null,
  track_id uuid not null references tracks(id),
  session_type_id uuid not null references session_types(id),
  room_id uuid not null references rooms(id),
  language session_language not null,
  difficulty_level session_difficulty not null,
  capacity int not null,
  min_capacity int not null default 0,
  is_mandatory boolean not null default false,
  is_public boolean not null default true,
  include_in_allocation boolean not null default true,
  allocation_priority int not null default 0,
  enable_qr_checkin boolean not null default false,
  checkin_opens_at timestamptz,
  checkin_closes_at timestamptz,
  status session_status not null default 'draft',
  internal_notes text,
  published_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint sessions_end_after_start check (end_time > start_time),
  constraint sessions_capacity_positive check (capacity > 0),
  constraint sessions_min_capacity_valid check (min_capacity >= 0 and min_capacity <= capacity),
  constraint sessions_checkin_window_order check (
    checkin_opens_at is null or checkin_closes_at is null or checkin_opens_at < checkin_closes_at
  ),
  constraint sessions_checkin_window_required check (
    enable_qr_checkin = false or (checkin_opens_at is not null and checkin_closes_at is not null)
  )
);

create trigger sessions_set_updated_at before update on sessions for each row execute function extensions.moddatetime('updated_at');

-- Room double-booking: draft/published/confirmed sessions block the room;
-- cancelled/completed do not. '[)' matches the design spec's explicit
-- half-open interval choice (a session ending exactly when another starts
-- is not a conflict).
alter table sessions add constraint sessions_room_no_overlap
  exclude using gist (
    room_id with =,
    tstzrange(start_time, end_time, '[)') with &&
  ) where (status in ('draft', 'published', 'confirmed'));

create index sessions_conference_day_idx on sessions (conference_day_id);
create index sessions_track_idx on sessions (track_id);
create index sessions_session_type_idx on sessions (session_type_id);
create index sessions_room_idx on sessions (room_id);
create index sessions_status_day_idx on sessions (status, conference_day_id);
create index sessions_status_track_idx on sessions (status, track_id);
create index sessions_room_start_idx on sessions (room_id, start_time);
