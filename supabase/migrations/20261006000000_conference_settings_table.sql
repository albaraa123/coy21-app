-- 20261006000000_conference_settings_table.sql
--
-- Singleton settings table for a platform-wide booking-closing deadline,
-- modeled directly on email_settings (20260930010000_add_email_settings_table.sql)
-- -- same id boolean primary key default true + check(id=true) pattern,
-- same RLS shape (staff read, super_admin write). See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 5.

create table conference_settings (
  id boolean primary key default true,
  constraint conference_settings_singleton check (id = true),
  global_booking_deadline timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

insert into conference_settings (id) values (true);

alter table conference_settings enable row level security;

create policy "staff can read conference settings"
  on conference_settings for select
  using (is_staff());

create policy "only super_admin can update conference settings"
  on conference_settings for update
  using (current_user_role() = 'super_admin')
  with check (current_user_role() = 'super_admin');

-- no insert/delete policy: seeded singleton row, never created or
-- removed by the app after this migration runs.
