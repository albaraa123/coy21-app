-- tests/attendance/qr-issuance-reservation.test-only-teardown.sql
--
-- Run immediately after the suite finishes, against the SAME disposable
-- local instance the setup file was applied to:
--
--   supabase db query --local -f tests/attendance/qr-issuance-reservation.test-only-teardown.sql
--
-- DROP FUNCTION/TABLE IF EXISTS are unconditionally safe (no-op when
-- absent) and remove any grants along with the object. All statements run
-- unconditionally, regardless of how much of setup actually completed.
drop trigger if exists test_only_fk_fault_injector_trigger on public.audit_logs;
drop function if exists public.test_only_fk_fault_injector();
drop function if exists public.test_only_create_bulk_batch_with_expiry(uuid, uuid, text, timestamptz);
drop function if exists public.test_only_register_backend_pid(text);
drop table if exists public.test_only_backend_pids;
drop function if exists public.test_only_hold_key_registry_lock(smallint, uuid, text, numeric);
drop function if exists public.test_only_finalize_qr_reissue_tagged(uuid, uuid, bytea, bytea, smallint, smallint, text);
drop function if exists public.test_only_cancel_bulk_batch_tagged(uuid, text);
drop function if exists public.test_only_finalize_qr_issuance_tagged(uuid, uuid, bytea, bytea, smallint, smallint, text);
drop function if exists public.test_only_request_staff_qr_reissue_tagged(uuid, uuid, uuid, text, text, uuid, text);
drop function if exists public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text);
drop function if exists public.test_only_request_staff_qr_issuance_tagged(uuid, uuid, text, text, uuid, text);
drop function if exists public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text);
drop function if exists public.test_only_hold_then_cancel_bulk_batch(uuid, uuid, text, numeric);
drop function if exists public.test_only_seed_staff_consumed_reissue_operation(uuid, uuid, uuid, timestamptz);
drop function if exists public.test_only_seed_consumed_reissue_operation(uuid, uuid, uuid, timestamptz);
drop function if exists public.test_only_seed_channeled_consumed_reissue_operation(uuid, uuid, uuid, timestamptz, text, text);
drop function if exists public.test_only_request_my_qr_reissue_tagged(uuid, uuid, text, text, text);
drop function if exists public.test_only_request_my_qr_reissue_short_ttl(uuid, uuid, text, text, interval, text);
drop function if exists public.test_only_request_my_qr_issuance_tagged(uuid, text);
drop function if exists public.test_only_request_my_qr_issuance_short_ttl(uuid, interval, text);
drop function if exists public.test_only_is_waiter_blocked_by_holder(text, text);
drop function if exists public.test_only_is_holder_ready(text);
drop function if exists public.test_only_hold_application_lock(uuid, uuid, text, numeric);
drop function if exists public.test_only_hold_application_lock_and_mutate_status(uuid, uuid, text, text, numeric);
drop function if exists public.test_only_hold_reservation_domain_advisory_lock(uuid, text, uuid, text, numeric);
drop function if exists public.test_only_hold_active_credential_lock(uuid, uuid, text, numeric);
drop function if exists public.test_only_release_lock_gate(uuid);
drop function if exists public.test_only_current_timestamp();
drop table if exists public.test_only_lock_gates;
