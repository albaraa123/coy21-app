-- 20261013000000_qr_credentials_rls_and_search_path_hardening.sql
--
-- Two small, independent defense-in-depth hardening fixes found during a
-- 2026-10-11 security audit, both confirmed directly against the live
-- production database (vfwcbkjvinbtcntwjrzq) before this migration was
-- written:
--
-- 1. public.qr_credentials had row level security DISABLED
--    (confirmed: `select relrowsecurity from pg_class where relname =
--    'qr_credentials'` returned false on the live database). Every
--    sibling lifecycle table created in the same original migration
--    (20260805235959_phase6_qr_issuance_reissue.sql) -- qr_encryption_key
--    _registry, qr_bulk_operation_batches, qr_lifecycle_operations --
--    got `enable row level security` + `revoke ... from anon,
--    authenticated`; qr_credentials alone was missed. Confirmed no
--    `anon`/`authenticated` grants currently exist on this table either
--    (checked information_schema.role_table_grants on the live
--    database), so this was not an active, exploitable gap today --
--    every real application code path reads/writes this table via a
--    service-role client (src/lib/attendance/participant-qr.ts,
--    qr-credential-issuance.ts, src/lib/participants/reclassify.ts,
--    the admin participant detail page), which bypasses RLS and is
--    unaffected by this table's own grants either way. This migration
--    closes the gap anyway, for the same reason the sibling tables have
--    it: so a future migration can never accidentally grant
--    anon/authenticated access to this table (which stores encrypted QR
--    token material, application_id linkage, and issuance/revocation/
--    replacement audit trail) without RLS independently blocking it.
--
-- 2. public.count_distinct_travellers() (20260823040000) is `language
--    sql ... security definer` with NO `set search_path` clause -- the
--    one SECURITY DEFINER function in the whole migration history
--    missing this project's otherwise-universal hardening pattern
--    (`set search_path = public, pg_temp`, used by ~100 other SECURITY
--    DEFINER functions here). A missing search_path on a SECURITY
--    DEFINER function is the classic Postgres search_path-hijacking
--    privilege-escalation vector: an attacker able to create an
--    object (e.g. a same-named `travel_legs` view/function) earlier in
--    an unqualified search_path could have it resolved instead of the
--    intended public.travel_legs table when the function runs with the
--    *definer's* privileges. Low real-world severity here since the
--    function is `revoke ... from public` / `grant ... to service_role`
--    only (no anon/authenticated caller can invoke it at all), but fixed
--    for consistency with the rest of this codebase's own standard.

alter table public.qr_credentials enable row level security;
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_credentials from anon, authenticated;

create or replace function count_distinct_travellers()
returns bigint
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select count(distinct tl.application_id)
  from travel_legs tl
  join applications a on a.id = tl.application_id
  where a.status = 'accepted';
$$;

-- create or replace preserves the existing grants below, but restated
-- explicitly here (byte-identical to 20260823040000) so this migration
-- is self-contained and doesn't rely on that assumption silently.
revoke execute on function count_distinct_travellers() from public;
grant execute on function count_distinct_travellers() to service_role;
