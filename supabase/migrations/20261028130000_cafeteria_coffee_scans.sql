-- supabase/migrations/20261028130000_cafeteria_coffee_scans.sql
--
-- Phase 2 of the cafeteria QR feature (coffee-break credit — see
-- docs/superpowers/specs/2026-10-28-cafeteria-coffee-break-credit-design.md).
-- No new credential/QR type: reuses cafeteria_credentials exactly as
-- Phase 1 issues it. This table is parallel to cafeteria_lunch_scans
-- (same credential_id FK shape, same scan_date convention, same
-- RLS posture), but tracks a per-day, non-accumulating 50 TL credit
-- deducted in operator-entered amounts rather than a simple once-per-day
-- admit/deny.
--
-- Remaining balance is never stored as a column -- it's derived live as
-- 50 - sum(amount_deducted) for result='deducted' rows on the current
-- scan_date, computed inside the RPCs in the next migration. This
-- avoids any stored-balance/actual-deductions divergence risk, matching
-- this codebase's existing preference (see cafeteria_lunch_scans) for
-- deriving state from an append-only scan log.
create table cafeteria_coffee_scans (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references cafeteria_credentials(id) on delete cascade,
  scanned_by uuid references profiles(id) on delete set null,
  scanned_at timestamptz not null default now(),
  scan_date date not null, -- Europe/Istanbul calendar date, server-computed, never client-supplied -- identical convention to cafeteria_lunch_scans.scan_date
  amount_deducted numeric(10,2),
  result text not null check (result in ('deducted', 'insufficient_balance', 'ineligible', 'invalid_qr')),
  constraint cafeteria_coffee_scans_amount_only_when_deducted check (
    (result = 'deducted' and amount_deducted is not null and amount_deducted > 0) or
    (result <> 'deducted' and amount_deducted is null)
  )
);

create index cafeteria_coffee_scans_credential_date_idx
  on cafeteria_coffee_scans (credential_id, scan_date)
  where result = 'deducted';

alter table cafeteria_coffee_scans enable row level security;
-- No client-facing policy at all -- identical posture to
-- cafeteria_lunch_scans: written exclusively by the RPCs in the next
-- migration (service-role, which already has full privileges via the
-- existing alter default privileges rule -- see that migration's own
-- comment for the confirmed reasoning, unchanged here), read by nothing
-- in this phase.
revoke all on cafeteria_coffee_scans from authenticated, anon;

-- No explicit service_role grant needed here, same reasoning already
-- verified for cafeteria_lunch_scans and every table since
-- 20261006080000_fix_missing_service_role_grants.sql.
