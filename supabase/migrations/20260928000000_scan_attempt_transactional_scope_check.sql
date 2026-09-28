-- scan_attempt_transactional_scope_check.sql
--
-- Closes a TOCTOU gap flagged in code review: scan-attempt.ts/
-- scan-qr-attempt.ts call verifyScannerScope (checks scanner_assignments
-- for an active session/room grant) as a separate round-trip BEFORE
-- calling scan_attempt_transactional/scan_qr_attempt_transactional. A
-- scanner's assignment can be deactivated in the window between that check
-- and the RPC call, letting a just-deactivated scanner complete one more
-- admission. The two reads were never in the same transaction, so no
-- amount of re-ordering in TypeScript can close this — only checking scope
-- again inside scan_attempt_transactional's own transaction, after its
-- advisory lock is held, actually does.
--
-- p_scanner_user_id is optional (default null = skip check) and additive
-- to the existing signature — every existing call site keeps compiling
-- unchanged. admission-management.ts's admitOverrideForCaller path
-- (program_attendance_manager/super_admin override) deliberately never
-- passes it: that path is documented as not scope-limited the way a
-- scanner_device caller is, and must stay that way. Only scan-attempt.ts
-- and scan-qr-attempt.ts (via scan_qr_attempt_transactional) pass it,
-- preserving the exact same "not authorized for this session/room" error
-- the TypeScript-side verifyScannerScope already raised, just re-checked
-- atomically instead of trusting a pre-lock read.
--
-- `create or replace function` with an added parameter creates a NEW
-- overload rather than replacing the old one — Postgres distinguishes
-- functions by their full argument signature, not just name. Left alone,
-- both the old 6-arg and new 7-arg scan_attempt_transactional would exist
-- side by side, and PostgREST's RPC dispatch (which matches by parameter
-- names in the request body) could resolve an old caller's request to
-- either overload non-deterministically — including, worst case, silently
-- keeping the unpatched TOCTOU-vulnerable version reachable. The old
-- signatures are dropped explicitly below before creating the new ones so
-- exactly one version of each function can ever exist.
drop function if exists scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean);
drop function if exists public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean);

create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false,
  p_scanner_user_id uuid default null
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
begin
  v_lock_key := hashtext(p_session_id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'Another scan for this session is still being processed after % retries — please retry manually', v_max_retries;
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

  select status into v_application_status from applications where id = p_application_id;
  select * into v_session from sessions where id = p_session_id;

  if v_application_status is null or v_application_status <> 'accepted' or v_session.id is null then
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now())
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

  if v_result in ('admitted', 'flexible_admitted', 'override_admitted') then
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, device_identifier)
    values (p_application_id, p_session_id, p_time_slot_group_key, v_entry_type, p_scanned_by, p_device_identifier)
    returning id into v_attendance_id;
  end if;

  insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, resulting_attendance_id, finalized_at)
  values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, v_result, v_attendance_id, now())
  returning * into v_scan_attempt;

  return v_scan_attempt;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- scan_qr_attempt_transactional gains the matching optional parameter and
-- passes it straight through to scan_attempt_transactional. Its own
-- unresolved-credential early-return branches (malformed hash, no active
-- credential match) never reach scan_attempt_transactional at all, so
-- scope is only re-checked once a real application_id is resolved — the
-- same shape as scan-qr-attempt.ts's existing verifyScannerScope call,
-- which already runs before credential resolution.
create or replace function public.scan_qr_attempt_transactional(
  p_token_hash bytea,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_is_override_caller boolean default false,
  p_scanner_user_id uuid default null
) returns scan_attempts
language plpgsql
as $$
declare
  v_credential public.qr_credentials%rowtype;
  v_application_id uuid;
  v_time_slot_group_key text;
  v_scan_attempt scan_attempts%rowtype;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at)
    values (null, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now())
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  select * into v_credential from public.qr_credentials
    where token_hash = p_token_hash and status = 'active';

  if v_credential.id is null then
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at)
    values (null, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now())
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  v_application_id := v_credential.application_id;
  v_time_slot_group_key := public.compute_time_slot_group_key_for_session(p_session_id);

  select * into v_scan_attempt
  from public.scan_attempt_transactional(
    v_application_id, p_session_id, p_scanned_by, p_device_identifier,
    v_time_slot_group_key, p_is_override_caller, p_scanner_user_id
  );

  return v_scan_attempt;
end;
$$;

comment on function public.scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean, uuid) is
  'Sole write authority for attendance_records/scan_attempts. p_scanner_user_id (optional) re-verifies scanner_assignments scope inside this function''s own advisory-locked transaction, closing the TOCTOU window between scan-attempt.ts''s pre-call verifyScannerScope and this RPC. Pass null from non-scope-limited callers (the admission-review override path).';

comment on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid) is
  'Phase 7A scanner bridge. p_scanner_user_id (optional) is forwarded to scan_attempt_transactional for the same in-transaction scope re-check; see that function''s comment.';

-- scan_attempt_transactional itself was never explicitly revoked from
-- PUBLIC in any prior migration (Postgres grants EXECUTE to PUBLIC by
-- default unless revoked), so this grant is consistent with — not a
-- tightening of — its existing reachability.
grant execute on function public.scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean, uuid) to service_role;

-- scan_qr_attempt_transactional's original signature WAS explicitly
-- revoked from public/anon/authenticated (20260814100000). Postgres does
-- not carry that revoke over to a new overload — a fresh signature starts
-- back at the PUBLIC-executable default — so it must be re-revoked here
-- for the new 6-arg overload, or this migration would silently widen the
-- function's reachability to anon/authenticated clients.
revoke all on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid) to service_role;
