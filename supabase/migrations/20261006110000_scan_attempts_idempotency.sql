-- Task 1 (offline-scanning-support): adds client-supplied idempotency-key
-- support to scan_attempt_transactional and scan_qr_attempt_transactional,
-- so a retried submission (e.g. after a lost response during a flaky
-- network) replays the original committed result instead of risking a
-- second attendance_records/scan_attempts write. See
-- docs/superpowers/specs/2026-10-06-offline-scanning-support-design.md and
-- docs/superpowers/plans/2026-10-06-offline-scanning-support.md Task 1.

alter table scan_attempts add column idempotency_key uuid;
alter table scan_attempts add column scan_fingerprint bytea;
create unique index scan_attempts_idempotency_key_unique on scan_attempts (idempotency_key) where idempotency_key is not null;

-- Drop the current 7-argument signature (added by 20260928000000, carried
-- forward unchanged in signature by 20261006050000) before creating the new
-- 9-argument version below -- a bare `create or replace` that changes the
-- argument count creates a SECOND overload rather than replacing this one,
-- which would leave this old signature callable too.
drop function if exists scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean, uuid);

-- Body copied verbatim from supabase/migrations/20261006050000_walk_in_admission.sql
-- lines 101-266 (the current, unmodified scan_attempt_transactional), with
-- exactly the changes described in the plan's Task 1 Step 1:
--   1. Two new trailing parameters: p_idempotency_key, p_token_hash.
--   2. Three new declare-block variables: v_scan_fingerprint, v_existing,
--      v_constraint.
--   3. A new idempotency pre-check block, inserted after the scanner-scope
--      re-check and before the application/session lookup.
--   4. The existing "not accepted / missing session" early-return insert
--      now also writes idempotency_key/scan_fingerprint.
--   5. The lock-contention exception message gains a distinguishable
--      'LOCK_CONTENTION: ' prefix.
--   6. The final admission-insert + scan_attempts-insert pair is wrapped in
--      one begin...exception when unique_violation block, handling both
--      the attendance_records no-duplicate-active collision (re-raise) and
--      the scan_attempts idempotency-key collision (replay-or-mismatch).
create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false,
  p_scanner_user_id uuid default null,
  p_idempotency_key uuid default null,
  p_token_hash bytea default null
) returns scan_attempts as $$
declare
  v_lock_key bigint;
  v_lock_acquired boolean := false;
  v_retry_count int := 0;
  v_max_retries constant int := 20;      -- ~1s total worst case at 50ms apart
  v_retry_delay_seconds constant numeric := 0.05;
  v_session sessions%rowtype;
  v_application_status text;
  v_total_admitted int;
  v_admitted_priority_count int;
  v_admitted_flexible_count int;
  v_has_this_session boolean;
  v_has_conflicting_session boolean;
  v_effective_priority_pool int;
  v_released boolean;
  v_flexible_pool int;
  v_result text;
  v_entry_type text;
  v_attendance_id uuid;
  v_scan_attempt scan_attempts%rowtype;
  v_scanner_scope_count int;
  v_matched_booking_id uuid;
  v_scan_fingerprint bytea;
  v_existing scan_attempts%rowtype;
  v_constraint text;
