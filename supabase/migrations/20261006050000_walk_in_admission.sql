-- 20261006050000_walk_in_admission.sql
--
-- Adds session_bookings.source and widens attendance_records.entry_type's
-- check constraint, then adds admit_walk_in() -- a new RPC letting staff
-- admit a not-yet-booked, accepted participant directly at the door.
-- Also updates scan_attempt_transactional to populate
-- attendance_records.booking_id (added in
-- 20261006035000_add_attendance_booking_id.sql, pulled forward from this
-- task into Task 4 to resolve a circular dependency -- Task 4's
-- process_session_no_shows needs that column to already exist) on every
-- admission the normal QR flow produces. See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- "Walk-In Admission" section for full rationale, including why
-- admit_walk_in's own is_staff() check is the sole authorization gate
-- (not deferred to a TypeScript-side pre-check) and the
-- compute_time_slot_group_key_for_session() access-path reasoning.

alter table session_bookings add column source text not null default 'self_service'
  check (source in ('self_service', 'walk_in'));

alter table attendance_records drop constraint attendance_records_entry_type_check;
alter table attendance_records add constraint attendance_records_entry_type_check
  check (entry_type in ('priority', 'flexible', 'override', 'walk_in'));

create function admit_walk_in(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session      sessions%rowtype;
  v_admitted     int;
  v_booking_id   uuid;
begin
  if not is_staff() then
    raise exception 'Not authorized';
  end if;

  if not exists (select 1 from applications where id = p_application_id and status = 'accepted') then
    raise exception 'Application not found or not accepted';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status <> 'confirmed' then
    raise exception 'Session is not open for admission';
  end if;

  select count(*) into v_admitted
  from attendance_records where session_id = p_session_id and status = 'admitted';
  if v_admitted >= v_session.capacity then
    raise exception 'Session is at capacity';
  end if;

  if exists (
    select 1 from session_bookings
    where application_id = p_application_id and session_id = p_session_id and status = 'active'
  ) then
    raise exception 'This participant already has a booking for this session';
  end if;

  if exists (
    select 1 from attendance_records
    where application_id = p_application_id and session_id = p_session_id and status = 'admitted'
  ) then
    raise exception 'This participant has already been admitted to this session';
  end if;

  insert into session_bookings (application_id, session_id, source)
  values (p_application_id, p_session_id, 'walk_in')
  returning id into v_booking_id;

  begin
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, booking_id)
    values (p_application_id, p_session_id, compute_time_slot_group_key_for_session(p_session_id), 'walk_in', auth.uid(), v_booking_id);
  exception when unique_violation then
    raise exception 'This participant has already been admitted to this session';
  end;

  return v_booking_id;
end;
$$;

grant execute on function admit_walk_in(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- scan_attempt_transactional: full current body copied verbatim from
-- 20260928000000_scan_attempt_transactional_scope_check.sql (confirmed via
-- direct read that no later migration touches this function), with exactly
-- one addition: a new v_matched_booking_id lookup immediately before the
-- `insert into attendance_records` statement inside the
-- 'admitted'/'flexible_admitted'/'override_admitted' branch, and
-- booking_id added to that insert's column/values lists. Every other line,
-- including the advisory lock retry loop, the in-transaction scanner-scope
-- re-check, and the full admission_policy decision tree, is unchanged.
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
  v_matched_booking_id uuid;
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
  'Sole write authority for attendance_records/scan_attempts. p_scanner_user_id (optional) re-verifies scanner_assignments scope inside this function''s own advisory-locked transaction, closing the TOCTOU window between scan-attempt.ts''s pre-call verifyScannerScope and this RPC. Pass null from non-scope-limited callers (the admission-review override path). booking_id (Task 6) is populated best-effort from a matching active session_bookings row and is normally NULL for admissions with no prior self-service booking.';

comment on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid) is
  'Phase 7A scanner bridge. p_scanner_user_id (optional) is forwarded to scan_attempt_transactional for the same in-transaction scope re-check; see that function''s comment.';

-- scan_attempt_transactional itself was never explicitly revoked from
-- PUBLIC in any prior migration (Postgres grants EXECUTE to PUBLIC by
-- default unless revoked), so this grant is consistent with — not a
-- tightening of — its existing reachability. create or replace function on
-- this unchanged signature (uuid, uuid, uuid, text, text, boolean, uuid)
-- already preserves the grant from 20260928000000; restating it here is
-- harmless and kept for clarity/completeness of this migration's own body.
grant execute on function public.scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean, uuid) to service_role;

-- scan_qr_attempt_transactional's original signature WAS explicitly
-- revoked from public/anon/authenticated (20260814100000). Postgres does
-- not carry that revoke over to a new overload — a fresh signature starts
-- back at the PUBLIC-executable default — so it must be re-revoked here
-- for the new 6-arg overload, or this migration would silently widen the
-- function's reachability to anon/authenticated clients. This signature is
-- unchanged from 20260928000000, so this revoke/grant pair is a harmless
-- no-op restatement (revoke on an already-not-granted privilege succeeds
-- without error in Postgres), kept for clarity/completeness of this
-- migration's own body.
revoke all on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean, uuid) to service_role;
