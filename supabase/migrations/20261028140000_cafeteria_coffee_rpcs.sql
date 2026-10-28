-- supabase/migrations/20261028140000_cafeteria_coffee_rpcs.sql
--
-- Two RPCs for the coffee-break credit flow (design spec:
-- 2026-10-28-cafeteria-coffee-break-credit-design.md's "Scan Flow — Two
-- RPCs, Not One" section). A single combined RPC can't support the
-- required UX (show remaining balance BEFORE the operator enters an
-- amount), so this is a read-only balance check followed by a separate,
-- locked deduction.
--
-- NULL-safety: both functions declare v_eligible with a `:= false`
-- default and gate on `coalesce(v_eligible, false) = false` -- never a
-- bare `if not v_eligible` -- mirroring cafeteria_lunch_scan_transactional's
-- fix for a real NULL-bypass bug found during Phase 1 (three-valued
-- logic: `not NULL` evaluates to NULL, not true, silently skipping a
-- rejection branch). This feature's eligibility expression (lunch-
-- eligible-equivalent OR speaker-branch) is an OR of two independently-
-- nullable sub-expressions, structurally MORE exposed to a stray NULL
-- than the lunch RPC's simpler if/else -- making this more necessary
-- here, not less.

-- 1. Read-only balance check. Writes nothing -- a device re-scanning the
--    same code twice while an operator decides on an amount never
--    double-counts or creates a spurious audit row.
create or replace function cafeteria_coffee_check_balance(
  p_token_hash bytea
) returns table (eligible boolean, remaining_balance numeric)
language plpgsql
as $$
declare
  v_credential cafeteria_credentials%rowtype;
  v_scan_date date;
  v_eligible boolean := false;
  v_participant_type text;
  v_app_status text;
  v_attendance_confirmation text;
  v_profile_role text;
  v_deducted_today numeric;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'cafeteria_coffee_check_balance called with a malformed token_hash -- caller must resolve the credential before calling this function';
  end if;

  select * into v_credential from cafeteria_credentials where token_hash = p_token_hash;
  if v_credential.id is null then
    raise exception 'cafeteria_coffee_check_balance called with a token_hash matching no credential -- caller must resolve the credential before calling this function';
  end if;

  v_scan_date := (now() at time zone 'Europe/Istanbul')::date;

  -- Live eligibility re-check -- isCoffeeEligible's logic, re-implemented
  -- in SQL (OR of lunch-eligible-equivalent and speaker-branch), never
  -- trusted from issuance time. Same application_id/profile_id branching
  -- as cafeteria_lunch_scan_transactional.
  if v_credential.application_id is not null then
    select participant_type, status, attendance_confirmation
      into v_participant_type, v_app_status, v_attendance_confirmation
      from applications where id = v_credential.application_id;
    v_eligible := (
      v_participant_type in ('delegate', 'volunteer')
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed'
    ) or (
      v_participant_type = 'speaker'
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed'
    );
  else
    select role into v_profile_role from profiles where id = v_credential.profile_id;
    v_eligible := v_profile_role in ('staff', 'super_admin');
  end if;

  if coalesce(v_eligible, false) = false then
    return query select false, 0::numeric;
    return;
  end if;

  select coalesce(sum(amount_deducted), 0) into v_deducted_today
    from cafeteria_coffee_scans
    where credential_id = v_credential.id and scan_date = v_scan_date and result = 'deducted';

  return query select true, (50 - v_deducted_today)::numeric;
end;
$$;

comment on function cafeteria_coffee_check_balance(bytea) is
  'Read-only eligibility + remaining-balance check for the coffee-break credit flow. Writes nothing. Re-checks eligibility live (not cached from issuance).';

revoke all on function cafeteria_coffee_check_balance(bytea) from public, anon, authenticated;

