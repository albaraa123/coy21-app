-- 20260930010000_add_email_settings_table.sql
--
-- Singleton settings table for the email sandbox-mode feature. See
-- docs/superpowers/specs/2026-09-30-email-sandbox-mode-design.md for
-- full reasoning. `id boolean primary key default true` + the check
-- constraint is a standard Postgres pattern enforcing exactly one row —
-- any second insert attempt violates the primary key on `id = true`
-- (there is no other valid value per the check constraint).
create table email_settings (
  id boolean primary key default true,
  constraint email_settings_singleton check (id = true),
  sandbox_enabled boolean not null default true,
  sandbox_recipient_email text,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

insert into email_settings (id) values (true);

alter table email_settings enable row level security;

create policy "staff can read email settings"
  on email_settings for select
  using (is_staff());

create policy "only super_admin can update email settings"
  on email_settings for update
  using (current_user_role() = 'super_admin')
  with check (current_user_role() = 'super_admin');

-- no insert/delete policy: this is a seeded singleton row, never created
-- or removed by the app after this migration runs.
