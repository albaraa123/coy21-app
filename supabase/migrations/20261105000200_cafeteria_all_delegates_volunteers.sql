-- 20261105000200_cafeteria_all_delegates_volunteers.sql
--
-- Cafeteria eligibility widened: EVERY delegate and volunteer is eligible
-- (no longer requires application status = 'accepted' and attendance
-- confirmation = 'confirmed'); staff / super_admin unchanged; the speaker
-- coffee branch is unchanged. Mirrors src/lib/cafeteria/eligibility.ts.
-- Same signatures => atomic in-place create-or-replace; existing
-- revokes/grants are preserved.
create or replace function cafeteria_lunch_scan_transactional(
  p_token_hash bytea,
  p_scanned_by uuid
) returns cafeteria_lunch_scans
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
  -- Fail-closed default: if the eligibility branches below somehow leave
  -- this NULL (e.g. the one-owner CHECK constraint were ever bypassed
  -- AND profile_id were also null), `false` -- not NULL -- is what the
  -- gate below sees. Three-valued logic means `if not v_eligible` alone
  -- would silently skip the ineligible-rejection branch when v_eligible
  -- is NULL (same failure class as this codebase's known
  -- `if not is_staff()` NULL-bypass pattern), so this default is paired
  -- with the `coalesce(..., false)` in the gate itself -- either one
  -- alone leaves a path reachable if the other is edited away later.
  v_eligible boolean := false;
  v_already_today boolean;
  v_result text;
  v_scan cafeteria_lunch_scans%rowtype;
  v_participant_type text;
  v_app_status text;
  v_attendance_confirmation text;
  v_profile_role text;
begin
  -- credential_id on cafeteria_lunch_scans is NOT NULL, so this function
  -- has no row to write for a token that resolves to no credential at
  -- all -- the caller (src/lib/cafeteria/lunch-scan.ts) always resolves
  -- the credential BEFORE calling this RPC and returns 'invalid_qr'
  -- directly, without an RPC round-trip, for that case (see Task 4).
  -- These two guards are therefore purely defensive against a
  -- programming error in the caller, not a real operational path; a
  -- bare raise is correct here -- unlike
  -- scan_qr_attempt_transactional's own unresolved-credential branches,
  -- which CAN write a row because scan_attempts.application_id is
  -- nullable. Do not try to insert a row here: credential_id's NOT NULL
  -- constraint makes it impossible, and attempting it then raising would
  -- roll back the insert anyway, producing a misleading dead branch.
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'cafeteria_lunch_scan_transactional called with a malformed token_hash -- caller must resolve the credential before calling this function';
  end if;

  select * into v_credential from cafeteria_credentials where token_hash = p_token_hash;
  if v_credential.id is null then
    raise exception 'cafeteria_lunch_scan_transactional called with a token_hash matching no credential -- caller must resolve the credential before calling this function';
  end if;

  v_lock_key := hashtext('cafeteria:' || v_credential.id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'LOCK_CONTENTION: Another scan for this credential is still being processed after % retries — please retry manually', v_max_retries;
  end if;

  v_scan_date := (now() at time zone 'Europe/Istanbul')::date;

  -- Live eligibility re-check, inside the lock, re-reading current
  -- applications/profiles state -- never trusted from issuance time.
  if v_credential.application_id is not null then
    select participant_type, status, attendance_confirmation
      into v_participant_type, v_app_status, v_attendance_confirmation
      from applications where id = v_credential.application_id;
    v_eligible := v_participant_type in ('delegate', 'volunteer');
  else
    select role into v_profile_role from profiles where id = v_credential.profile_id;
    v_eligible := v_profile_role in ('staff', 'super_admin');
  end if;

  -- Fail closed on NULL, not just false: see v_eligible's declaration
  -- comment above.
  if coalesce(v_eligible, false) = false then
    insert into cafeteria_lunch_scans (credential_id, scanned_by, scan_date, result)
    values (v_credential.id, p_scanned_by, v_scan_date, 'ineligible')
    returning * into v_scan;
    return v_scan;
  end if;

  select exists(
    select 1 from cafeteria_lunch_scans
    where credential_id = v_credential.id and scan_date = v_scan_date and result = 'admitted'
  ) into v_already_today;

  v_result := case when v_already_today then 'already_used_today' else 'admitted' end;

  insert into cafeteria_lunch_scans (credential_id, scanned_by, scan_date, result)
  values (v_credential.id, p_scanned_by, v_scan_date, v_result)
  returning * into v_scan;

  return v_scan;
end;
$$;

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

