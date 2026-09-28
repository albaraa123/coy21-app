-- tests/attendance/qr-issuance-reservation.test-only-setup.sql
--
-- TEST-ONLY. NOT a Supabase migration — deliberately NOT under
-- supabase/migrations/, so it is never picked up by `supabase db push` /
-- the normal migration-apply flow and never ships to any deployed
-- environment. Must be applied to, and torn down from, a disposable LOCAL
-- Supabase instance only (`supabase start` + `supabase db reset --local`)
-- — never a shared, staging, or production project. See
-- tests/attendance/qr-issuance-reservation.test.ts's own local-database
-- guard for the runtime check that enforces this.
--
-- Teardown responsibilities, stated explicitly (final correction round):
--   - THIS file's paired teardown SQL
--     (qr-issuance-reservation.test-only-teardown.sql) removes ONLY the
--     test-only functions and the test_only_lock_gates table — it does
--     NOT and cannot remove durable fixture rows (auth.users, applications,
--     qr_credentials, qr_lifecycle_operations), since qr_credentials and
--     qr_lifecycle_operations are append-only lifecycle/audit tables whose
--     own triggers (§1.5/§1.7 of the Phase 6 design doc) unconditionally
--     forbid physical deletion.
--   - The TEST FILE ITSELF is responsible for releasing every lock gate it
--     creates and awaiting every holder RPC it starts (see that file's own
--     try/finally discipline) — this is per-test cleanup of DISPOSABLE
--     test-only fixtures (test_only_lock_gates rows), not of durable
--     production-shaped rows.
--   - Durable fixture rows (auth.users, applications, qr_credentials,
--     qr_lifecycle_operations created by this suite) are cleaned up ONLY
--     by the final `supabase db reset --local` the failure-safe runner
--     script performs after every run, success or failure — there is no
--     other mechanism for removing them, by design, since removing them
--     any other way would require bypassing the same immutability
--     guarantees this whole design exists to enforce.
--   - The runner's `trap`-guaranteed teardown + final reset remains the
--     ultimate backstop if the test file's own per-test cleanup is ever
--     skipped (e.g. the process is killed mid-suite).
--
-- Defines a test-only lock-gate table, TWENTY-TWO test-only helper
-- functions (extended this round from twenty to twenty-two — item 21
-- supports the reissue-finalizer TTL-vs-key-registry-lock correction's
-- own test coverage, item 22 is the fault-injection trigger function for
-- the narrowed foreign_key_violation-mapping correction's own test
-- coverage), and one test-only trigger (on public.audit_logs, scoped
-- exclusively by a dedicated application_name prefix so it has zero
-- effect on every other test) used exclusively by that test file:
--
--   1. test_only_release_lock_gate(p_gate_id) — sets released = true for
--      one gate row. Rejects a null gate id and raises a clear
--      test-precondition error if the row does not exist at all.
--      Releasing an already-released gate remains idempotent (succeeds
--      silently) — only a genuinely MISSING row is an error.
--
--   2. test_only_hold_active_credential_lock — validates the target
--      qr_credentials row exists, locks it FOR UPDATE, tags this
--      backend's application_name with the caller-supplied holder tag
--      ONLY AFTER the lock is acquired, then polls its gate row (with a
--      generous, explicitly VALIDATED bounded maximum wait, raising a
--      clear error rather than blocking forever) until released.
--
--   3. test_only_hold_application_lock — same shape, against
--      public.applications, but locks FOR NO KEY UPDATE, not FOR UPDATE
--      (see the correction note directly above that function's
--      definition below for why this distinction is load-bearing for the
--      unique-index tests specifically).
--
--   4. test_only_is_holder_ready(p_holder_tag) — returns true only when
--      EXACTLY ONE backend in pg_stat_activity currently carries that
--      exact application_name (rejects a null/blank tag outright).
--
--   5. test_only_is_waiter_blocked_by_holder(p_waiter_tag, p_holder_tag)
--      — the deterministic waiter-to-holder blocking-relationship
--      observer: proves, via pg_stat_activity and pg_blocking_pids(),
--      that the SPECIFIC tagged waiter backend (EXACTLY one, verified by
--      count — never LIMIT 1 — currently wait_event_type = 'Lock') is
--      blocked by the SPECIFIC tagged holder backend (EXACTLY one,
--      likewise verified by count).
--
--   6. test_only_request_my_qr_issuance_short_ttl — calls
--      request_my_qr_issuance_transactional_internal() directly with a
--      caller-supplied short p_pending_ttl and waiter tag. Used ONLY for
--      the two TTL-specific tests, where a shortened interval is the
--      actual thing under test.
--
--   7. test_only_request_my_qr_issuance_tagged — calls the REAL, migrated
--      public production wrapper, public.request_my_qr_issuance_transactional(uuid)
--      (fixed 5-minute TTL, exactly as deployed), with a caller-supplied
--      waiter tag set before the call. Used for the two unique-index
--      tests, which need deterministic blocking-observation but do NOT
--      need a shortened TTL — so they exercise the actual migrated public
--      entry point, not merely the internal implementation.
--
--   8. test_only_request_my_qr_reissue_short_ttl — the reissue equivalent
--      of item 6: calls request_my_qr_reissue_transactional_internal()
--      directly with a caller-supplied short p_pending_ttl and waiter
--      tag. Used ONLY for the reissue TTL-specific tests.
--
--   9. test_only_request_my_qr_reissue_tagged — the reissue equivalent of
--      item 7: calls the REAL, migrated public production wrapper,
--      public.request_my_qr_reissue_transactional(uuid, uuid, text, text)
--      (fixed 5-minute TTL, exactly as deployed), with a caller-supplied
--      waiter tag set before the call.
--
--   10. test_only_seed_channeled_consumed_reissue_operation (NOT itself
--      granted to any role — internal shared implementation only, wrapped
--      by items 11/12) — seeds a genuinely constraint-valid CONSUMED
--      reissue operation (real resulting credential via the two-insert-
--      then-transition sequence the production
--      qr_credentials_enforce_lifecycle_trigger actually requires, real
--      32-byte finalization_fingerprint, consistent application
--      relationships throughout) with a caller-controlled consumed_at and
--      caller-supplied channel/reason, for deterministic cooldown/
--      rolling-rate-limit BOUNDARY testing against the CORRECTED design
--      (which counts only qualifying consumed operations by consumed_at,
--      never every row by created_at).
--
--   11. test_only_seed_consumed_reissue_operation — thin wrapper around
--      item 10, fixed at channel = 'participant_self_service',
--      reissue_reason_code = 'lost_or_stolen_phone'. The seeded operation
--      DOES qualify for participant self-service cooldown/rate-limit
--      counting.
--
--   12. test_only_seed_staff_consumed_reissue_operation — thin wrapper
--      around item 10, fixed at channel = 'staff_individual',
--      reissue_reason_code = 'staff_assisted_recovery'. The seeded
--      operation does NOT qualify for participant self-service cooldown/
--      rate-limit counting (channel mismatch) — used specifically to
--      prove staff reissues never consume participant quota.
--
--   13. test_only_hold_then_cancel_bulk_batch — CORRECTED this round
--      (replaces the structurally-impossible test_only_hold_bulk_batch_lock,
--      which relied on a separate session updating a row a FOR UPDATE
--      holder still held — FOR UPDATE blocks both FOR SHARE reads AND
--      any other session's UPDATE against the same row, so that
--      choreography could never actually run). Locks the target batch
--      FOR UPDATE (conflicts with the production RPC's own FOR SHARE
--      batch read, so it deterministically blocks the reservation at its
--      correct lock-order position), waits for the controlling test's
--      explicit gate release, then performs the legal active ->
--      cancelled transition on the SAME locked row INSIDE THE SAME
--      TRANSACTION before returning — the row lock (and therefore the
--      reservation's block) only releases at commit, guaranteeing the
--      reservation can only ever observe the batch AFTER cancellation
--      has already been durably applied. Reused unchanged for staff
--      reissue's own batch tests (below), including with a
--      reissue-typed batch — this helper's own behavior does not depend
--      on intended_operation_type at all.
--
--   14. test_only_request_staff_qr_issuance_short_ttl — the staff
--      issuance equivalent of items 6/8: calls
--      request_staff_qr_issuance_transactional_internal() directly with
--      a caller-supplied short p_pending_ttl and waiter tag. Used ONLY
--      for staff issuance TTL-specific tests.
--
--   15. test_only_request_staff_qr_issuance_tagged — the staff issuance
--      equivalent of items 7/9: calls the REAL, migrated public
--      production wrapper,
--      public.request_staff_qr_issuance_transactional(uuid, uuid, text, text, uuid)
--      (fixed 5-minute TTL, exactly as deployed), with a caller-supplied
--      waiter tag set before the call.
--
--   16. test_only_request_staff_qr_reissue_short_ttl — the staff reissue
--      equivalent of item 14: calls
--      request_staff_qr_reissue_transactional_internal() directly with a
--      caller-supplied short p_pending_ttl and waiter tag. Used ONLY for
--      staff reissue TTL-specific tests.
--
--   17. test_only_request_staff_qr_reissue_tagged — the staff reissue
--      equivalent of item 15: calls the REAL, migrated public production
--      wrapper,
--      public.request_staff_qr_reissue_transactional(uuid, uuid, uuid, text, text, uuid)
--      (fixed 5-minute TTL, exactly as deployed), with a caller-supplied
--      waiter tag set before the call.
--
--   18. test_only_finalize_qr_issuance_tagged — exercises the REAL,
--      migrated, service_role-only production finalizer,
--      public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint),
--      with a caller-supplied waiter tag set before the call. Used for
--      finalizer concurrency tests that need deterministic blocking-
--      observation against test_only_hold_application_lock/
--      test_only_hold_active_credential_lock/
--      test_only_hold_then_cancel_bulk_batch (all REUSED UNCHANGED here
--      — the finalizer locks the identical batch/application/current-
--      active-credential rows in the identical FOR SHARE/FOR UPDATE
--      modes those holders already use for the reservation RPCs' own
--      tests).
--
--   19. test_only_cancel_bulk_batch_tagged — tags this backend's
--      application_name, then attempts the SAME direct UPDATE (status =
--      'cancelled', closed_at = clock_timestamp()) the finalizer's own
--      batch-lock correction must now block. Used to prove the OTHER
--      direction of the finalizer/batch race added this round: once
--      finalize_qr_issuance_for_server has locked the batch row FOR
--      SHARE (before the application lock), a concurrent attempt to
--      cancel that SAME batch must block behind the finalizer's hold —
--      observed via test_only_is_waiter_blocked_by_holder, with the
--      finalizer's own tag as the holder and this function's tag as the
--      waiter.
--
--   20. test_only_finalize_qr_reissue_tagged — exercises the REAL,
--      migrated, service_role-only production reissue finalizer,
--      public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint),
--      with a caller-supplied waiter tag set before the call. Used for
--      reissue-finalizer concurrency tests, reusing every existing
--      holder/waiter helper unchanged (application, active-credential,
--      hold-then-cancel-batch, cancel-batch-tagged) — the reissue
--      finalizer locks the identical rows in the identical modes the
--      issuance finalizer already established test coverage for.
--
--   21. test_only_hold_key_registry_lock — NEW this round, added for the
--      TTL-vs-key-registry-lock correction. Locks the target
--      qr_encryption_key_registry row FOR UPDATE (conflicts with
--      is_encryption_key_version_active()'s own FOR SHARE read, used by
--      both finalizers at their respective position-5 locks), tags this
--      backend's application_name with the caller-supplied holder tag
--      ONLY AFTER the lock is acquired, then polls its gate row until
--      released — identical shape to
--      test_only_hold_active_credential_lock/test_only_hold_application_lock.
--      Used to prove a finalizer is deterministically blocked
--      specifically on the key-registry lock while its own operation's
--      TTL expires, and that the authoritative TTL recheck (now captured
--      only after this lock, per the correction) correctly observes that
--      expiry rather than an earlier, stale timestamp.
--
--   22. test_only_fk_fault_injector (trigger function, paired with a
--      BEFORE INSERT trigger on public.audit_logs) — CORRECTED this
--      round: renamed from test_only_unrelated_fk_fault_injector and
--      EXTENDED to support TWO exact application_name prefixes. Exercises
--      the REAL production finalize_qr_reissue_for_server end-to-end
--      (never a copy of its exception-handling logic) by deliberately
--      raising a foreign_key_violation from inside the finalizer's own
--      success-path audit_logs insert:
--        'test-only-expected-fk:' — constraint_name =
--          'qr_credentials_replacement_same_application_fkey' — proves
--          the handler correctly maps THIS specific, by-name-matched
--          constraint to idempotency_conflict.
--        'test-only-unrelated-fk:' — constraint_name =
--          'test_only_unrelated_foreign_key' — proves the handler
--          re-raises every OTHER constraint rather than misreporting it.
--      Scoped EXCLUSIVELY by these two dedicated backend application_name
--      prefixes — for every other application_name, the trigger has zero
--      effect.
--
-- Apply with (against the LOCAL instance only):
--   supabase db query --local -f tests/attendance/qr-issuance-reservation.test-only-setup.sql
--
-- Tear down with the paired file immediately after the suite finishes —
-- see tests/attendance/qr-issuance-reservation.test-only-teardown.sql.

