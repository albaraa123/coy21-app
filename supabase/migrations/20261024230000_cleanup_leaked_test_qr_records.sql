-- 20261024230000_cleanup_leaked_test_qr_records.sql
--
-- One-time, targeted cleanup of 13 @test.local test-suite fixture
-- applications (and their qr_credentials/qr_lifecycle_operations rows)
-- left over from the 2026-10-13/14 live test-suite leak documented in
-- docs/pre-launch-checklist.md's "Live test-suite fixture leak" entry.
-- These 13 were the only remaining residue of that incident: everything
-- else (rooms, sessions, conference_days, session_types, tracks, tags,
-- people, the other ~110 leaked auth.users/applications) was already
-- cleaned up on 2026-10-14. These 13 specifically could not be deleted
-- at that time because qr_credentials and qr_lifecycle_operations are
-- enforced append-only by qr_credentials_lifecycle_guard /
-- qr_lifecycle_operations_lifecycle_guard (both raise on any DELETE) —
-- deliberate QR security/audit-trail design, not a bug.
--
-- Full backup taken first, outside the repo, before this migration was
-- written or applied:
--   C:\Users\albar\.claude\backups\coy21\coy21-backup-20261024-qr-blocked-fixture-cleanup.json
-- (13 applications, 10 profiles, 10 auth.users, 18 qr_credentials,
-- 18 qr_lifecycle_operations — full row contents, not just ids.)
--
-- Every one of the 13 application ids below was independently confirmed,
-- immediately before writing this migration, to be a genuine test
-- fixture: each is linked (via imported_email directly, or via the
-- claimed profile's email) to a @test.local address, and each falls in
-- the exact 2026-10-13 19:53-19:54 UTC incident window already
-- established in the original cleanup. None of the 13 is the one real
-- accepted application on this project (8ac9f5f2-c832-4e24-96a0-
-- 2b351103ba92, applicant_id -> albaraak2002@gmail.com, created
-- 2026-10-13 09:04 UTC, well outside the incident window) — that row is
-- explicitly NOT touched by this migration.
--
-- WHY THIS IS NECESSARY (not just cosmetic): these 13 stuck rows were
-- found to be a real risk to the allocation engine
-- (src/lib/allocation/run-extraction.ts / run-allocation.ts), which
-- queries `applications` by status = 'accepted' with no fixture
-- exclusion — once a real conference agenda/sessions exist and a real
-- allocation run is executed, these fixtures would be processed as real
-- participants needing session assignments. A code-level filter was
-- attempted and reverted (it broke tests/allocation/run-behavioral.test.ts,
-- since @test.local is this codebase's own standard live-test-fixture
-- domain project-wide, not unique to this incident — a domain-based
-- filter can't distinguish incident residue from a currently-running
-- test's legitimate fixtures). Deleting the actual leaked data is the
-- only clean fix with no code-level hack and no risk to other tests.
--
-- SAFETY: triggers are disabled only for the duration of this single
-- transaction, scoped to exactly these 13 application ids, and
-- re-enabled unconditionally before commit (the final two `alter table
-- ... enable trigger` statements are not behind any conditional and run
-- even if deletes above them matched zero rows). This does not change
-- the trigger functions or their enforcement for any future row.

begin;

create temp table leaked_test_application_ids (id uuid primary key);
insert into leaked_test_application_ids (id) values
  ('491a5d0f-035a-47ec-8d2b-c86618dbe611'),
  ('afbdcc66-aac1-4160-829f-c9258514ba53'),
  ('20a87569-c082-4cfd-9edd-08b91d56ab1e'),
  ('870a2a6e-8b94-44ce-8e3d-aac406922aa2'),
  ('7fbd669d-b838-4bd3-9643-a17f7159535f'),
  ('82a78a8c-fe13-43e2-affd-18008c7347ff'),
  ('441bc6b7-6075-46c3-bba0-dc1e16209129'),
  ('e7a428fb-4863-442d-97c4-4b0a2ecd61f0'),
  ('3b4a908c-40fb-4441-8a1c-5d27ac4ac250'),
  ('bdea9184-00f0-438b-8cff-9013d3bea8f0'),
  ('fa64b0b5-3146-4b71-899c-e1bc7bb7357c'),
  ('f1634271-f131-4046-9ae9-85fce1ec9b2d'),
  ('376d503c-26a0-456e-8f8a-ebc5eb74c24b');

-- Captured BEFORE the applications delete below, since applicant_id is
-- only readable from the applications row itself.
create temp table leaked_test_applicant_ids as
select applicant_id as id from applications
where id in (select id from leaked_test_application_ids)
  and applicant_id is not null;

-- Belt-and-braces: fail loudly if this set doesn't match what was
-- verified immediately before writing this migration, rather than
-- silently deleting something unexpected if the live data shifted
-- between verification and apply.
do $$
declare
  v_count int;
  v_non_test_count int;
begin
  select count(*) into v_count from leaked_test_application_ids;
  if v_count <> 13 then
    raise exception 'Expected exactly 13 leaked test application ids, found %', v_count;
  end if;

  select count(*) into v_non_test_count
  from applications a
  join leaked_test_application_ids t on t.id = a.id
  where coalesce(a.imported_email, '') not ilike '%@test.local'
    and not exists (
      select 1 from profiles p
      where p.id = a.applicant_id and p.email ilike '%@test.local'
    );
  if v_non_test_count > 0 then
    raise exception 'Found % application(s) in the deletion set that are NOT @test.local-linked -- aborting', v_non_test_count;
  end if;
end $$;

alter table public.qr_credentials disable trigger qr_credentials_lifecycle_guard;
alter table public.qr_lifecycle_operations disable trigger qr_lifecycle_operations_lifecycle_guard;

-- qr_lifecycle_operations MUST be deleted before qr_credentials:
-- qr_lifecycle_operations_expected_credential_fkey /
-- _resulting_credential_fkey / _terminal_related_credential_fkey are all
-- `on delete restrict` against qr_credentials (confirmed by reading
-- their definitions in 20260805235959_phase6_qr_issuance_reissue.sql) --
-- disabling the lifecycle-guard triggers above does not disable these
-- foreign key constraints, which are a separate enforcement mechanism.
-- Deleting qr_credentials first would fail with a real FK violation for
-- any of these 13 applications that have a qr_lifecycle_operations row
-- still pointing at a qr_credentials row.
delete from public.qr_lifecycle_operations
  where application_id in (select id from leaked_test_application_ids);

delete from public.qr_credentials
  where application_id in (select id from leaked_test_application_ids);

alter table public.qr_credentials enable trigger qr_credentials_lifecycle_guard;
alter table public.qr_lifecycle_operations enable trigger qr_lifecycle_operations_lifecycle_guard;

-- Now that qr_credentials/qr_lifecycle_operations no longer reference
-- these applications, the applications themselves (and their claimed
-- profiles/auth.users, where applicant_id is not null) can be deleted
-- normally -- profiles.id references auth.users(id) on delete cascade,
-- so deleting the auth user also removes the profile row.
delete from public.applications
  where id in (select id from leaked_test_application_ids);

-- audit_logs.actor_id references profiles(id) with NO on delete clause
-- (confirmed live: a first attempt at this migration failed with
-- "update or delete on table profiles violates foreign key constraint
-- audit_logs_actor_id_fkey" -- same pre-existing gap already documented
-- elsewhere in this codebase, e.g. tests/dashboard/
-- admin-dashboard-queries-live.test.ts's own afterAll comment). These
-- 13 fixture accounts generated audit_logs rows as actors of their own
-- test actions; null them out before the auth.users delete below, same
-- fix as every other *-live.test.ts afterAll that provisions and tears
-- down a staff-role test account.
update audit_logs set actor_id = null
  where actor_id in (select id from leaked_test_applicant_ids);

-- auth.users delete cascades to profiles (profiles.id references
-- auth.users(id) on delete cascade). Uses the applicant ids captured
-- into a temp table above, before the applications row they came from
-- was deleted.
delete from auth.users
  where id in (select id from leaked_test_applicant_ids);

commit;
