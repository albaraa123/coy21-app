-- fix_scan_attempt_transactional_finalized_at.sql
--
-- Corrective fix, upstream of Phase 7A. Migration 20260805235959 added
-- scan_attempts.finalized_at/expires_at plus the
-- scan_attempts_finalization_state_check constraint (requiring
-- finalized_at IS NOT NULL for every result other than
-- 'token_valid_pending_confirmation'), but never updated the existing,
-- live scan_attempt_transactional function to set finalized_at on either
-- of its two INSERT statements. Since scan_attempt_transactional only
-- ever produces terminal results — verified by tracing every branch:
-- 'invalid_qr', 'duplicate', 'timeslot_conflict', 'full', 'admitted',
-- 'restricted_denied', 'flexible_admitted', 'priority_hold',
-- 'override_admitted' — it never writes 'token_valid_pending_confirmation',
-- so both of its inserts have been violating the constraint since that
-- migration was applied. This is the only genuine bug: the writer, not the
-- constraint, which correctly encodes the lifecycle contract
-- (pending = finalized_at null + expires_at set; terminal = finalized_at
-- set + expires_at null) — see scan_attempts_finalization_state_check's own
-- definition, unchanged here.
--
-- Fix: both INSERT statements now set finalized_at = now(). now() (not
-- clock_timestamp()) matches this function's own existing convention —
-- every other timestamp comparison in its body (late-entry cutoff,
-- priority-release timing) already uses now(), and created_at's column
-- default is also now() — so created_at and finalized_at resolve to the
-- exact same frozen per-transaction timestamp for every insert here,
-- guaranteeing finalized_at >= created_at structurally, not by race.
-- clock_timestamp() is the correct choice elsewhere in this codebase (the
-- QR lifecycle finalizers) specifically because those functions take
-- multiple locks/waits before their terminal write and need the real
-- current instant, not the frozen transaction start time — neither
-- applies to this function's single-pass, no-intermediate-wait body.
--
-- Everything else is byte-for-byte unchanged: exact same signature,
-- advisory-lock retry loop, application/session validation, duplicate/
-- timeslot-conflict/capacity/eligibility/policy decision tree, override
-- handling, attendance_records write, and result vocabulary. Only the two
-- INSERT ... INTO scan_attempts statements gain one additional column.
create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false
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