begin
  v_lock_key := hashtext(p_session_id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'LOCK_CONTENTION: Another scan for this session is still being processed after % retries — please retry manually', v_max_retries;
  end if;

  -- Re-verify scanner scope inside the lock, after any concurrent
  -- deactivation has had a chance to commit. Mirrors verifyScannerScope's
  -- own query (src/lib/attendance/scan-attempt.ts,
  -- src/lib/attendance/scan-qr-attempt.ts) exactly: an active
  -- scanner_assignments row scoped to either this session_id or this
  -- session's room_id.
  if p_scanner_user_id is not null then
    select count(*) into v_scanner_scope_count
    from scanner_assignments sa
    join sessions s on s.id = p_session_id
    where sa.scanner_user_id = p_scanner_user_id
      and sa.is_active = true
      and (sa.session_id = p_session_id or sa.room_id = s.room_id);

    if coalesce(v_scanner_scope_count, 0) = 0 then
      raise exception 'Not authorized for this session/room';
    end if;
  end if;

  -- application_id is folded in (not just token_hash + session_id) because
  -- this function is also called directly with p_token_hash = null from the
  -- non-QR scanner-confirm and override-admit paths (scan-attempt.ts,
  -- admission-management.ts), where application_id is the only thing that
  -- actually varies between two different applicants scanned in the same
  -- session — without it, a key reused across two applicants would hash
  -- identically and the second call would silently replay the first
  -- applicant's row instead of raising the mismatch error below.
  v_scan_fingerprint := extensions.digest(coalesce(p_token_hash, ''::bytea) || uuid_send(p_session_id) || uuid_send(p_application_id), 'sha256');

  if p_idempotency_key is not null then
    select * into v_existing from scan_attempts where idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      if v_existing.scan_fingerprint is not distinct from v_scan_fingerprint and v_existing.session_id = p_session_id then
        return v_existing;
      else
        raise exception 'Idempotency key reused with different scan data';
      end if;
    end if;
  end if;

  select status into v_application_status from applications where id = p_application_id;
  select * into v_session from sessions where id = p_session_id;

  if v_application_status is null or v_application_status <> 'accepted' or v_session.id is null then
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at, idempotency_key, scan_fingerprint)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now(), p_idempotency_key, v_scan_fingerprint)
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  select exists(
    select 1 from attendance_records
    where application_id = p_application_id and session_id = p_session_id and status = 'admitted'
  ) into v_has_this_session;

  select exists(
    select 1 from attendance_records
    where application_id = p_application_id and time_slot_group_key = p_time_slot_group_key
      and session_id <> p_session_id and status = 'admitted'
  ) into v_has_conflicting_session;

  select count(*) filter (where status = 'admitted') into v_total_admitted from attendance_records where session_id = p_session_id;
  select count(*) filter (where status = 'admitted' and entry_type = 'priority') into v_admitted_priority_count from attendance_records where session_id = p_session_id;
  select count(*) filter (where status = 'admitted' and entry_type = 'flexible') into v_admitted_flexible_count from attendance_records where session_id = p_session_id;

  v_effective_priority_pool := coalesce(v_session.priority_seats, v_session.capacity);

  -- Both "session not open" and "past late-entry cutoff" collapse to the
  -- single 'invalid_qr' result value — the scan_attempts.result check
  -- constraint (Task 4) and the design spec's color table have no 8th/9th
  -- distinct code for either case. resolveAdmissionDecision (Task 8) uses
  -- this exact same collapse, to keep the TS preview and this RPC's
  -- actual write in sync.
  if v_has_this_session then
    v_result := 'duplicate';
  elsif v_has_conflicting_session then
    v_result := 'timeslot_conflict';
  elsif v_session.status <> 'confirmed' then
    v_result := 'invalid_qr'; -- session not open for entry
  elsif v_session.late_entry_cutoff_minutes is not null
        and now() > (v_session.start_time + (v_session.late_entry_cutoff_minutes || ' minutes')::interval)
        and not p_is_override_caller then
    v_result := 'invalid_qr'; -- late-entry blocked; collapsed into invalid_qr, see note above
  elsif v_total_admitted >= v_session.capacity then
    v_result := 'full';
  else
    case v_session.admission_policy
      when 'restricted' then
        if exists(select 1 from allocation_assignments where application_id = p_application_id and session_id = p_session_id and status in ('proposed', 'confirmed')) then
          v_result := 'admitted'; v_entry_type := 'priority';
        else
          v_result := 'restricted_denied';
        end if;
      when 'plenary' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'open' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'cross_cutting' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'priority_then_open' then
        if exists(select 1 from allocation_assignments where application_id = p_application_id and session_id = p_session_id and status in ('proposed', 'confirmed')) then
          v_result := 'admitted'; v_entry_type := 'priority';
        else
          v_released := (
            v_session.flexible_entry_manual_override is true
            or (v_session.flexible_entry_manual_override is distinct from false and v_session.priority_release_at is not null and now() >= v_session.priority_release_at)
            or (v_session.flexible_entry_manual_override is distinct from false and v_session.priority_release_at is null and v_session.priority_release_minutes_before is not null
                and now() >= v_session.start_time - (v_session.priority_release_minutes_before || ' minutes')::interval)
          );
          v_flexible_pool := (v_session.capacity - v_effective_priority_pool)
                              + (case when v_released then greatest(0, v_effective_priority_pool - v_admitted_priority_count) else 0 end);
          if v_total_admitted < v_session.capacity and v_admitted_flexible_count < v_flexible_pool then
            v_result := 'flexible_admitted'; v_entry_type := 'flexible';
          else
            v_result := 'priority_hold';
          end if;
        end if;
    end case;
  end if;

  if p_is_override_caller and v_result in ('restricted_denied', 'full', 'priority_hold') then
    v_result := 'override_admitted'; v_entry_type := 'override';
  end if;

  begin
    if v_result in ('admitted', 'flexible_admitted', 'override_admitted') then
      -- v_matched_booking_id is NULL when no matching active booking exists
      -- (e.g. a flexible/priority admission with no prior self-service
      -- booking, or an admission for a participant who never used
      -- self-service booking at all) -- this is the expected, normal,
      -- non-error case per the design spec's scope decision 1.
      select id into v_matched_booking_id from session_bookings
      where application_id = p_application_id and session_id = p_session_id and status = 'active';

      insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, device_identifier, booking_id)
      values (p_application_id, p_session_id, p_time_slot_group_key, v_entry_type, p_scanned_by, p_device_identifier, v_matched_booking_id)
      returning id into v_attendance_id;
    end if;

    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, resulting_attendance_id, finalized_at, idempotency_key, scan_fingerprint)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, v_result, v_attendance_id, now(), p_idempotency_key, v_scan_fingerprint)
    returning * into v_scan_attempt;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'attendance_records_no_duplicate_active' then
      raise;
    elsif v_constraint = 'scan_attempts_idempotency_key_unique' then
      select * into v_existing from scan_attempts where idempotency_key = p_idempotency_key;
      if v_existing.scan_fingerprint is not distinct from v_scan_fingerprint and v_existing.session_id = p_session_id then
        return v_existing;
      else
        raise exception 'Idempotency key reused with different scan data';
      end if;
    else
      raise;
    end if;
  end;

  return v_scan_attempt;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Drop the current 6-argument signature (20260928000000 / 20261006050000)