-- ============================================================================
-- test_only_lock_gates (table — the twenty-third object defined by this
-- file, distinct from the twenty-two functions and one trigger
-- enumerated above)
-- ============================================================================
create table public.test_only_lock_gates (
  gate_id   uuid primary key,
  released  boolean not null default false
);

alter table public.test_only_lock_gates enable row level security;
revoke all on public.test_only_lock_gates from public, anon, authenticated;
grant select, insert, update, delete on public.test_only_lock_gates to service_role;

-- ============================================================================
-- Cloud-native concurrency observer infrastructure
-- ============================================================================
-- The original synchronization design proved which backend held/was
-- blocked on a lock by tagging pg_stat_activity.application_name
-- (set_config('application_name', p_tag, true)) and having a separate
-- observer RPC poll for that tag. This works over a direct local
-- Postgres connection (supabase start), but Supabase Cloud routes every
-- admin.rpc()/client.rpc() call through PostgREST, which stamps its own
-- application_name ("PostgREST <version>") on the underlying pooled
-- connection — the caller-set tag is not observable from a separate
-- connection querying pg_stat_activity by application_name, at any
-- timeout length (confirmed by direct testing against
-- rcoy-phase6-test/lhzvuywqpjylxreglgnr).
--
-- This table instead records the ACTUAL, ever-reliable Postgres session
-- identity — pg_backend_pid() — against the same caller-supplied tag
-- strings the test files already generate, immediately after a holder
-- acquires its target lock or a waiter RPC begins executing. A
-- test-only Node.js observer (tests/attendance/cloud-native-lock-observer.ts)
-- then reads this table (a plain row, via the normal Supabase client —
-- no pooling concern, it is not a pg_stat_activity lookup) to get the
-- real backend PID, and queries pg_locks/pg_blocking_pids() for that
-- exact PID over a genuine direct PostgreSQL connection (opened with the
-- pg package against PHASE6_TEST_DATABASE_URL, bypassing PostgREST
-- entirely for this one purpose). The original application_name tagging
-- calls remain UNCHANGED and still run — harmlessly — alongside the new
-- PID registration, so this table/mechanism is purely additive and does
-- not remove or weaken the local/Docker path in any way.
create table public.test_only_backend_pids (
  tag  text primary key,
  pid  integer not null
);

alter table public.test_only_backend_pids enable row level security;
revoke all on public.test_only_backend_pids from public, anon, authenticated;
grant select, insert, update, delete on public.test_only_backend_pids to service_role;

