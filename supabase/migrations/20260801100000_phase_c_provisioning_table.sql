-- phase_c_provisioning_table.sql
--
-- Phase C of the controlled-account-provisioning design
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 14 -- the authoritative, approved design for this migration).
-- Adds the password-change gate flag on profiles and the durable,
-- resumable provisioning-state table for admin-controlled account
-- creation/linking/email delivery. Additive and non-destructive.

------------------------------------------------------------------
-- profiles.must_change_password -- the actual gate
-- (participant)/(shell)/layout.tsx reads. Never authenticated-writable
-- (the existing column-level grant on profiles, from
-- 20260727000000_fix_profiles_role_privilege_escalation.sql, grants
-- update only on full_name/email -- this column is deliberately excluded,
-- written only via service-role from the provisioning/password-change
-- server actions).
------------------------------------------------------------------
alter table profiles add column must_change_password boolean not null default false;

------------------------------------------------------------------
-- participant_account_provisioning -- one row per application, the
-- resumable state for bulk account creation/linking/email delivery.
-- must_change_password here is a denormalized mirror of profiles' own
-- column (kept in sync by always being written in the same server-action
-- call), existing only so the admin table's own display/filter queries
-- don't need to join auth.users or add cost to the participant-facing
-- layout's per-request read.
------------------------------------------------------------------
create type provisioning_account_status as enum (
  'no_account', 'account_created', 'password_change_required',
  'active', 'existing_account', 'creation_failed', 'conflict'
);
create type provisioning_email_status as enum ('not_sent', 'sending', 'sent', 'failed');

create table participant_account_provisioning (
  application_id uuid primary key references applications(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  normalized_email text not null,
  account_status provisioning_account_status not null default 'no_account',
  email_status provisioning_email_status not null default 'not_sent',
  must_change_password boolean not null default false,
  account_created_at timestamptz,
  last_login_email_sent_at timestamptz,
  login_email_send_count int not null default 0,
  provisioning_attempt_count int not null default 0,
  last_attempt_at timestamptz,
  -- Deliberately never a raw caught-error message and never a password --
  -- the provisioning action layer only ever writes one of a small fixed
  -- set of safe, human-readable strings here. See design doc section 14.2.
  last_error_code text,
  last_error_message text,
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index participant_account_provisioning_status_idx on participant_account_provisioning (account_status);
create index participant_account_provisioning_email_status_idx on participant_account_provisioning (email_status);

create trigger participant_account_provisioning_set_updated_at
  before update on participant_account_provisioning
  for each row execute function extensions.moddatetime('updated_at');

alter table participant_account_provisioning enable row level security;

create policy participant_account_provisioning_staff_all on participant_account_provisioning
  for all
  using (current_user_role() in ('registration_admission_manager', 'super_admin'))
  with check (current_user_role() in ('registration_admission_manager', 'super_admin'));

comment on table participant_account_provisioning is
  'Phase C durable, resumable state for admin-controlled participant '
  'account provisioning. One row per application. Never stores a password '
  '-- the approved temporary password (password@123) is a code-level '
  'constant, never persisted here or anywhere else. Access restricted to '
  'registration_admission_manager/super_admin only, matching this design''s '
  'approved authorization model (deliberately narrower than the sibling '
  'participants/imports pages, which gate on agenda staff).';