-- 2. The actual write -- locked deduction. Mirrors
--    cafeteria_lunch_scan_transactional's concurrency pattern exactly
--    (pg_try_advisory_xact_lock, bounded retry, same LOCK_CONTENTION:
--    exception shape), keyed per-credential.
create or replace function cafeteria_coffee_deduct_transactional(
  p_token_hash bytea,
  p_scanned_by uuid,
  p_amount numeric
) returns cafeteria_coffee_scans
language plpgsql
as $$
declare
  v_lock_key bigint;
  v_lock_acquired boolean := false;
  v_retry_count int := 0;
  v_max_retries constant int := 20;
  v_retry_delay_seconds constant numeric := 0.05;
  v_credential cafeteria_credentials%rowtype;
  v_scan_date date;
  v_eligible boolean := false;
  v_participant_type text;
  v_app_status text;
  v_attendance_confirmation text;
  v_profile_role text;
  v_deducted_today numeric;
  v_remaining numeric;
  v_result text;
  v_scan cafeteria_coffee_scans%rowtype;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'cafeteria_coffee_deduct_transactional called with a malformed token_hash -- caller must resolve the credential before calling this function';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'cafeteria_coffee_deduct_transactional called with a non-positive amount -- caller must validate the amount before calling this function';
  end if;

  select * into v_credential from cafeteria_credentials where token_hash = p_token_hash;
  if v_credential.id is null then
    raise exception 'cafeteria_coffee_deduct_transactional called with a token_hash matching no credential -- caller must resolve the credential before calling this function';
  end if;

  v_lock_key := hashtext('cafeteria-coffee:' || v_credential.id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'LOCK_CONTENTION: Another coffee-break deduction for this credential is still being processed after % retries — please retry manually', v_max_retries;
  end if;

  v_scan_date := (now() at time zone 'Europe/Istanbul')::date;

  -- Live eligibility re-check, inside the lock -- not trusting the
  -- balance-check call's earlier read, since time has passed and
  -- another device could have deducted in between.
  if v_credential.application_id is not null then
    select participant_type, status, attendance_confirmation
      into v_participant_type, v_app_status, v_attendance_confirmation
      from applications where id = v_credential.application_id;
    v_eligible := (
      v_participant_type in ('delegate', 'volunteer')
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed'
    ) or (
      v_participant_type = 'speaker'
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed'
    );
  else
    select role into v_profile_role from profiles where id = v_credential.profile_id;
    v_eligible := v_profile_role in ('staff', 'super_admin');
  end if;

  if coalesce(v_eligible, false) = false then
    insert into cafeteria_coffee_scans (credential_id, scanned_by, scan_date, result)
    values (v_credential.id, p_scanned_by, v_scan_date, 'ineligible')
    returning * into v_scan;
    return v_scan;
  end if;

  select coalesce(sum(amount_deducted), 0) into v_deducted_today
    from cafeteria_coffee_scans
    where credential_id = v_credential.id and scan_date = v_scan_date and result = 'deducted';
  v_remaining := 50 - v_deducted_today;

  if p_amount > v_remaining then
    insert into cafeteria_coffee_scans (credential_id, scanned_by, scan_date, result)
    values (v_credential.id, p_scanned_by, v_scan_date, 'insufficient_balance')
    returning * into v_scan;
    return v_scan;
  end if;

  insert into cafeteria_coffee_scans (credential_id, scanned_by, scan_date, amount_deducted, result)
  values (v_credential.id, p_scanned_by, v_scan_date, p_amount, 'deducted')
  returning * into v_scan;
  return v_scan;
end;
$$;

comment on function cafeteria_coffee_deduct_transactional(bytea, uuid, numeric) is
  'Sole write authority for cafeteria_coffee_scans. Re-checks eligibility and remaining balance live inside an advisory-locked transaction (retry-until-decided, matching cafeteria_lunch_scan_transactional), keyed per-credential. Rejects a deduction exceeding the remaining balance in full -- never partially honored.';

revoke all on function cafeteria_coffee_deduct_transactional(bytea, uuid, numeric) from public, anon, authenticated;

-- No explicit service_role grants needed for either function -- same
-- reasoning already verified for cafeteria_lunch_scan_transactional
-- (this migration postdates 20261006080000_fix_missing_service_role_grants.sql).