-- Upsert (not plain insert) — a test occasionally reuses timing where a
-- retry could register the same tag twice; last-write-wins is correct
-- here since only the tag's CURRENT backend PID is ever meaningful.
create function public.test_only_register_backend_pid(p_tag text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tag is null or trim(p_tag) = '' then
    raise exception 'test_only_register_backend_pid: p_tag is required';
  end if;
  insert into public.test_only_backend_pids (tag, pid) values (p_tag, pg_backend_pid())
  on conflict (tag) do update set pid = excluded.pid;
end;
$$;

revoke all on function public.test_only_register_backend_pid(text) from public, anon, authenticated;
grant execute on function public.test_only_register_backend_pid(text) to service_role, authenticated;

-- ============================================================================
-- 1. test_only_release_lock_gate
-- ============================================================================
create function public.test_only_release_lock_gate(
  p_gate_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated_id uuid;
begin
  if p_gate_id is null then
    raise exception 'test_only_release_lock_gate: p_gate_id is required';
  end if;

  update public.test_only_lock_gates
  set released = true
  where gate_id = p_gate_id
  returning gate_id into v_updated_id;

  if v_updated_id is null then
    raise exception 'test_only_release_lock_gate: gate row % does not exist — it was never inserted, or a different gate_id was used', p_gate_id;
  end if;
end;
$$;

revoke all on function public.test_only_release_lock_gate(uuid) from public, anon, authenticated;
grant execute on function public.test_only_release_lock_gate(uuid) to service_role;

-- ============================================================================
-- test_only_current_timestamp
-- ============================================================================
-- Returns the DATABASE server's own clock_timestamp() — the exact
-- authority every production TTL check in this suite's target functions
-- uses. TTL-margin tests need to compute "wait until an operation's own
-- created_at + TTL has elapsed" against THIS clock, not a test runner's
-- local Date.now(), since client/server clock skew against Supabase Cloud
-- infrastructure was measured to make wall-clock-margin TTL tests
-- intermittently flaky.
create function public.test_only_current_timestamp() returns timestamptz
language sql security definer set search_path = public, pg_temp as $$
  select clock_timestamp();
$$;

revoke all on function public.test_only_current_timestamp() from public, anon, authenticated;
grant execute on function public.test_only_current_timestamp() to service_role;

-- ============================================================================
-- 2. test_only_hold_active_credential_lock
-- ============================================================================
-- Remains FOR UPDATE — nothing else in this suite ever needs to insert a
-- row that FK-references qr_credentials while this holder is active, so
-- there is no equivalent lock-conflict concern here.
create function public.test_only_hold_active_credential_lock(
  p_credential_id uuid,
  p_gate_id uuid,
  p_holder_tag text,
  p_max_wait_seconds numeric default 30
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_locked_id uuid;
  v_released boolean;
  v_deadline timestamptz;
begin
  if p_holder_tag is null or trim(p_holder_tag) = '' then
    raise exception 'test_only_hold_active_credential_lock: p_holder_tag is required';
  end if;
  if p_gate_id is null then
    raise exception 'test_only_hold_active_credential_lock: p_gate_id is required';
  end if;
  if p_max_wait_seconds is null or p_max_wait_seconds <= 0 then
    raise exception 'test_only_hold_active_credential_lock: p_max_wait_seconds must be a positive number';
  end if;
  if p_max_wait_seconds > 300 then
    raise exception 'test_only_hold_active_credential_lock: p_max_wait_seconds (%) exceeds the 300-second sanity ceiling for a test helper', p_max_wait_seconds;
  end if;

  select id into v_locked_id from public.qr_credentials where id = p_credential_id for update;
  if v_locked_id is null then
    raise exception 'test_only_hold_active_credential_lock: qr_credentials row % does not exist — refusing to gate without having locked anything', p_credential_id;
  end if;

  -- Tag AFTER the lock is acquired — this is the exact fact
  -- test_only_is_holder_ready proves by observing the tag.
  perform set_config('application_name', p_holder_tag, true);
  perform public.test_only_register_backend_pid(p_holder_tag);

  v_deadline := clock_timestamp() + make_interval(secs => p_max_wait_seconds);
  loop
    -- UNLOCKED read of the gate row — this transaction already holds the
    -- credential row lock; taking any lock on the gate row here would
    -- serve no purpose and would only complicate the controlling test's
    -- own ability to update it.
    select released into v_released from public.test_only_lock_gates where gate_id = p_gate_id;
    if v_released is null then
      raise exception 'test_only_hold_active_credential_lock: gate row % does not exist — the controlling test must insert it before calling this holder', p_gate_id;
    end if;
    if v_released then
      return; -- releases the credential row lock as this transaction ends
    end if;
    if clock_timestamp() >= v_deadline then
      raise exception 'test_only_hold_active_credential_lock: gate % was never released within % seconds — the controlling test likely has a bug', p_gate_id, p_max_wait_seconds;
    end if;
    perform pg_sleep(0.05);
  end loop;
end;
$$;

revoke all on function public.test_only_hold_active_credential_lock(uuid, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.test_only_hold_active_credential_lock(uuid, uuid, text, numeric)
  to service_role;

-- ============================================================================
-- 3. test_only_hold_application_lock
-- ============================================================================
-- CORRECTED: FOR UPDATE -> FOR NO KEY UPDATE. The two unique-index tests
-- deliberately keep the waiter session blocked on this application row
-- lock while a DIRECT BYPASS session inserts a CHILD
-- qr_lifecycle_operations row that foreign-keys to this SAME application
-- (application_id references public.applications(id)). Postgres's FK
-- enforcement machinery takes a FOR KEY SHARE lock on the REFERENCED
-- (parent) row as part of validating that child insert. FOR KEY SHARE is
-- compatible with FOR NO KEY UPDATE (which does not touch the row's key
-- columns) but conflicts with FOR UPDATE (which locks the row against
-- ANY concurrent access, key columns included) — so a FOR UPDATE holder
-- would have blocked the bypass session's own child insert until the
-- gate was released, making the intended interleaving (bypass insert
-- completing WHILE the application lock is still held) structurally
-- impossible to observe. FOR NO KEY UPDATE is the correct, more precise
-- lock here: it still conflicts with (and therefore still blocks) the
-- production RPC's own `select ... for update` on the SAME application
-- row (FOR UPDATE and FOR NO KEY UPDATE ARE mutually exclusive with each
-- other), while remaining compatible with the FOR KEY SHARE the bypass
-- child insert's FK check needs.
create function public.test_only_hold_application_lock(
  p_application_id uuid,
  p_gate_id uuid,
  p_holder_tag text,
  p_max_wait_seconds numeric default 30
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_locked_id uuid;
  v_released boolean;
  v_deadline timestamptz;
begin
  if p_holder_tag is null or trim(p_holder_tag) = '' then
    raise exception 'test_only_hold_application_lock: p_holder_tag is required';
  end if;
  if p_gate_id is null then
    raise exception 'test_only_hold_application_lock: p_gate_id is required';
  end if;
  if p_max_wait_seconds is null or p_max_wait_seconds <= 0 then
    raise exception 'test_only_hold_application_lock: p_max_wait_seconds must be a positive number';
  end if;
  if p_max_wait_seconds > 300 then
    raise exception 'test_only_hold_application_lock: p_max_wait_seconds (%) exceeds the 300-second sanity ceiling for a test helper', p_max_wait_seconds;
  end if;

  select id into v_locked_id from public.applications where id = p_application_id for no key update;
  if v_locked_id is null then
    raise exception 'test_only_hold_application_lock: applications row % does not exist — refusing to gate without having locked anything', p_application_id;
  end if;

  perform set_config('application_name', p_holder_tag, true);
  perform public.test_only_register_backend_pid(p_holder_tag);

  v_deadline := clock_timestamp() + make_interval(secs => p_max_wait_seconds);
  loop
    select released into v_released from public.test_only_lock_gates where gate_id = p_gate_id;
    if v_released is null then
      raise exception 'test_only_hold_application_lock: gate row % does not exist — the controlling test must insert it before calling this holder', p_gate_id;
    end if;
    if v_released then
      return;
    end if;
    if clock_timestamp() >= v_deadline then
      raise exception 'test_only_hold_application_lock: gate % was never released within % seconds — the controlling test likely has a bug', p_gate_id, p_max_wait_seconds;
    end if;
    perform pg_sleep(0.05);
  end loop;
end;
$$;

revoke all on function public.test_only_hold_application_lock(uuid, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.test_only_hold_application_lock(uuid, uuid, text, numeric)
  to service_role;

-- ============================================================================
-- test_only_hold_application_lock_and_mutate_status
--
-- Identical to test_only_hold_application_lock, except that once the gate
-- releases it updates the SAME locked row's status to p_new_status BEFORE
-- returning (i.e. before its own transaction commits and the row lock is
-- released). This guarantees the mutation is durably applied and visible
-- to every OTHER transaction before any of them can even acquire the row
-- lock — closing the race a separate PostgREST/admin.from().update() call
-- would otherwise have against a waiter unblocked by the SAME gate
-- release (both would be racing for lock acquisition order, which
-- Postgres does not guarantee FIFO on, and the separate-session version
-- also risked PostgREST's own statement_timeout while genuinely blocked
-- behind this holder's FOR NO KEY UPDATE).
-- ============================================================================
create function public.test_only_hold_application_lock_and_mutate_status(
  p_application_id uuid,
  p_gate_id uuid,
  p_holder_tag text,
  p_new_status text,
  p_max_wait_seconds numeric default 30
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_locked_id uuid;
  v_released boolean;
  v_deadline timestamptz;
begin
  if p_holder_tag is null or trim(p_holder_tag) = '' then
    raise exception 'test_only_hold_application_lock_and_mutate_status: p_holder_tag is required';
  end if;
  if p_gate_id is null then
    raise exception 'test_only_hold_application_lock_and_mutate_status: p_gate_id is required';
  end if;
  if p_new_status is null or trim(p_new_status) = '' then
    raise exception 'test_only_hold_application_lock_and_mutate_status: p_new_status is required';
  end if;
  if p_max_wait_seconds is null or p_max_wait_seconds <= 0 then
    raise exception 'test_only_hold_application_lock_and_mutate_status: p_max_wait_seconds must be a positive number';
  end if;
  if p_max_wait_seconds > 300 then
    raise exception 'test_only_hold_application_lock_and_mutate_status: p_max_wait_seconds (%) exceeds the 300-second sanity ceiling for a test helper', p_max_wait_seconds;
  end if;

  select id into v_locked_id from public.applications where id = p_application_id for no key update;
  if v_locked_id is null then
    raise exception 'test_only_hold_application_lock_and_mutate_status: applications row % does not exist — refusing to gate without having locked anything', p_application_id;
  end if;

  perform set_config('application_name', p_holder_tag, true);
  perform public.test_only_register_backend_pid(p_holder_tag);

  v_deadline := clock_timestamp() + make_interval(secs => p_max_wait_seconds);
  loop
    select released into v_released from public.test_only_lock_gates where gate_id = p_gate_id;
    if v_released is null then
      raise exception 'test_only_hold_application_lock_and_mutate_status: gate row % does not exist — the controlling test must insert it before calling this holder', p_gate_id;
    end if;
    if v_released then
      update public.applications set status = p_new_status::public.application_status where id = p_application_id;
      return;
    end if;
    if clock_timestamp() >= v_deadline then
      raise exception 'test_only_hold_application_lock_and_mutate_status: gate % was never released within % seconds — the controlling test likely has a bug', p_gate_id, p_max_wait_seconds;
    end if;
    perform pg_sleep(0.05);
  end loop;
end;
$$;

revoke all on function public.test_only_hold_application_lock_and_mutate_status(uuid, uuid, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.test_only_hold_application_lock_and_mutate_status(uuid, uuid, text, text, numeric)
  to service_role;

-- ============================================================================
-- test_only_hold_reservation_domain_advisory_lock
--
-- Holds the SAME (application_id, operation_type)-keyed advisory lock
-- reserve_or_reuse_qr_lifecycle_operation() itself takes at position 2 —
-- via pg_advisory_xact_lock(hashtextextended(application_id || ':' ||
-- operation_type, 0)), identical hash input, so a concurrent call to that
-- function for the SAME (application_id, operation_type) genuinely blocks
-- behind this holder. Needed because tests proving "different-key blocker"
-- scenarios (an existing pending operation the resolver finds via
-- other_pending_candidate) resolve through resolve_blocking_qr_lifecycle_*
-- BEFORE ever reaching the application row's own FOR UPDATE lock — that
-- fast path only requires this advisory lock and the request-key lock at
-- position 1, confirmed by direct pg_locks/pg_stat_activity observation
-- against rcoy-phase6-test/lhzvuywqpjylxreglgnr (the waiter's backend went
-- idle/ClientRead — its query had already completed — while
-- test_only_hold_application_lock's row lock sat unused). This holder lets
-- those tests block on the lock the code they exercise actually takes,
-- rather than one it does not.
-- ============================================================================
create function public.test_only_hold_reservation_domain_advisory_lock(
  p_application_id uuid,
  p_operation_type text,
  p_gate_id uuid,
  p_holder_tag text,
  p_max_wait_seconds numeric default 30
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_released boolean;
  v_deadline timestamptz;
begin
  if p_application_id is null then
    raise exception 'test_only_hold_reservation_domain_advisory_lock: p_application_id is required';
  end if;
  if p_operation_type is null or trim(p_operation_type) = '' then
    raise exception 'test_only_hold_reservation_domain_advisory_lock: p_operation_type is required';
  end if;
  if p_holder_tag is null or trim(p_holder_tag) = '' then
    raise exception 'test_only_hold_reservation_domain_advisory_lock: p_holder_tag is required';
  end if;
  if p_gate_id is null then
    raise exception 'test_only_hold_reservation_domain_advisory_lock: p_gate_id is required';
  end if;
  if p_max_wait_seconds is null or p_max_wait_seconds <= 0 then
    raise exception 'test_only_hold_reservation_domain_advisory_lock: p_max_wait_seconds must be a positive number';
  end if;
  if p_max_wait_seconds > 300 then
    raise exception 'test_only_hold_reservation_domain_advisory_lock: p_max_wait_seconds (%) exceeds the 300-second sanity ceiling for a test helper', p_max_wait_seconds;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_application_id::text || ':' || p_operation_type, 0)
  );

  perform set_config('application_name', p_holder_tag, true);
  perform public.test_only_register_backend_pid(p_holder_tag);

  v_deadline := clock_timestamp() + make_interval(secs => p_max_wait_seconds);
  loop
    select released into v_released from public.test_only_lock_gates where gate_id = p_gate_id;
    if v_released is null then
      raise exception 'test_only_hold_reservation_domain_advisory_lock: gate row % does not exist — the controlling test must insert it before calling this holder', p_gate_id;
    end if;
    if v_released then
      return;
    end if;
    if clock_timestamp() >= v_deadline then
      raise exception 'test_only_hold_reservation_domain_advisory_lock: gate % was never released within % seconds — the controlling test likely has a bug', p_gate_id, p_max_wait_seconds;
    end if;
    perform pg_sleep(0.05);
  end loop;
end;
$$;

revoke all on function public.test_only_hold_reservation_domain_advisory_lock(uuid, text, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.test_only_hold_reservation_domain_advisory_lock(uuid, text, uuid, text, numeric)
  to service_role;

-- ============================================================================
-- 4. test_only_is_holder_ready
-- ============================================================================
create function public.test_only_is_holder_ready(
  p_holder_tag text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp volatile as $$
declare
  v_count integer;
begin
  if p_holder_tag is null or trim(p_holder_tag) = '' then
    raise exception 'test_only_is_holder_ready: p_holder_tag is required';
  end if;

  select count(*) into v_count from pg_stat_activity where application_name = p_holder_tag;
  return v_count = 1;
end;
$$;

revoke all on function public.test_only_is_holder_ready(text) from public, anon, authenticated;
grant execute on function public.test_only_is_holder_ready(text) to service_role;

-- ============================================================================
-- 5. test_only_is_waiter_blocked_by_holder
-- ============================================================================
-- CORRECTED: previously used `limit 1` for BOTH tag lookups, which
-- silently tolerates more than one backend carrying the same tag (e.g. a
-- leftover backend from a prior failed test run that never cleared its
-- own application_name) — picking an ARBITRARY one of them rather than
-- proving the tag resolves UNIQUELY, contradicting this function's own
-- documented "exactly one" contract. Both tags are now counted
-- explicitly; a count other than exactly 1 for EITHER tag returns false
-- outright, matching test_only_is_holder_ready's identical discipline.
-- Non-empty tag validation added, matching every other tagged helper in
-- this file.
create function public.test_only_is_waiter_blocked_by_holder(
  p_waiter_tag text,
  p_holder_tag text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp volatile as $$
declare
  v_waiter_count integer;
  v_holder_count integer;
  v_waiter_pid integer;
  v_holder_pid integer;
  v_waiter_wait_event_type text;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_is_waiter_blocked_by_holder: p_waiter_tag is required';
  end if;
  if p_holder_tag is null or trim(p_holder_tag) = '' then
    raise exception 'test_only_is_waiter_blocked_by_holder: p_holder_tag is required';
  end if;

  select count(*) into v_waiter_count from pg_stat_activity where application_name = p_waiter_tag;
  if v_waiter_count <> 1 then
    return false;
  end if;

  select count(*) into v_holder_count from pg_stat_activity where application_name = p_holder_tag;
  if v_holder_count <> 1 then
    return false;
  end if;

  select pid, wait_event_type into v_waiter_pid, v_waiter_wait_event_type
    from pg_stat_activity where application_name = p_waiter_tag;

  select pid into v_holder_pid
    from pg_stat_activity where application_name = p_holder_tag;

  if v_waiter_wait_event_type is distinct from 'Lock' then
    return false; -- the (uniquely resolved) waiter exists but is not currently waiting on any lock
  end if;

  return v_holder_pid = any (pg_blocking_pids(v_waiter_pid));
end;
$$;

revoke all on function public.test_only_is_waiter_blocked_by_holder(text, text)
  from public, anon, authenticated;
grant execute on function public.test_only_is_waiter_blocked_by_holder(text, text)
  to service_role;

-- ============================================================================
-- 6. test_only_request_my_qr_issuance_short_ttl
-- ============================================================================
-- Used ONLY for the two TTL-specific tests, where a shortened interval is
-- the actual thing under test.
create function public.test_only_request_my_qr_issuance_short_ttl(
  p_request_key uuid,
  p_pending_ttl interval,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_request_my_qr_issuance_short_ttl: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.request_my_qr_issuance_transactional_internal(p_request_key, p_pending_ttl);
  return v_result;
end;
$$;

revoke all on function public.test_only_request_my_qr_issuance_short_ttl(uuid, interval, text)
  from public, anon, service_role;
grant execute on function public.test_only_request_my_qr_issuance_short_ttl(uuid, interval, text)
  to authenticated;

-- ============================================================================
-- 7. test_only_request_my_qr_issuance_tagged
-- ============================================================================
-- Exercises the REAL, migrated public production wrapper
-- (request_my_qr_issuance_transactional(uuid), fixed 5-minute TTL,
-- exactly as deployed) rather than the internal implementation directly
-- — used for tests that need deterministic blocking-observation but do
-- NOT need a shortened TTL.
create function public.test_only_request_my_qr_issuance_tagged(
  p_request_key uuid,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_request_my_qr_issuance_tagged: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.request_my_qr_issuance_transactional(p_request_key);
  return v_result;
end;
$$;

revoke all on function public.test_only_request_my_qr_issuance_tagged(uuid, text)
  from public, anon, service_role;
grant execute on function public.test_only_request_my_qr_issuance_tagged(uuid, text)
  to authenticated;

-- ============================================================================
-- 8. test_only_request_my_qr_reissue_short_ttl
-- ============================================================================
-- Mirrors test_only_request_my_qr_issuance_short_ttl's exact shape for the
-- participant self-reissue reservation. Used ONLY for the TTL-specific
-- reissue tests, where a shortened interval is the actual thing under
-- test.
create function public.test_only_request_my_qr_reissue_short_ttl(
  p_request_key uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_pending_ttl interval,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_request_my_qr_reissue_short_ttl: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.request_my_qr_reissue_transactional_internal(
    p_request_key, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note, p_pending_ttl
  );
  return v_result;
end;
$$;

revoke all on function public.test_only_request_my_qr_reissue_short_ttl(uuid, uuid, text, text, interval, text)
  from public, anon, service_role;
grant execute on function public.test_only_request_my_qr_reissue_short_ttl(uuid, uuid, text, text, interval, text)
  to authenticated;

-- ============================================================================
-- 9. test_only_request_my_qr_reissue_tagged
-- ============================================================================
-- Exercises the REAL, migrated public production wrapper
-- (request_my_qr_reissue_transactional(uuid, uuid, text, text), fixed
-- 5-minute TTL, exactly as deployed) rather than the internal
-- implementation directly — used for reissue tests that need
-- deterministic blocking-observation but do NOT need a shortened TTL.
create function public.test_only_request_my_qr_reissue_tagged(
  p_request_key uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_request_my_qr_reissue_tagged: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.request_my_qr_reissue_transactional(
    p_request_key, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note
  );
  return v_result;
end;
$$;

revoke all on function public.test_only_request_my_qr_reissue_tagged(uuid, uuid, text, text, text)
  from public, anon, service_role;
grant execute on function public.test_only_request_my_qr_reissue_tagged(uuid, uuid, text, text, text)
  to authenticated;

-- ============================================================================
-- 10. test_only_seed_consumed_reissue_operation
-- ============================================================================
-- CORRECTED this round (was test_only_seed_terminal_reissue_operation,
-- which seeded an 'expired' row — no longer what cooldown/rate-limit
-- counts at all, since the corrected design counts only qualifying
-- CONSUMED operations by consumed_at). Seeds a synthetic, genuinely
-- constraint-valid CONSUMED participant-self-service reissue operation
-- with a caller-controlled consumed_at/finalized_at, for deterministic
-- cooldown/rolling-rate-limit BOUNDARY testing.
--
-- "Genuinely constraint-valid" means every field
-- qr_lifecycle_operations_consumed_is_consistent and the lifecycle
-- trigger require is actually satisfied, not merely present:
--   - finalized_at = consumed_at (qr_lifecycle_operations_consumed_timestamps_match),
--     both set to the caller-supplied timestamp.
--   - resulting_credential_id: a REAL, freshly-inserted qr_credentials row
--     (status = 'replaced', never 'active' — inserting a second 'active'
--     row for the same application would violate
--     qr_credentials_one_active_per_application and collide with the
--     fixture's own real active credential) satisfying
--     qr_lifecycle_operations_resulting_credential_fkey's composite
--     (id, application_id) target and
--     qr_lifecycle_operations_resulting_credential_unique_idx (never
--     reused across two operations).
--   - finalization_fingerprint: a real 32-byte value (the fingerprint
--     column only checks octet_length = 32, not any specific derivation —
--     a deterministic-but-arbitrary 32 bytes via digest() is sufficient
--     and does not weaken any production constraint).
--   - expected_current_credential_id: supplied by the caller, exactly as
--     production requires for every operation_type = 'reissue' row
--     (qr_lifecycle_operations_reissue_has_expected_credential) —
--     ordinarily the credential that WAS active before this synthetic
--     reissue, i.e. the same credential the real fixture's
--     insertActiveCredential() call produced before this seed runs. Must
--     be DISTINCT from resulting_credential_id
--     (qr_lifecycle_operations_reissue_result_differs).
--   - channel = 'participant_self_service' explicitly (never staff) — the
--     cooldown/rate-limit query filters on this exact value, so a
--     mis-seeded row would silently fail to count, masking real bugs
--     rather than proving the filter works.
-- No trigger is disabled and no production constraint is weakened or
-- bypassed anywhere in this function — every insert/update below goes
-- through the SAME qr_credentials/qr_lifecycle_operations triggers and
-- CHECK constraints a real finalizer's writes would.
-- Shared implementation, parameterized by channel/reason so the
-- participant and staff variants (items 10/11 below) share one body and
-- can never independently drift on the constraint-satisfaction details.
-- NOT itself exposed — wrapped by the two channel-specific public
-- entry points below.
create function public.test_only_seed_channeled_consumed_reissue_operation(
  p_application_id uuid,
  p_requester_auth_user_id uuid,
  p_expected_current_credential_id uuid,
  p_consumed_at timestamptz,
  p_channel text,
  p_reissue_reason_code text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key_version smallint;
  v_resulting_credential_id uuid;
  v_terminal_credential_id uuid;
  v_operation_id uuid;
  v_fingerprint bytea;
  v_envelope bytea;
begin
  if p_application_id is null then
    raise exception 'test_only_seed_channeled_consumed_reissue_operation: p_application_id is required';
  end if;
  if p_requester_auth_user_id is null then
    raise exception 'test_only_seed_channeled_consumed_reissue_operation: p_requester_auth_user_id is required';
  end if;
  if p_expected_current_credential_id is null then
    raise exception 'test_only_seed_channeled_consumed_reissue_operation: p_expected_current_credential_id is required';
  end if;
  if p_consumed_at is null then
    raise exception 'test_only_seed_channeled_consumed_reissue_operation: p_consumed_at is required';
  end if;

  select key_version into v_key_version from public.qr_encryption_key_registry where status = 'active' limit 1;
  if v_key_version is null then
    raise exception 'test_only_seed_channeled_consumed_reissue_operation: no active key version found in qr_encryption_key_registry';
  end if;

  -- FIX (this round): the previous version of this function inserted
  -- v_resulting_credential_id as 'active', THEN inserted a SECOND row
  -- (v_terminal_credential_id) also as 'active' for the SAME
  -- application_id, before ever retiring the first — two simultaneously
  -- 'active' rows for one application, which qr_credentials_one_active_
  -- per_application (a same-statement, non-deferrable partial unique
  -- index — see the production finalizer's own identical comment on
  -- this exact constraint) rejects immediately, at that second INSERT,
  -- every single time this function ran, on the FIRST call as much as
  -- any later one. This was previously masked by an unrelated 60-byte
  -- (vs. the required 61) ciphertext-envelope bug that failed even
  -- earlier, at the first INSERT — fixed separately; fixing it
  -- unmasked this deeper ordering defect.
  --
  -- The corrected order exactly mirrors the production finalizer's own
  -- documented pattern for the identical problem (old row must leave
  -- 'active' BEFORE the new row can become 'active'): pick
  -- v_terminal_credential_id's id UP FRONT (no row inserted under it
  -- yet), insert v_resulting_credential_id as the one and only 'active'
  -- row, then UPDATE it to 'replaced' — referencing
  -- v_terminal_credential_id via replaced_by_credential_id BEFORE that
  -- row exists, legal only because
  -- qr_credentials_replacement_same_application_fkey is `deferrable
  -- initially deferred` and resolves once the INSERT below actually
  -- creates that row, by commit — and only THEN insert
  -- v_terminal_credential_id as 'active'. At no point do two 'active'
  -- rows for this application_id coexist.
  --
  -- Additionally: retire any 'active' row already left behind by an
  -- EARLIER call to this same function for the SAME application
  -- (seedQualifyingHistory() in tests/attendance/qr-issuance-
  -- reservation.test.ts loops this function once per historical
  -- timestamp for one application) — using the identical UPDATE-before-
  -- INSERT ordering, chaining it in as THIS call's own
  -- v_resulting_credential_id so the seeded history remains a genuinely
  -- valid, connected replacement chain, never a bypass of the
  -- constraint or the trigger.
  select id into v_resulting_credential_id
    from public.qr_credentials
    where application_id = p_application_id and status = 'active'
    limit 1;

  v_terminal_credential_id := gen_random_uuid();

  if v_resulting_credential_id is not null then
    -- Retiring a PRIOR call's leftover active row. reissue_channel must
    -- be set to a "no staff actor" value ('system') here, together with
    -- replaced_by = null, in this SAME statement —
    -- qr_credentials_enforce_lifecycle_trigger's active -> replaced
    -- branch requires replaced_by to be non-null UNLESS reissue_channel
    -- is 'participant_self_service' or 'system' (checked via new.*, the
    -- post-UPDATE row); this leftover row's reissue_channel was never
    -- set at its own insert (it started as a plain synthetic 'active'
    -- row with reissue_channel null), so leaving it null here would
    -- fall through to the "requires non-null replaced_by" branch and
    -- raise.
    update public.qr_credentials
    set status = 'replaced', token_ciphertext = null, encryption_key_version = null,
        replaced_at = p_consumed_at, replaced_by = null, replaced_by_credential_id = v_terminal_credential_id,
        reissue_channel = 'system', reissue_reason_code = p_reissue_reason_code, reissue_note = null
    where id = v_resulting_credential_id;
  else
    -- No prior leftover row for this application — this call's own
    -- v_resulting_credential_id is a fresh synthetic credential, inserted
    -- as 'active' first (the trigger's INSERT guard requires every new
    -- row to begin 'active' with a valid 61-byte ciphertext envelope,
    -- version byte 1, and a currently-active encryption_key_version —
    -- there is no direct-insert-as-'replaced' path, by design).
    v_resulting_credential_id := gen_random_uuid();
    v_envelope := extensions.gen_random_bytes(61);
    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, encryption_key_version,
      status, issuance_channel, issued_at, created_at
    ) values (
      v_resulting_credential_id, p_application_id, extensions.digest(gen_random_uuid()::text, 'sha256'),
      set_byte(v_envelope, 0, 1), v_key_version,
      'active', 'system', p_consumed_at, p_consumed_at
    );

    -- FIX (this round): qr_credentials_enforce_lifecycle_trigger requires
    -- replaced_by to be non-null AND reference a profile holding an
    -- authorized staff role (super_admin/program_attendance_manager)
    -- whenever reissue_channel is not 'participant_self_service'/'system'.
    -- p_requester_auth_user_id is NOT guaranteed to be such a profile —
    -- test_only_seed_staff_consumed_reissue_operation's own callers pass
    -- the PARTICIPANT fixture's own userId here (see
    -- qr-issuance-reservation.test.ts's "staff reissues do not consume
    -- participant self-service quota" test), not a real staff actor; only
    -- the lifecycle-operation row's own p_channel (recorded faithfully
    -- below, on qr_lifecycle_operations, which has no such role-checking
    -- trigger) needs to reflect 'staff_individual' for the cooldown/rate-
    -- limit query's own channel filter to behave correctly. The
    -- CREDENTIAL-level reissue_channel/replaced_by here are purely
    -- synthetic bookkeeping required only to satisfy this trigger and are
    -- never read back by any assertion — always using 'system'/no-actor
    -- semantics here, regardless of p_channel, is honest (no real staff
    -- actor performed this synthetic credential swap) and avoids
    -- depending on p_requester_auth_user_id actually holding a staff role.
    update public.qr_credentials
    set status = 'replaced', token_ciphertext = null, encryption_key_version = null,
        replaced_at = p_consumed_at, replaced_by = null, replaced_by_credential_id = v_terminal_credential_id,
        reissue_channel = 'system', reissue_reason_code = p_reissue_reason_code, reissue_note = null
    where id = v_resulting_credential_id;
  end if;

  -- v_terminal_credential_id is inserted LAST, as the one and only
  -- 'active' row this call leaves behind — legal now because
  -- v_resulting_credential_id (whether freshly inserted above or a
  -- retired prior-call leftover) has already left 'active' status in
  -- the same transaction. It becomes either the input the NEXT call in
  -- the same seeding sequence retires, or, on the last call, the ONE
  -- application_id-scoped 'active' row every caller's own later
  -- insertActiveCredential() call replaces.
  v_envelope := extensions.gen_random_bytes(61);
  insert into public.qr_credentials (
    id, application_id, token_hash, token_ciphertext, encryption_key_version,
    status, issuance_channel, issued_at, created_at
  ) values (
    v_terminal_credential_id, p_application_id, extensions.digest(gen_random_uuid()::text, 'sha256'),
    set_byte(v_envelope, 0, 1), v_key_version,
    'active', 'system', p_consumed_at, p_consumed_at
  );

  v_fingerprint := extensions.digest(v_resulting_credential_id::text || p_consumed_at::text, 'sha256');

  -- FIX (this round): qr_lifecycle_operations_expected_credential_fkey is
  -- a real, non-deferrable composite FK — (expected_current_credential_id,
  -- application_id) must reference an EXISTING public.qr_credentials row
  -- for THIS application. p_expected_current_credential_id, as supplied
  -- by every caller in tests/attendance/qr-issuance-reservation.test.ts
  -- (activeCredentialPlaceholder/placeholderCredential = randomUUID()),
  -- is a synthetic id never backed by a real row — this INSERT always
  -- violated that FK, on every call, in every environment; it was simply
  -- never reached until the two prior fixes in this same round (the
  -- 61-byte envelope size, and the active-row insert/update ordering)
  -- stopped masking it earlier in this same function.
  --
  -- The caller's own placeholder value is confirmed semantically unused:
  -- the cooldown/rolling-rate-limit query this seeded history exists to
  -- exercise (§5.2 step 8, the qualifying-history SELECT ordered by
  -- consumed_at) reads only application_id/operation_type/channel/status/
  -- consumed_at — never expected_current_credential_id — and no test
  -- assertion anywhere reads expected_current_credential_id back off a
  -- row this function creates. p_expected_current_credential_id is
  -- accepted (unchanged signature, so no caller needs to change) but no
  -- longer used for this column: v_terminal_credential_id — a REAL row
  -- for the correct application_id, guaranteed to exist by this exact
  -- point in the function — is used instead, satisfying the FK exactly
  -- as genuinely as a real "current credential" reference would.
  insert into public.qr_lifecycle_operations (
    operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
    channel, request_key, reason_code, note, expected_current_credential_id,
    created_at, expires_at
  ) values (
    'reissue', p_application_id, p_requester_auth_user_id, p_requester_auth_user_id,
    p_channel, gen_random_uuid(), p_reissue_reason_code, null, v_terminal_credential_id,
    p_consumed_at - interval '30 seconds', p_consumed_at + interval '5 minutes'
  ) returning id into v_operation_id;

  update public.qr_lifecycle_operations
  set status = 'consumed', finalized_at = p_consumed_at, consumed_at = p_consumed_at,
      resulting_credential_id = v_resulting_credential_id, finalization_fingerprint = v_fingerprint
  where id = v_operation_id;

  return v_operation_id;
end;
$$;

revoke all on function public.test_only_seed_channeled_consumed_reissue_operation(uuid, uuid, uuid, timestamptz, text, text)
  from public, anon, authenticated, service_role;
-- No grant at all — reachable only through the two channel-specific
-- wrappers below, exactly mirroring the internal/wrapper split used
-- throughout this file's own production-RPC test helpers.

create function public.test_only_seed_consumed_reissue_operation(
  p_application_id uuid,
  p_requester_auth_user_id uuid,
  p_expected_current_credential_id uuid,
  p_consumed_at timestamptz
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select public.test_only_seed_channeled_consumed_reissue_operation(
    p_application_id, p_requester_auth_user_id, p_expected_current_credential_id, p_consumed_at,
    'participant_self_service', 'lost_or_stolen_phone'
  );
$$;

revoke all on function public.test_only_seed_consumed_reissue_operation(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.test_only_seed_consumed_reissue_operation(uuid, uuid, uuid, timestamptz)
  to service_role;

-- ============================================================================
-- 11. test_only_seed_staff_consumed_reissue_operation
-- ============================================================================
-- Identical shape to test_only_seed_consumed_reissue_operation, but seeds
-- a STAFF-channel ('staff_individual') consumed reissue operation instead
-- — used specifically to prove staff reissues do NOT consume participant
-- self-service quota (the cooldown/rate-limit query filters on
-- channel = 'participant_self_service' explicitly).
create function public.test_only_seed_staff_consumed_reissue_operation(
  p_application_id uuid,
  p_requester_auth_user_id uuid,
  p_expected_current_credential_id uuid,
  p_consumed_at timestamptz
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select public.test_only_seed_channeled_consumed_reissue_operation(
    p_application_id, p_requester_auth_user_id, p_expected_current_credential_id, p_consumed_at,
    'staff_individual', 'staff_assisted_recovery'
  );
$$;

revoke all on function public.test_only_seed_staff_consumed_reissue_operation(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.test_only_seed_staff_consumed_reissue_operation(uuid, uuid, uuid, timestamptz)
  to service_role;

-- ============================================================================
-- 12. test_only_hold_then_cancel_bulk_batch
-- ============================================================================
-- CORRECTED this round — REPLACES test_only_hold_bulk_batch_lock entirely
-- (that function is structurally broken and is not merely renamed: a
-- separate service-role session cannot ever UPDATE a row a FOR UPDATE
-- holder is still holding — FOR UPDATE blocks both the reservation RPC's
-- own FOR SHARE read AND any other session's UPDATE against the same
-- row, so the previously proposed "holder blocks the read, a SEPARATE
-- session cancels the batch, then the holder releases" choreography was
-- impossible: the separate session's UPDATE would itself block behind
-- the still-held FOR UPDATE lock, and could never run before the holder
-- released, making the entire scenario either hang until
-- p_max_wait_seconds expires or reduce to an ordinary un-interleaved
-- sequential cancellation with no concurrency actually proven).
--
-- The corrected design performs the cancellation ITSELF, inside the SAME
-- transaction that holds the row lock, before returning — the lock is
-- only ever released at COMMIT (when this function returns and the
-- calling transaction ends), so the reservation RPC's blocked FOR SHARE
-- read only ever unblocks AFTER the cancellation has already been
-- durably applied and committed. This makes "the reservation observes a
-- batch that became unavailable while it was waiting" the ACTUAL
-- happens-before relationship the test proves, rather than an
-- unreachable one.
--
-- Sequence: lock the batch FOR UPDATE; fail clearly if it does not exist
-- or is not initially 'active'; tag application_name AFTER the lock is
-- acquired (same holder-ready-barrier contract as every other holder in
-- this file); poll the explicit release gate (unlocked reads, same
-- bounded-wait pattern as every other holder); once released, perform
-- the legal active -> cancelled transition on the SAME locked row, in
-- the SAME transaction, verify exactly one row was updated, then return
-- — allowing the caller's transaction to commit and the row lock to
-- finally release.
create function public.test_only_hold_then_cancel_bulk_batch(
  p_batch_id uuid,
  p_gate_id uuid,
  p_holder_tag text,
  p_max_wait_seconds numeric default 30
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_locked_id uuid;
  v_locked_status text;
  v_released boolean;
  v_deadline timestamptz;
  v_updated_count integer;
begin
  if p_holder_tag is null or trim(p_holder_tag) = '' then
    raise exception 'test_only_hold_then_cancel_bulk_batch: p_holder_tag is required';
  end if;
  if p_gate_id is null then
    raise exception 'test_only_hold_then_cancel_bulk_batch: p_gate_id is required';
  end if;
  if p_max_wait_seconds is null or p_max_wait_seconds <= 0 then
    raise exception 'test_only_hold_then_cancel_bulk_batch: p_max_wait_seconds must be a positive number';
  end if;
  if p_max_wait_seconds > 300 then
    raise exception 'test_only_hold_then_cancel_bulk_batch: p_max_wait_seconds (%) exceeds the 300-second sanity ceiling for a test helper', p_max_wait_seconds;
  end if;

  select id, status into v_locked_id, v_locked_status
    from public.qr_bulk_operation_batches where id = p_batch_id for update;
  if v_locked_id is null then
    raise exception 'test_only_hold_then_cancel_bulk_batch: qr_bulk_operation_batches row % does not exist — refusing to gate without having locked anything', p_batch_id;
  end if;
  if v_locked_status <> 'active' then
    raise exception 'test_only_hold_then_cancel_bulk_batch: qr_bulk_operation_batches row % is not initially active (status = %) — this helper requires a fresh active batch to cancel', p_batch_id, v_locked_status;
  end if;

  -- Tag AFTER the lock is acquired — this is the exact fact
  -- test_only_is_holder_ready proves by observing the tag.
  perform set_config('application_name', p_holder_tag, true);
  perform public.test_only_register_backend_pid(p_holder_tag);

  v_deadline := clock_timestamp() + make_interval(secs => p_max_wait_seconds);
  loop
    -- UNLOCKED read of the gate row — this transaction already holds the
    -- batch row lock; taking any lock on the gate row here would serve
    -- no purpose and would only complicate the controlling test's own
    -- ability to update it.
    select released into v_released from public.test_only_lock_gates where gate_id = p_gate_id;
    if v_released is null then
      raise exception 'test_only_hold_then_cancel_bulk_batch: gate row % does not exist — the controlling test must insert it before calling this holder', p_gate_id;
    end if;
    if v_released then
      exit;
    end if;
    if clock_timestamp() >= v_deadline then
      raise exception 'test_only_hold_then_cancel_bulk_batch: gate % was never released within % seconds — the controlling test likely has a bug', p_gate_id, p_max_wait_seconds;
    end if;
    perform pg_sleep(0.05);
  end loop;

  -- Cancellation happens HERE, inside this same transaction, while the
  -- row lock is still held — the legal active -> cancelled transition
  -- (qr_bulk_operation_batches_enforce_lifecycle_trigger already
  -- enforces this; no trigger is disabled and no constraint is
  -- weakened). closed_at moves null -> non-null in the same statement,
  -- matching qr_bulk_operation_batches_active_has_no_closed_at/
  -- _closed_requires_closed_at exactly.
  update public.qr_bulk_operation_batches
  set status = 'cancelled', closed_at = clock_timestamp()
  where id = p_batch_id and status = 'active';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'test_only_hold_then_cancel_bulk_batch: expected to cancel exactly 1 row for batch %, actually updated %', p_batch_id, v_updated_count;
  end if;

  return; -- commits on return; the row lock releases only now, at commit
end;
$$;

revoke all on function public.test_only_hold_then_cancel_bulk_batch(uuid, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.test_only_hold_then_cancel_bulk_batch(uuid, uuid, text, numeric)
  to service_role;

-- ============================================================================
-- 13. test_only_request_staff_qr_issuance_short_ttl
-- ============================================================================
-- Mirrors test_only_request_my_qr_issuance_short_ttl's exact shape for
-- staff issuance reservation. Used ONLY for TTL-specific staff issuance
-- tests, where a shortened interval is the actual thing under test.
create function public.test_only_request_staff_qr_issuance_short_ttl(
  p_request_key uuid,
  p_application_id uuid,
  p_issuance_reason_code text,
  p_issuance_note text,
  p_bulk_batch_id uuid,
  p_pending_ttl interval,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_request_staff_qr_issuance_short_ttl: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.request_staff_qr_issuance_transactional_internal(
    p_request_key, p_application_id, p_issuance_reason_code, p_issuance_note, p_bulk_batch_id, p_pending_ttl
  );
  return v_result;
end;
$$;

revoke all on function public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text)
  from public, anon, service_role;
grant execute on function public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text)
  to authenticated;

-- ============================================================================
-- 14. test_only_request_staff_qr_issuance_tagged
-- ============================================================================
-- Exercises the REAL, migrated public production wrapper
-- (request_staff_qr_issuance_transactional(uuid, uuid, text, text, uuid),
-- fixed 5-minute TTL, exactly as deployed) rather than the internal
-- implementation directly — used for staff issuance tests that need
-- deterministic blocking-observation but do NOT need a shortened TTL.
create function public.test_only_request_staff_qr_issuance_tagged(
  p_request_key uuid,
  p_application_id uuid,
  p_issuance_reason_code text,
  p_issuance_note text,
  p_bulk_batch_id uuid,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_request_staff_qr_issuance_tagged: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.request_staff_qr_issuance_transactional(
    p_request_key, p_application_id, p_issuance_reason_code, p_issuance_note, p_bulk_batch_id
  );
  return v_result;
end;
$$;

revoke all on function public.test_only_request_staff_qr_issuance_tagged(uuid, uuid, text, text, uuid, text)
  from public, anon, service_role;
grant execute on function public.test_only_request_staff_qr_issuance_tagged(uuid, uuid, text, text, uuid, text)
  to authenticated;

-- ============================================================================
-- 15. test_only_request_staff_qr_reissue_short_ttl
-- ============================================================================
-- Mirrors test_only_request_staff_qr_issuance_short_ttl's exact shape for
-- staff reissue reservation. Used ONLY for TTL-specific staff reissue
-- tests, where a shortened interval is the actual thing under test.
create function public.test_only_request_staff_qr_reissue_short_ttl(
  p_request_key uuid,
  p_application_id uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_bulk_batch_id uuid,
  p_pending_ttl interval,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_request_staff_qr_reissue_short_ttl: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.request_staff_qr_reissue_transactional_internal(
    p_request_key, p_application_id, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note, p_bulk_batch_id, p_pending_ttl
  );
  return v_result;
end;
$$;

revoke all on function public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text)
  from public, anon, service_role;
grant execute on function public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text)
  to authenticated;

-- ============================================================================
-- 16. test_only_request_staff_qr_reissue_tagged
-- ============================================================================
-- Exercises the REAL, migrated public production wrapper
-- (request_staff_qr_reissue_transactional(uuid, uuid, uuid, text, text, uuid),
-- fixed 5-minute TTL, exactly as deployed) rather than the internal
-- implementation directly — used for staff reissue tests that need
-- deterministic blocking-observation but do NOT need a shortened TTL.
create function public.test_only_request_staff_qr_reissue_tagged(
  p_request_key uuid,
  p_application_id uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_bulk_batch_id uuid,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_request_staff_qr_reissue_tagged: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.request_staff_qr_reissue_transactional(
    p_request_key, p_application_id, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note, p_bulk_batch_id
  );
  return v_result;
end;
$$;

revoke all on function public.test_only_request_staff_qr_reissue_tagged(uuid, uuid, uuid, text, text, uuid, text)
  from public, anon, service_role;
grant execute on function public.test_only_request_staff_qr_reissue_tagged(uuid, uuid, uuid, text, text, uuid, text)
  to authenticated;

-- ============================================================================
-- 18. test_only_finalize_qr_issuance_tagged
-- ============================================================================
-- Exercises the REAL, migrated, service_role-only production finalizer
-- (finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint,
-- smallint), exactly as deployed) with a caller-supplied waiter tag set
-- before the call — used for finalizer concurrency tests that need
-- deterministic blocking-observation (holder-ready / waiter-blocked-by-
-- holder) against the SAME test_only_hold_application_lock/
-- test_only_hold_active_credential_lock holders already established for
-- the reservation RPCs' own tests, reused unchanged here since the
-- finalizer locks the identical rows in the identical modes (application
-- FOR UPDATE at position 2, current active credential FOR UPDATE at
-- position 3).
create function public.test_only_finalize_qr_issuance_tagged(
  p_operation_id uuid,
  p_credential_id uuid,
  p_token_hash bytea,
  p_token_ciphertext bytea,
  p_token_version smallint,
  p_encryption_key_version smallint,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_finalize_qr_issuance_tagged: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.finalize_qr_issuance_for_server(
    p_operation_id, p_credential_id, p_token_hash, p_token_ciphertext, p_token_version, p_encryption_key_version
  );
  return v_result;
end;
$$;

revoke all on function public.test_only_finalize_qr_issuance_tagged(uuid, uuid, bytea, bytea, smallint, smallint, text)
  from public, anon, authenticated;
grant execute on function public.test_only_finalize_qr_issuance_tagged(uuid, uuid, bytea, bytea, smallint, smallint, text)
  to service_role;

-- ============================================================================
-- 19. test_only_cancel_bulk_batch_tagged
-- ============================================================================
-- Tags this backend's application_name, THEN attempts the exact same
-- direct UPDATE (status = 'cancelled', closed_at = clock_timestamp())
-- test_only_hold_then_cancel_bulk_batch itself performs — used to prove
-- the OTHER direction of the finalizer/batch race: once
-- finalize_qr_issuance_for_server has locked the batch row FOR SHARE (at
-- its own position 2, before the application lock), a concurrent
-- attempt to transition that SAME batch to 'cancelled' must block behind
-- the finalizer's hold. This function's own UPDATE only returns once
-- that lock becomes available — the tag is set BEFORE attempting the
-- UPDATE specifically so test_only_is_waiter_blocked_by_holder can prove
-- this backend is blocked, with the FINALIZER's own tag (set via
-- test_only_finalize_qr_issuance_tagged) as the holder.
create function public.test_only_cancel_bulk_batch_tagged(
  p_batch_id uuid,
  p_waiter_tag text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated_count integer;
begin
  if p_batch_id is null then
    raise exception 'test_only_cancel_bulk_batch_tagged: p_batch_id is required';
  end if;
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_cancel_bulk_batch_tagged: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  update public.qr_bulk_operation_batches
  set status = 'cancelled', closed_at = clock_timestamp()
  where id = p_batch_id and status = 'active';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'test_only_cancel_bulk_batch_tagged: expected to cancel exactly 1 row for batch %, actually updated %', p_batch_id, v_updated_count;
  end if;
end;
$$;

revoke all on function public.test_only_cancel_bulk_batch_tagged(uuid, text)
  from public, anon, authenticated;
grant execute on function public.test_only_cancel_bulk_batch_tagged(uuid, text)
  to service_role;

-- ============================================================================
-- 20. test_only_finalize_qr_reissue_tagged
-- ============================================================================
-- Exercises the REAL, migrated, service_role-only production reissue
-- finalizer (finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea,
-- smallint, smallint), exactly as deployed) with a caller-supplied
-- waiter tag set before the call — used for reissue-finalizer
-- concurrency tests that need deterministic blocking-observation against
-- the SAME test_only_hold_application_lock/
-- test_only_hold_active_credential_lock/test_only_hold_then_cancel_bulk_batch
-- holders and test_only_cancel_bulk_batch_tagged already established for
-- the issuance finalizer's own tests (all REUSED UNCHANGED — the reissue
-- finalizer locks the identical batch/application/current-active-
-- credential rows in the identical FOR SHARE/FOR UPDATE modes).
create function public.test_only_finalize_qr_reissue_tagged(
  p_operation_id uuid,
  p_new_credential_id uuid,
  p_new_token_hash bytea,
  p_new_token_ciphertext bytea,
  p_new_token_version smallint,
  p_new_encryption_key_version smallint,
  p_waiter_tag text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result public.qr_credential_lifecycle_result;
begin
  if p_waiter_tag is null or trim(p_waiter_tag) = '' then
    raise exception 'test_only_finalize_qr_reissue_tagged: p_waiter_tag is required';
  end if;
  perform set_config('application_name', p_waiter_tag, true);
  perform public.test_only_register_backend_pid(p_waiter_tag);

  select * into v_result from public.finalize_qr_reissue_for_server(
    p_operation_id, p_new_credential_id, p_new_token_hash, p_new_token_ciphertext, p_new_token_version, p_new_encryption_key_version
  );
  return v_result;
end;
$$;

revoke all on function public.test_only_finalize_qr_reissue_tagged(uuid, uuid, bytea, bytea, smallint, smallint, text)
  from public, anon, authenticated;
grant execute on function public.test_only_finalize_qr_reissue_tagged(uuid, uuid, bytea, bytea, smallint, smallint, text)
  to service_role;

-- ============================================================================
-- 21. test_only_hold_key_registry_lock
-- ============================================================================
-- NEW this round, for the TTL-vs-key-registry-lock correction. Locks the
-- target qr_encryption_key_registry row FOR UPDATE — conflicts with
-- is_encryption_key_version_active()'s own FOR SHARE read, which both
-- finalizers take at their respective position-5 locks — tags this
-- backend's application_name with the caller-supplied holder tag ONLY
-- AFTER the lock is acquired, then polls its gate row (with a generous,
-- explicitly validated bounded maximum wait) until released. Identical
-- shape to test_only_hold_active_credential_lock/
-- test_only_hold_application_lock.
create function public.test_only_hold_key_registry_lock(
  p_key_version smallint,
  p_gate_id uuid,
  p_holder_tag text,
  p_max_wait_seconds numeric default 30
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_locked_version smallint;
  v_released boolean;
  v_deadline timestamptz;
begin
  if p_holder_tag is null or trim(p_holder_tag) = '' then
    raise exception 'test_only_hold_key_registry_lock: p_holder_tag is required';
  end if;
  if p_gate_id is null then
    raise exception 'test_only_hold_key_registry_lock: p_gate_id is required';
  end if;
  if p_max_wait_seconds is null or p_max_wait_seconds <= 0 then
    raise exception 'test_only_hold_key_registry_lock: p_max_wait_seconds must be a positive number';
  end if;
  if p_max_wait_seconds > 300 then
    raise exception 'test_only_hold_key_registry_lock: p_max_wait_seconds (%) exceeds the 300-second sanity ceiling for a test helper', p_max_wait_seconds;
  end if;

  select key_version into v_locked_version from public.qr_encryption_key_registry
    where key_version = p_key_version for update;
  if v_locked_version is null then
    raise exception 'test_only_hold_key_registry_lock: qr_encryption_key_registry row for key_version % does not exist — refusing to gate without having locked anything', p_key_version;
  end if;

  -- Tag AFTER the lock is acquired — this is the exact fact
  -- test_only_is_holder_ready proves by observing the tag.
  perform set_config('application_name', p_holder_tag, true);
  perform public.test_only_register_backend_pid(p_holder_tag);

  v_deadline := clock_timestamp() + make_interval(secs => p_max_wait_seconds);
  loop
    select released into v_released from public.test_only_lock_gates where gate_id = p_gate_id;
    if v_released is null then
      raise exception 'test_only_hold_key_registry_lock: gate row % does not exist — the controlling test must insert it before calling this holder', p_gate_id;
    end if;
    if v_released then
      return; -- releases the key-registry row lock as this transaction ends
    end if;
    if clock_timestamp() >= v_deadline then
      raise exception 'test_only_hold_key_registry_lock: gate % was never released within % seconds — the controlling test likely has a bug', p_gate_id, p_max_wait_seconds;
    end if;
    perform pg_sleep(0.05);
  end loop;
end;
$$;

revoke all on function public.test_only_hold_key_registry_lock(smallint, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function public.test_only_hold_key_registry_lock(smallint, uuid, text, numeric)
  to service_role;

-- ============================================================================
-- 22. test_only_fk_fault_injector (trigger function) +
--     test_only_fk_fault_injector_trigger (BEFORE INSERT trigger on
--     public.audit_logs)
-- ============================================================================
-- CORRECTED this round: renamed from test_only_unrelated_fk_fault_injector
-- and EXTENDED to support TWO exact application_name prefixes, so it can
-- deterministically inject BOTH the one EXPECTED foreign_key_violation
-- (qr_credentials_replacement_same_application_fkey — the forced-IMMEDIATE
-- deferred same-application replacement FK the finalizer's own mapping
-- explicitly expects) and an UNRELATED one, each from the SAME real
-- production audit_logs insert reached inside the real
-- finalize_qr_reissue_for_server atomic block (never a copy of its
-- exception-handling logic, which would only prove a duplicate works and
-- could silently diverge from production):
--
--   'test-only-expected-fk:' — raises SQLSTATE 23503,
--     constraint_name = 'qr_credentials_replacement_same_application_fkey',
--     message containing that exact constraint name. Proves the
--     finalizer's narrowed mapping correctly converts THIS SPECIFIC,
--     BY-NAME-MATCHED constraint to idempotency_conflict.
--
--   'test-only-unrelated-fk:' — raises SQLSTATE 23503,
--     constraint_name = 'test_only_unrelated_foreign_key', message
--     containing that exact constraint name. Proves the finalizer
--     re-raises every OTHER foreign_key_violation rather than converting
--     it.
--
-- Scoped EXCLUSIVELY by these two dedicated backend application_name
-- prefixes — for any other application_name (every ordinary test), the
-- trigger immediately returns NEW with no effect whatsoever, including
-- no extra read/lock beyond the one current_setting() call.
create function public.test_only_fk_fault_injector()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_app_name text;
begin
  v_app_name := coalesce(current_setting('application_name', true), '');
  if left(v_app_name, char_length('test-only-expected-fk:')) = 'test-only-expected-fk:' then
    raise exception using
      errcode = '23503',
      message = 'test_only_fk_fault_injector: deliberately injected qr_credentials_replacement_same_application_fkey',
      constraint = 'qr_credentials_replacement_same_application_fkey';
  end if;
  if left(v_app_name, char_length('test-only-unrelated-fk:')) = 'test-only-unrelated-fk:' then
    raise exception using
      errcode = '23503',
      message = 'test_only_fk_fault_injector: deliberately injected test_only_unrelated_foreign_key',
      constraint = 'test_only_unrelated_foreign_key';
  end if;
  return new;
end;
$$;

revoke all on function public.test_only_fk_fault_injector() from public, anon, authenticated;
grant execute on function public.test_only_fk_fault_injector() to service_role;

create trigger test_only_fk_fault_injector_trigger
  before insert on public.audit_logs
  for each row
  execute function public.test_only_fk_fault_injector();

-- ============================================================================
-- 23. test_only_create_bulk_batch_with_expiry
-- ============================================================================
-- qr_bulk_operation_batches_enforce_lifecycle_trigger (frozen, unmodified
-- here) makes expires_at immutable once a row exists — by design, the
-- exact same discipline as every other timestamp-shaped identity field on
-- every lifecycle table in this suite. create_qr_bulk_operation_batch_for_server
-- (the real production RPC, also unmodified) has no expiry parameter at
-- all — it always sets a fixed forward-looking TTL from the moment of
-- creation. Neither path offers any legitimate way to construct an
-- ALREADY-EXPIRED batch for testing bulk_batch_unavailable's
-- expiry-specific branch, and a direct UPDATE of expires_at after
-- insertion (attempted by two earlier tests in this suite) is correctly
-- rejected by the trigger — proving the trigger works, not a bug in it.
--
-- This helper creates a genuinely valid, fully-constraint-satisfying
-- 'active' batch whose expires_at is supplied by the caller and is
-- already in the past AT INSERT TIME — never mutated afterward. Honors
-- qr_bulk_operation_batches_expires_after_created (expires_at >
-- created_at) by setting created_at to a moment strictly before the
-- caller-supplied expires_at, not by relying on now().
create function public.test_only_create_bulk_batch_with_expiry(
  p_created_by_auth_user_id uuid,
  p_created_by_profile_id uuid,
  p_intended_operation_type text,
  p_expires_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch_id uuid;
  v_created_at timestamptz;
begin
  if p_created_by_auth_user_id is null then
    raise exception 'test_only_create_bulk_batch_with_expiry: p_created_by_auth_user_id is required';
  end if;
  if p_intended_operation_type not in ('issue', 'reissue') then
    raise exception 'test_only_create_bulk_batch_with_expiry: p_intended_operation_type must be issue or reissue';
  end if;
  if p_expires_at is null then
    raise exception 'test_only_create_bulk_batch_with_expiry: p_expires_at is required';
  end if;

  -- Strictly before p_expires_at, satisfying the CHECK constraint
  -- regardless of how far in the past the caller's p_expires_at already
  -- is.
  v_created_at := p_expires_at - interval '1 minute';

  insert into public.qr_bulk_operation_batches (
    created_by_auth_user_id, created_by_profile_id, intended_operation_type,
    status, created_at, expires_at
  ) values (
    p_created_by_auth_user_id, p_created_by_profile_id, p_intended_operation_type,
    'active', v_created_at, p_expires_at
  ) returning id into v_batch_id;

  return v_batch_id;
end;
$$;

revoke all on function public.test_only_create_bulk_batch_with_expiry(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.test_only_create_bulk_batch_with_expiry(uuid, uuid, text, timestamptz)
  to service_role;
