-- supabase/migrations/20261027120000_cafeteria_lunch_qr.sql
--
-- Phase 1 of the cafeteria QR feature (lunch eligibility only — see
-- docs/superpowers/specs/2026-10-27-cafeteria-lunch-qr-design.md).
-- Deliberately independent of qr_credentials/qr_lifecycle_operations/
-- qr_bulk_operation_batches: that system is append-only (DELETE
-- unconditionally blocked by qr_credentials_enforce_lifecycle_trigger)
-- and envelope-encrypted for a much higher-stakes problem (admission
-- credential forgery). Lunch risk is "a stolen free lunch," not identity
-- fraud, so this uses a simple hashed-random-token scheme instead.

create table cafeteria_credentials (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  profile_id uuid references profiles(id) on delete cascade,
  token_hash bytea not null check (octet_length(token_hash) = 32),
  -- The rendered PNG QR image, stored so the owner's page can redisplay
  -- their code on every later visit -- token_hash is a one-way hash, so
  -- the raw token/payload can't be re-derived from it. See the design
  -- spec's "Redisplay" section.
  qr_image_data_uri text not null,
  created_at timestamptz not null default now(),
  -- Exactly one of application_id/profile_id is set: a participant's
  -- credential is keyed to their application (consistent with
  -- qr_credentials' own application_id keying), a staff member's to
  -- their profile directly (staff have no applications row).
  --
  -- KNOWN EDGE CASE, accepted out of scope for Phase 1: this does not
  -- prevent one human from holding two credentials if they are
  -- simultaneously a staff/super_admin profile AND linked via
  -- applicant_id to an accepted+confirmed participant application
  -- (e.g. promoted to staff after applying). See the design spec's
  -- "Known edge case" paragraph. Not cross-checked at issuance time.
  constraint cafeteria_credentials_one_owner check (
    (application_id is not null and profile_id is null) or
    (application_id is null and profile_id is not null)
  ),
  constraint cafeteria_credentials_token_hash_unique unique (token_hash)
);

create unique index cafeteria_credentials_application_idx
  on cafeteria_credentials (application_id)
  where application_id is not null;
create unique index cafeteria_credentials_profile_idx
  on cafeteria_credentials (profile_id)
  where profile_id is not null;

alter table cafeteria_credentials enable row level security;

-- Owner can read their own credential (needed for the My QR Code page's
-- "do I already have one" check via the regular session client — mirrors
-- qr_credentials' own owner-read policy shape).
create policy cafeteria_credentials_select_own_application on cafeteria_credentials
  for select using (
    application_id is not null
    and application_id in (select id from applications where applicant_id = auth.uid())
  );
create policy cafeteria_credentials_select_own_profile on cafeteria_credentials
  for select using (profile_id = auth.uid());

-- No INSERT/UPDATE/DELETE policy for authenticated/anon: issuance is
-- exclusively a service-role operation (mirrors every other credential-
-- issuance path in this codebase — RLS is not the write gate here, the
-- server action's own auth check is).
revoke insert, update, delete on cafeteria_credentials from authenticated, anon;

create table cafeteria_lunch_scans (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references cafeteria_credentials(id) on delete cascade,
  scanned_by uuid references profiles(id) on delete set null,
  scanned_at timestamptz not null default now(),
  scan_date date not null, -- Europe/Istanbul calendar date at scan time, server-computed, never client-supplied
  result text not null check (result in ('admitted', 'already_used_today', 'ineligible', 'invalid_qr'))
);

-- The actual once-per-day enforcement: a real unique constraint, not
-- just application-level logic, so two near-simultaneous scans of the
-- same QR can't both succeed. Only 'admitted' rows count against it —
-- denials (ineligible/invalid_qr/already_used_today) are still logged
-- for audit purposes but never block a later legitimate admission.
create unique index cafeteria_lunch_scans_one_per_day on cafeteria_lunch_scans (credential_id, scan_date) where result = 'admitted';

alter table cafeteria_lunch_scans enable row level security;
-- No client-facing policy at all: written exclusively by the scan RPC
-- (service-role, which already has full privileges on this table via the
-- default ACL -- see the grants note below) and read by nothing in this
-- phase. Default-deny matches resend_webhook_events' existing precedent
-- for a table with no client-facing read/write need.

revoke all on cafeteria_lunch_scans from authenticated, anon;

-- No explicit service_role grant needed here: every table created after
-- 20261006080000_fix_missing_service_role_grants.sql (which this migration
-- postdates) already picks up full privileges on service_role via that
-- migration's `alter default privileges in schema public grant all on
-- tables to service_role`. Both tables above already have everything
-- (not just SELECT/INSERT) before this migration even runs.