-- before creating the new 7-argument version below -- same reasoning as
-- scan_attempt_transactional above: a bare `create or replace` with a
-- different argument count would create a second, ambiguous overload
-- rather than replacing this one, breaking every existing caller using
-- named parameters without p_idempotency_key (PGRST203 "function is not
-- unique").
drop function if exists public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid);

-- Body copied verbatim from supabase/migrations/20261006050000_walk_in_admission.sql
-- lines 274+ (the current, unmodified scan_qr_attempt_transactional), with:
--   - a new trailing p_idempotency_key parameter, forwarded as the 8th
--     positional argument to scan_attempt_transactional, with p_token_hash
--     forwarded as the 9th positional argument (both are needed -- the
--     fingerprint check is meaningless if computed from an empty hash);
--   - both of this function's own unresolved-credential early-return
--     branches (malformed hash, no active credential match) now compute
--     v_scan_fingerprint the same way and wrap their own insert in the same
--     begin...exception when unique_violation / constraint_name pattern as
--     scan_attempt_transactional (no advisory lock needed here, per the
--     spec -- each is a single, unconditional insert).
create or replace function public.scan_qr_attempt_transactional(
  p_token_hash bytea,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_is_override_caller boolean default false,
  p_scanner_user_id uuid default null,
  p_idempotency_key uuid default null
) returns scan_attempts
language plpgsql
as $$
declare
  v_credential public.qr_credentials%rowtype;
  v_application_id uuid;
  v_time_slot_group_key text;
  v_scan_attempt scan_attempts%rowtype;
  v_scan_fingerprint bytea;
  v_existing scan_attempts%rowtype;
  v_constraint text;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    v_scan_fingerprint := extensions.digest(coalesce(p_token_hash, ''::bytea) || uuid_send(p_session_id), 'sha256');
    begin
      insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at, idempotency_key, scan_fingerprint)
      values (null, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now(), p_idempotency_key, v_scan_fingerprint)
      returning * into v_scan_attempt;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'scan_attempts_idempotency_key_unique' then
        select * into v_existing from scan_attempts where idempotency_key = p_idempotency_key;
        if v_existing.scan_fingerprint is not distinct from v_scan_fingerprint and v_existing.session_id = p_session_id then
          return v_existing;
        else
          raise exception 'Idempotency key reused with different scan data';
        end if;
      else
        raise;
      end if;
    end;
    return v_scan_attempt;
  end if;

  select * into v_credential from public.qr_credentials
    where token_hash = p_token_hash and status = 'active';

  if v_credential.id is null then
    v_scan_fingerprint := extensions.digest(coalesce(p_token_hash, ''::bytea) || uuid_send(p_session_id), 'sha256');
    begin
      insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at, idempotency_key, scan_fingerprint)
      values (null, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now(), p_idempotency_key, v_scan_fingerprint)
      returning * into v_scan_attempt;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'scan_attempts_idempotency_key_unique' then
        select * into v_existing from scan_attempts where idempotency_key = p_idempotency_key;
        if v_existing.scan_fingerprint is not distinct from v_scan_fingerprint and v_existing.session_id = p_session_id then
          return v_existing;
        else
          raise exception 'Idempotency key reused with different scan data';
        end if;
      else
        raise;
      end if;
    end;
    return v_scan_attempt;
  end if;

  v_application_id := v_credential.application_id;
  v_time_slot_group_key := public.compute_time_slot_group_key_for_session(p_session_id);

  select * into v_scan_attempt
  from public.scan_attempt_transactional(
    v_application_id, p_session_id, p_scanned_by, p_device_identifier,
    v_time_slot_group_key, p_is_override_caller, p_scanner_user_id,
    p_idempotency_key, p_token_hash
  );

  return v_scan_attempt;
