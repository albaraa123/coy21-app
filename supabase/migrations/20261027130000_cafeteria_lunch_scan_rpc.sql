-- supabase/migrations/20261027130000_cafeteria_lunch_scan_rpc.sql
--
-- Scan RPC for the cafeteria lunch credential. Mirrors
-- scan_attempt_transactional's retry-until-decided concurrency pattern
-- (bounded retry loop around pg_try_advisory_xact_lock, ~1s worst case)
-- rather than confirm_publication_transactional's fail-fast pattern —
-- this feature's operator-facing "scan and get an answer" UX needs both
-- concurrent scanners to resolve with a real decision, never one
-- throwing. See design spec's "Concurrency semantics" section.
--
-- Eligibility is re-checked LIVE at scan time (not cached from
-- issuance) by re-reading applications/profiles inside this function —
-- a credential issued while eligible but since become ineligible (e.g.
-- an unconfirmed delegate) must scan as 'ineligible', not 'admitted'.
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
  v_eligible boolean;
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
    raise exception 'LOCK_CONTENTION: Another scan for this credential is still being processed after % retries', v_max_retries;
  end if;

  v_scan_date := (now() at time zone 'Europe/Istanbul')::date;

  -- Live eligibility re-check, inside the lock, re-reading current
  -- applications/profiles state -- never trusted from issuance time.
  if v_credential.application_id is not null then
    select participant_type, status, attendance_confirmation
      into v_participant_type, v_app_status, v_attendance_confirmation
      from applications where id = v_credential.application_id;
    v_eligible := v_participant_type in ('delegate', 'volunteer')
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed';
  else
    select role into v_profile_role from profiles where id = v_credential.profile_id;
    v_eligible := v_profile_role in ('staff', 'super_admin');
  end if;

  if not v_eligible then
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

comment on function cafeteria_lunch_scan_transactional(bytea, uuid) is
  'Sole write authority for cafeteria_lunch_scans. Re-checks eligibility live (not cached from issuance) and once-per-day usage inside an advisory-locked transaction (retry-until-decided, matching scan_attempt_transactional), keyed per-credential so concurrent scans of the SAME credential serialize but scans of DIFFERENT credentials never contend.';

revoke all on function cafeteria_lunch_scan_transactional(bytea, uuid) from public, anon, authenticated;

-- No explicit service_role grant needed here: this migration postdates
-- 20261006080000_fix_missing_service_role_grants.sql, whose
-- `alter default privileges in schema public grant execute on functions
-- to service_role` (distinct from, and in addition to, that same
-- migration's table/sequence default-privilege grants) already gives
-- service_role EXECUTE on this function from the moment it's created —
-- confirmed by reading that migration directly rather than assuming it
-- (per this project's Task 1 precedent: an explicit `grant` here would be
-- a redundant no-op, exactly like the table grants Task 1's review found
-- and removed). The `revoke all ... from public, anon, authenticated`
-- above is still required and not redundant: Postgres grants EXECUTE to
-- PUBLIC by default on function creation, and that default is untouched
-- by the service_role default-privilege rule.
