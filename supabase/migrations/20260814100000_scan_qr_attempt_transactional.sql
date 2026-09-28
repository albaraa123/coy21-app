-- scan_qr_attempt_transactional.sql
--
-- Phase 7A — Scanner QR Backend Contract & Authorization. Adds the missing
-- database bridge between Phase 6.1's canonical QR credential system
-- (qr_credentials, resolved by token_hash — see docs/superpowers/specs/
-- 2026-08-12-qr-token-format-and-lifecycle.md) and the existing, proven
-- attendance/admission engine (scan_attempt_transactional, unmodified).
--
-- Trust-boundary decision (documented per the Phase 7A brief's §10): the
-- trusted Next.js server layer parses the canonical rcoy:v1:<token> payload
-- and computes token_hash using the existing Phase 6.1 code
-- (src/lib/attendance/qr-token-crypto.ts's parseCanonicalQrPayload +
-- hashQrToken) — never re-implemented here. Only the resulting 32-byte
-- token_hash crosses into this function; the raw token/payload never
-- reaches SQL. This keeps exactly one canonical parsing/hashing
-- implementation (no parity-test burden), minimizes what a compromised or
-- buggy caller could ever leak into the database layer, and still commits
-- resolution + admission as one atomic transaction.
--
-- finalized_at: both direct scan_attempts inserts below (malformed-hash and
-- unresolved-credential branches) set finalized_at = now(), matching the
-- corrective fix applied to scan_attempt_transactional in migration
-- 20260814110000 — both branches write a terminal result
-- ('invalid_qr'), never 'token_valid_pending_confirmation', so
-- scan_attempts_finalization_state_check (from 20260805235959) requires
-- finalized_at IS NOT NULL here too. now() is used for the same reason as
-- that migration: consistency with created_at's own now()-based column
-- default within the same transaction, and this function has no
-- multi-step wait before either insert that would call for
-- clock_timestamp() instead.

-- ============================================================================
-- compute_time_slot_group_key_for_session — narrow SQL port of
-- groupSessionsIntoTimeSlots/computeTimeSlotGroupKey
-- (src/lib/allocation/time-slot-grouping.ts). Grouping/context derivation
-- ONLY — no admission-policy logic. Must remain byte-for-byte equivalent to
-- the TypeScript implementation; see
-- tests/attendance/time-slot-group-key-parity.test.ts for the proof.
-- ============================================================================
-- Path-compressing find over a plain int[] union-find parent array —
-- factored out as its own top-level helper because PL/pgSQL does not
-- support nested function declarations inside a function body. Pure/
-- side-effect-free (never mutates its input), used only by
-- compute_time_slot_group_key_for_session below.
create or replace function public.__tsgk_find_root(p_parent int[], p_idx int) returns int
language plpgsql
immutable
as $$
declare
  v_cur int := p_idx;
begin
  while p_parent[v_cur] <> v_cur loop
    v_cur := p_parent[v_cur];
  end loop;
  return v_cur;
end;
$$;

create or replace function public.compute_time_slot_group_key_for_session(
  p_session_id uuid
) returns text
language plpgsql
volatile
as $$
declare
  v_conference_day_id uuid;
  v_ids uuid[];
  v_starts timestamptz[];
  v_ends timestamptz[];
  v_parent int[];
  v_n int;
  v_i int;
  v_j int;
  v_root_i int;
  v_root_j int;
  v_root int;
  v_member_ids text[];
  v_key text;
begin
  select conference_day_id into v_conference_day_id from public.sessions where id = p_session_id;
  if v_conference_day_id is null then
    raise exception 'Session % not found', p_session_id;
  end if;

  -- Load every session on the same conference day, in a fixed (id-sorted)
  -- order so array indices are deterministic within this call.
  select array_agg(id order by id), array_agg(start_time order by id), array_agg(end_time order by id)
    into v_ids, v_starts, v_ends
    from public.sessions where conference_day_id = v_conference_day_id;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'Session % not found in any computed time-slot group', p_session_id;
  end if;

  -- Union-find init: each session starts as its own root.
  v_parent := array_fill(0, array[v_n]);
  for v_i in 1..v_n loop
    v_parent[v_i] := v_i;
  end loop;

  -- Pairwise half-open-interval overlap ([start, end)), exactly matching
  -- rangesOverlap in src/lib/allocation/time-slot-grouping.ts — O(n^2)
  -- over one day's sessions, same complexity as the TS version's own
  -- nested loop.
  for v_i in 1..v_n loop
    for v_j in (v_i + 1)..v_n loop
      if v_starts[v_i] < v_ends[v_j] and v_starts[v_j] < v_ends[v_i] then
        v_root_i := public.__tsgk_find_root(v_parent, v_i);
        v_root_j := public.__tsgk_find_root(v_parent, v_j);
        if v_root_i <> v_root_j then
          v_parent[v_root_i] := v_root_j;
        end if;
      end if;
    end loop;
  end loop;

  -- Locate the target session's index and resolve its final root.
  v_i := null;
  for v_j in 1..v_n loop
    if v_ids[v_j] = p_session_id then
      v_i := v_j;
    end if;
  end loop;
  if v_i is null then
    raise exception 'Session % not found in any computed time-slot group', p_session_id;
  end if;
  v_root := public.__tsgk_find_root(v_parent, v_i);

  -- Collect every session id sharing that root, sort lexicographically
  -- (matching computeTimeSlotGroupKey's `[...sessionIds].sort()`), then
  -- SHA-256 the comma-joined text — identical to the TS implementation.
  v_member_ids := array[]::text[];
  for v_j in 1..v_n loop
    if public.__tsgk_find_root(v_parent, v_j) = v_root then
      v_member_ids := array_append(v_member_ids, v_ids[v_j]::text);
    end if;
  end loop;
  select array_agg(x order by x) into v_member_ids from unnest(v_member_ids) as x;

  v_key := encode(digest(array_to_string(v_member_ids, ','), 'sha256'), 'hex');
  return v_key;
end;
$$;

comment on function public.compute_time_slot_group_key_for_session(uuid) is
  'Narrow SQL port of groupSessionsIntoTimeSlots/computeTimeSlotGroupKey (src/lib/allocation/time-slot-grouping.ts). Grouping only — no admission-policy logic. Must stay in exact parity with the TypeScript implementation; see tests/attendance/time-slot-group-key-parity.test.ts.';

-- ============================================================================
-- scan_qr_attempt_transactional — the Phase 7A bridge. Resolves a
-- Phase-6.1-issued credential by token_hash (already computed server-side,
-- never re-derived here from any text form) and, only for an active
-- credential, delegates to the existing, unmodified scan_attempt_transactional
-- for the actual admission decision/write. Every code path inserts exactly
-- one scan_attempts row: unresolved credentials insert it directly here
-- (application_id null, result 'invalid_qr') and return immediately without
-- ever invoking the admission engine; a resolved, active credential inserts
-- NO row here at all — scan_attempt_transactional owns that single insert.
-- ============================================================================
create or replace function public.scan_qr_attempt_transactional(
  p_token_hash bytea,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_is_override_caller boolean default false
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
    -- Malformed/absent hash never reaches qr_credentials at all — the
    -- trusted server boundary is expected to reject a non-canonical
    -- payload before ever calling this function, but this is a defensive,
    -- independent re-check at the SQL layer, matching this codebase's
    -- established defense-in-depth convention (e.g.
    -- qr_credentials_enforce_lifecycle_trigger restating checks the
    -- finalizers already perform).
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at)
    values (null, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now())
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  -- Hash lookup only — token_ciphertext is never read/decrypted for an
  -- ordinary scan. Unknown, revoked, and replaced credentials are
  -- indistinguishable at this boundary by design (Phase 7A brief §3): the
  -- WHERE clause itself only ever matches an 'active' row, so "no row
  -- found" already collapses all three non-usable states into one branch
  -- with no internal state ever inspected or exposed.
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

  -- Delegate entirely to the existing, unmodified attendance engine. No
  -- admission/capacity/eligibility/timeslot/duplicate/override logic is
  -- reimplemented here. This is the ONLY scan_attempts insert on this code
  -- path — scan_attempt_transactional performs it internally exactly once
  -- per its own existing contract.
  select * into v_scan_attempt
  from public.scan_attempt_transactional(
    v_application_id, p_session_id, p_scanned_by, p_device_identifier,
    v_time_slot_group_key, p_is_override_caller
  );

  return v_scan_attempt;
end;
$$;

comment on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean) is
  'Phase 7A scanner bridge: resolves a Phase 6.1 QR credential by token_hash (never by decrypting token_ciphertext) and delegates admission to the existing, unmodified scan_attempt_transactional. Raw QR token/payload never reaches this function or is ever stored — only a 32-byte SHA-256 hash computed server-side by src/lib/attendance/qr-token-crypto.ts.';

-- service_role-only: the browser must never call this directly. The
-- trusted Next.js server boundary (requireScannerDeviceCaller +
-- verifyScannerScope, both unchanged) is the only intended caller, using
-- the service-role client — matching scan_attempt_transactional's own
-- existing access pattern (also no authenticated/anon grant) and every
-- Phase 6.1 finalizer's revoke-then-narrow-grant convention.
revoke all on function public.__tsgk_find_root(int[], int) from public, anon, authenticated;
grant execute on function public.__tsgk_find_root(int[], int) to service_role;

revoke all on function public.compute_time_slot_group_key_for_session(uuid) from public, anon, authenticated;
grant execute on function public.compute_time_slot_group_key_for_session(uuid) to service_role;

revoke all on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean) to service_role;