end;
$$;

comment on function public.scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean, uuid, uuid, bytea) is
  'Sole write authority for attendance_records/scan_attempts. p_scanner_user_id (optional) re-verifies scanner_assignments scope inside this function''s own advisory-locked transaction, closing the TOCTOU window between scan-attempt.ts''s pre-call verifyScannerScope and this RPC. Pass null from non-scope-limited callers (the admission-review override path). booking_id (Task 6) is populated best-effort from a matching active session_bookings row and is normally NULL for admissions with no prior self-service booking. p_idempotency_key/p_token_hash (offline-scanning-support Task 1) make a retried call with the same key replay the original committed scan_attempts row instead of risking a second write; scan_fingerprint is derived from p_token_hash, p_session_id, and p_application_id together (not persisting p_token_hash itself) specifically so a reused key presented with different scan data is detected even on this function''s non-QR call sites, where p_token_hash is always null and application_id is the only thing that varies between two different applicants.';

comment on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid, uuid) is
  'Phase 7A scanner bridge. p_scanner_user_id (optional) is forwarded to scan_attempt_transactional for the same in-transaction scope re-check; see that function''s comment. p_idempotency_key (offline-scanning-support Task 1) is forwarded to scan_attempt_transactional for resolved scans, and used directly by this function''s own two unresolved-credential early-return branches so a retried malformed/unknown-token scan also replays rather than double-inserting.';

-- scan_attempt_transactional itself was never explicitly revoked from
-- PUBLIC in any prior migration (Postgres grants EXECUTE to PUBLIC by
-- default unless revoked), so this grant is consistent with — not a
-- tightening of — its existing reachability. create or replace function on
-- this is a NEW signature (the argument list grew from 7 to 9 arguments),
-- so the grant must be restated explicitly here rather than assumed
-- carried over.
grant execute on function public.scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean, uuid, uuid, bytea) to service_role;

-- scan_qr_attempt_transactional's original signature WAS explicitly
-- revoked from public/anon/authenticated (20260814100000). Postgres does
-- not carry that revoke over to a new overload — a fresh signature starts
-- back at the PUBLIC-executable default — so it must be re-revoked here
-- for the new 7-arg overload, or this migration would silently widen the
-- function's reachability to anon/authenticated clients.
revoke all on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid, uuid) from public, anon, authenticated;
grant execute on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid, uuid) to service_role;
