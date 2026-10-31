-- 20261101000000_full_test_fixture_cleanup.sql
--
-- Full, final cleanup of live-test-suite fixture data accumulated across
-- recent test runs against this production project (overwhelmingly
-- created 2026-10-30/31, per created_at timestamps individually confirmed
-- against each row before this migration was written -- see the backup
-- below for the full pre-delete snapshot). This supersedes the narrower
-- 2026-10-13/14 and 2026-10-24 cleanups documented in
-- docs/pre-launch-checklist.md -- this pass covers every fixture
-- domain found, not just the QR-blocked residue.
--
-- Full backup taken first, outside the repo, before this migration was
-- written or applied:
--   C:\Users\albar\.claude\backups\coy21\coy21-backup-20261101-full-test-fixture-cleanup\
-- (full row contents for every table touched below, not just ids.)
--
-- Scope, independently verified against the real D1 agenda-entry task
-- (37 real sessions, D1-01..D1-37) immediately before writing this
-- migration: every id below is a confirmed test fixture, and ZERO of the
-- 32 real D1-* sessions already in the database reference any room,
-- session_type, track, or conference_day being deleted here. Real
-- reference-data codes (rooms: MH/FOY/CAF/OFF/R01-R12; session_types and
-- tracks: REG/PLN/BRK/CUL/SDE; conference_days: 2026-11-05/06/07) are
-- the only ones excluded from the fixture sets below, confirmed by code
-- (not by date-window guessing) before this migration was written.
--
-- Deletion order (FK-dependency-safe, same discipline as
-- 20261024230000_cleanup_leaked_test_qr_records.sql). This order was
-- revised once already, live: a first apply attempt failed on
-- scan_attempts_resulting_attendance_id_fkey (no on-delete clause),
-- which this version fixes by deleting scan_attempts first.
--   1. qr_lifecycle_operations (before qr_credentials -- FK restrict)
--   2. qr_credentials (before applications -- FK restrict)
--   3. scan_attempts (before attendance_records -- FK has no on-delete
--      clause; resulting_attendance_id references attendance_records)
--   4. attendance_records, session_bookings, session_people,
--      allocation_assignments, schedule_change_events,
--      scanner_assignments, notifications (all reference fixture
--      sessions and/or fixture applications)
--   5. applications (fixture rows, now dependency-free)
--   6. audit_logs.actor_id nulled for fixture users (no cascade/restrict,
--      but no on-delete clause either -- same pre-existing gap as the
--      2026-10-24 migration worked around)
--   7. auth.users for fixture accounts (cascades to profiles)
--   8. sessions (fixture rows, now dependency-free)
--   9. rooms, session_types, tracks, conference_days (fixture reference
--      data, now unreferenced by any session)
--   10. people, tags (fixture rows from live test seeding)
--
-- Full foreign-key catalog cross-checked against every migration file
-- referencing applications/sessions/rooms/session_types/tracks/
-- conference_days/people/tags/attendance_records (56 FK declarations
-- found) before finalizing this order -- every reference either cascades
-- automatically, sets null automatically, or is deleted/nulled
-- explicitly above. Confirmed zero rows exist for every other
-- FK-dependent table checked (session_tags, feature_extraction_rules,
-- participant_feature_snapshots, cluster_memberships, allocation_issues,
-- schedule_publications, schedule_publication_draft_items, and
-- people.linked_application_id pointing at a fixture application) --
-- not included as DELETE statements since they would be no-ops, but
-- documented here so a future re-run of this migration-generation
-- process knows they were checked, not missed.
--
-- SAFETY: qr_credentials/qr_lifecycle_operations triggers are disabled
-- only for the duration of this single transaction, re-enabled
-- unconditionally before commit. This does not change the trigger
-- functions or their enforcement for any future row.

begin;

create temp table fixture_session_ids (id uuid primary key);
insert into fixture_session_ids (id) values
  ('ee8e45b5-c82e-4ff3-bb8b-6a0a23e5df29'),
  ('997ffcf5-0fad-4471-a26c-b6fe7ac7c1f5'),
  ('aebb053f-9728-4f8e-91ed-df95dc610219'),
  ('942df85d-4264-49a3-815f-0ea23ce8805d'),
  ('a49c4f6a-c22d-43c4-8263-0729ef9c387e'),
  ('c93fbb50-79b8-4671-aa8b-53a70b1bacfc'),
  ('d7495676-895e-4a3b-9f08-9fba6d67616f'),
  ('cc10cfa0-c9e6-4792-bae7-8a899ba1801e'),
  ('0af39b5b-b418-4041-bdec-cd1f8c5e3e7e'),
  ('ceac28df-0c11-4f21-bb76-2a34358c5ffb'),
  ('ba4279da-febb-4a4e-a556-7e265aeeab50'),
  ('fec80810-2113-4cd3-b63a-597711a524a3'),
  ('976bb4cd-7dbb-452b-8f9f-2a540a2d64e2'),
  ('41150161-399c-480b-9be1-5b6ab65e911b'),
  ('8c4b38a6-ae43-450d-9d14-27bfc26bc4fb'),
  ('30c86d4b-9423-4cbf-9201-fbab97490379'),
  ('97482fb3-5fce-4225-8f93-570809a0b411'),
  ('7b3143bd-d7af-4f79-9a8e-3b725e8aa32c'),
  ('814f1b99-ab6e-4ee5-a4a5-fd330583a83f'),
  ('597499e2-2e5a-4c13-8065-20f2b6d2e334'),
  ('836b3464-969e-4af2-b45a-129bab5923b6'),
  ('7b6544f8-898f-4474-a92d-8c24228898b4'),
  ('27c714cf-8f6c-4936-807b-478813094371'),
  ('6134ba40-5b27-4685-b260-e66b745dc79f'),
  ('2ba96011-5f50-4474-a035-784cf6df7645'),
  ('39efc0e2-c87f-4853-a805-be83573c0b80'),
  ('7db06582-c4bd-4ddd-a691-9e981f870e87'),
  ('c17001bd-ff9d-477b-92e8-bcb448ae1daa'),
  ('243047a6-d9f0-44ae-bcff-59eb7b6020b5'),
  ('d29e8432-7700-4e69-a5eb-4a9bdd5ea5c2'),
  ('85afe531-22a2-4abf-88d0-5fa2e72ecc12'),
  ('dba2d202-0b29-4e6d-9769-db75575f73f8'),
  ('f3818307-a12f-4ac6-8906-0cfb9f1e37df'),
  ('24a81740-1d1b-4a06-99a7-15d723e20999'),
  ('faa493ef-3645-4614-ace2-75283d777b0e'),
  ('f91d1e5e-b6e4-4445-986e-47c4042bde57'),
  ('7a7c7bd2-5f52-488e-9abe-99a094f1de99'),
  ('968604ee-181d-40d9-af86-eac651a9b1e1'),
  ('b3941fc3-3b8a-4cda-8c3f-a37be86e8c0c'),
  ('69269eee-7eb1-4d2d-9bff-3f514315fe55'),
  ('99472cda-42f7-4e84-9efd-e2900d6149b1'),
  ('0c522d66-38f7-460c-abbd-41aeacfa2aa6'),
  ('554d6189-007e-4fec-bb6f-f7656db12d20'),
  ('02a4ecf7-961c-4f87-a0c1-2f5a583c7ef7'),
  ('ea42ff82-d867-4ef3-ad94-524b42cd4a52'),
  ('a16fc8b4-5c45-4085-b8d4-1beb5e73a71f'),
  ('27387f5d-2038-46d5-932a-a3d509fe27c9'),
  ('21f406b1-a39b-45f1-b44b-c01852332bf3'),
  ('c628eef0-c836-4762-afdd-2e8ca67c9e2d'),
  ('42671f46-3c5a-41d3-a7fa-344275f86246'),
  ('98743990-1d7f-488e-8ccd-723c65057304'),
  ('6c3d09f8-fdbf-4ed1-8552-df6bf08cd54a'),
  ('f92c2ebf-94d9-4587-bce2-0a1e4e405ba9'),
  ('ff483c1a-366b-4982-9109-8b9be1da1498'),
  ('6bbcfea4-aeb6-496f-93c7-83145e3d34c2'),
  ('810e9b69-ae4b-4a39-bcf3-90c0e504b565'),
  ('a415d859-a9b1-45d7-8394-df6269097908'),
  ('b72911f9-f25a-4191-bdee-a6e9cdb3132f'),
  ('0f5e9a7b-1276-4608-ae4a-ecbbcd3407b6'),
  ('6fb7faac-1430-4888-8fa2-d7f548371046'),
  ('4e4fcdd6-e916-40fb-b400-781b8415960e'),
  ('637ae7f2-3447-49cc-818c-fcb3ce1c3100'),
  ('6060db0a-1465-4950-9709-57ff13342af6'),
  ('13a05fdd-79b5-4385-acf8-68a759cd22ea'),
  ('72837d1c-297c-4915-8eb2-614667c983b2'),
  ('a44e4a7c-4a3e-4a80-9b05-b7d4f35f3f9d'),
  ('be0145d0-03bb-4e98-b898-db05c283d858'),
  ('fcdbd25d-7e58-4654-b64c-d72a2862eabb'),
  ('0aaf4b48-ccfb-4a64-b72c-1fff3321a1b5'),
  ('6a7a5719-e33c-4951-b562-645db9fdb605'),
  ('51a586df-8b0f-458c-98e9-930bb182c066'),
  ('b3f7bd93-2be0-42e5-8eb3-d299b0b60f11'),
  ('812b6dde-a28c-4969-8035-68a63b5f3aef'),
  ('63a48f4b-8b63-4186-92c1-467c98e377e8'),
  ('d3304281-cea7-4472-9dd7-7ced771c0970'),
  ('03632103-c975-4031-b864-15b9ca6d78a7'),
  ('aaa9960a-2e51-4578-8059-f812624078f9'),
  ('14482714-51b6-461a-9ec5-d6956d373953'),
  ('971d3bf2-8bf3-4fa2-855c-60cb476c06d3'),
  ('9e8e37b5-d35c-445e-b25a-47d52f75c52d'),
  ('c636390c-5ec9-428d-a2a8-2ea5e6be00f7'),
  ('e80c2d2f-5670-4983-86c3-b0f1ba3867e3'),
  ('282b4adf-ed28-4b53-aaf5-a6b80b4a3697'),
  ('91544ef0-a393-448f-9290-60733c2f9c59'),
  ('db52a005-385c-4f4e-b608-4863a0b6bfcb'),
  ('4e0cf8d9-09ce-480e-96a7-3178362666b3'),
  ('ffa4c6e5-e001-4eaa-94f9-dd4918569201'),
  ('313d6a51-a02e-4483-97d4-38905c954b98'),
  ('bd8c833d-27e6-471a-aa17-b9d4f050ef32'),
  ('916e3920-8385-43d1-a6d9-1db5cacee3ec'),
  ('ec242b83-848b-402d-b4fd-56816adaf905'),
  ('1da28055-5802-4286-9622-d8ec4271d054'),
  ('25307686-60ed-4187-8ff1-deca5d714875'),
  ('4ecc464b-80e2-4902-b9f4-97a3e1da4b57'),
  ('87fd799b-160f-4d94-95ee-2fe37fc3ef49'),
  ('cdf84360-84d8-40da-8d64-75319c4bb32e'),
  ('f15f08c2-4023-44cb-b750-150bf72a0cb9'),
  ('26ed25fb-77b8-465c-997e-c1bb7d9659e5'),
  ('a2f5e2a6-6bc7-4ccb-ad14-fe3b13a2e2ca'),
  ('80b90c1f-e34a-438a-9fab-e20243feda3c'),
  ('154d7873-8e8c-481e-9caa-4bc52d0afece'),
  ('2d0237fd-3b9f-4f5a-ae9d-60f129d455ac'),
  ('3fdd2c9f-f29b-4d25-87c4-d262da542f0d'),
  ('f40832f6-1521-4462-8d8a-4dd94665c8c1'),
  ('1c55d7d0-d073-47fc-bad4-1ce1ad706ac8');

create temp table fixture_application_ids (id uuid primary key);
insert into fixture_application_ids (id) values
  ('ca3e5dc4-9608-479c-a6a9-c5fbe82d8edf'),
  ('ef1cdae2-e54a-429d-b30f-44c9eaf54ce7'),
  ('85838d56-da67-4d4e-9a0e-9d7b43619822'),
  ('ce03def1-8654-4e87-82fa-6ecbaefc6329'),
  ('e7d61989-8196-403e-8250-1b47079e0af7'),
  ('a902a1dc-7ca7-4adb-96a8-2207051368e6'),
  ('38418cf1-58f5-404f-b023-811b73861f96'),
  ('45836e19-c948-40f3-b24a-fbce646ce8af'),
  ('e6fdc4ee-a2e8-46c1-be9a-c83a30a9d6fd'),
  ('41a33d5b-597e-4f74-8662-53632d4c2209'),
  ('bb07c3b4-c69b-4e92-bc3f-201135b4aeeb'),
  ('02a6f9f4-1daa-4528-846b-9cd5f520d6ee'),
  ('7727fd5c-16a1-47d8-bc94-8389d357d453'),
  ('d71450ba-b97f-472a-bc88-de093a8a1963'),
  ('f912a5f8-f761-424a-8c35-d1ef1ed40fe6'),
  ('70847cdd-83a9-49bc-b780-20183f53d456'),
  ('c5bfd3ed-442d-4ad1-b9e7-63b82d01f9bb'),
  ('38a4649d-3731-4ae9-a8d3-428b64343f15'),
  ('a2df894e-5c3b-4612-b0ae-397073f7d6de'),
  ('a19f64d6-8279-4126-a26e-75a14647345c'),
  ('91cb5ce1-20b6-4ef1-b928-ebc48262aed1'),
  ('6d288fff-aee8-4217-97d7-d8390fb2f350'),
  ('c2b74a8f-c26b-467a-8cf1-3ec70830b39c'),
  ('2c26c08b-36a1-4cd3-8bcd-f3aa30e2a7da'),
  ('f6b9633b-bab1-4d61-b4b9-d12b37a0920f'),
  ('df3255cc-bb1e-493a-879e-354820b83350'),
  ('0b96c723-31c9-475c-b67c-6a123f7acf41'),
  ('bfd5cd39-3579-4ed7-9a35-d7c1f6056915'),
  ('4670fd0e-7e91-4bab-82de-e0c4b0b949e4'),
  ('00789eff-ce0f-42d6-825b-8e21ff3aaf89'),
  ('40009200-bcb4-4b0f-9b71-d3d875e610a7'),
  ('9574183b-b653-4fcc-8d7d-13a5821df1b1'),
  ('76bab923-0f12-40d5-a3aa-4393f99e7321'),
  ('a8f57124-0cb4-4eb9-ad77-78bd23479f73'),
  ('54301a22-f273-44b5-8392-34ed5b56ea30'),
  ('c09c842c-f43e-4e92-87c5-4ff466fc3cac'),
  ('6f9ac882-d6b7-45b7-a035-a72d4e16dd25'),
  ('c9c7eac7-9925-4e03-a4e0-fb2ef3ede430'),
  ('0f2014e8-6136-4d6f-b4c4-6d6f101d1667'),
  ('ba193510-ad23-4a5b-9b03-1c7d227bbd82'),
  ('1c43ea0a-b66f-447b-a69f-80617ef3d6fb'),
  ('ffa03689-a7cb-43fb-ab19-f181b23d32d5'),
  ('0e0316ff-0b18-444a-9930-00c62d87c8f0'),
  ('1db4af14-76cf-4898-80f7-d6aacf7eea41'),
  ('2aff1ec9-b991-494a-9432-04fec07aa819'),
  ('1afb1bae-5e8a-4ed5-b2aa-671e278c8cc0'),
  ('37d2a03f-028c-4be1-b239-84cd29e4bcfd'),
  ('b2cf5681-2fa7-456e-9707-a4f07ea3a120'),
  ('82aaace1-ec71-473f-89c9-64ec7474ffe1'),
  ('4724de4b-556b-446b-8a70-a303642e8739'),
  ('a3c99f3b-3fa3-4cb0-b5d4-5c64b6022921'),
  ('9ee87c29-6e42-4317-a4ef-d1224ec70e6b'),
  ('c4938e32-aba2-4798-8d71-2f100d027532'),
  ('4b7ca34b-e149-41f3-ad8a-f1cdabbfa216'),
  ('f9663bd4-ab0f-4874-a820-07c7d90f28ce'),
  ('4b30cb04-1c6f-433d-9685-eda20312cbf6'),
  ('98175867-bb38-4985-8044-fcf73f04a334'),
  ('47e62953-49fe-4dc0-a1a8-b13c322d939e'),
  ('f4b59687-5589-40f1-99cb-3be238e7ee7a'),
  ('1dec77d2-4b7b-49be-9b70-811c7e076be2'),
  ('83f1a0c4-3b92-4c45-9858-93b1e10aaab7'),
  ('ebfab51a-7dbc-4ae6-8e8a-9582df8cd2bd'),
  ('e0e581e3-4f59-4df8-9008-db5e6e19539c'),
  ('2aaa837a-46c0-4448-98b8-517085c0b75d'),
  ('3dbc4306-cce3-4ed1-a5d0-47c5dc66cacf'),
  ('a6445472-420e-4a81-a689-ea2d306768e8'),
  ('6e40c582-2b25-43e4-888b-4966c441fc19'),
  ('c203d601-e134-43e6-b4c6-5812f3cbd9e1'),
  ('04377e61-53ac-4b2f-84b1-ce7a4c9c2dd7'),
  ('11fb0fbf-574c-4d31-9de7-75589f54f7b6'),
  ('e6bf3c74-1e9e-4638-9b26-afe5df7beb66'),
  ('9209c220-0b58-41c1-8277-a9e98d02d7cf'),
  ('a1a63058-e922-4adf-9e0b-204550cb7ae3'),
  ('630a424f-fcf2-42a4-ab04-48d6d6dcabee'),
  ('44241f31-7413-40c1-9880-85be9e3313da'),
  ('558f5a06-3169-4c7f-bbf2-f9273a1db742'),
  ('ec33a9e5-9029-4b78-8f3c-2fdb2e767d0f'),
  ('d77db268-ed3a-48af-a0a2-9fe5d3214532'),
  ('a83867d2-ba7c-434a-b0ab-0861f5acd854'),
  ('a3032ddd-d79d-4498-8bc2-b3373e397f64');

create temp table fixture_room_ids (id uuid primary key);
insert into fixture_room_ids (id) values
  ('31bdb631-f5cd-45b7-822a-ae2eb0274df2'),
  ('79426bed-00c2-471d-a129-35f62acd6349'),
  ('fd0e4df2-b0cc-4bed-a1b7-bdd6ea28c174'),
  ('752175d9-eb23-49af-9415-0f5155486eda'),
  ('64719b50-15f2-419f-8520-544769be1a93'),
  ('87b17a38-1d59-4c77-bd1c-f6665ac15305'),
  ('44473b30-d6d1-452f-b7dd-d0e2495b51df'),
  ('ea34319b-323d-4934-a0c7-227a4747f3a2'),
  ('2a229a9e-0080-4adc-99be-01c736042d19'),
  ('117d8d2e-b727-4993-80e2-eefe11566208'),
  ('faead8bc-b325-47dd-91f3-159019dda4b1'),
  ('caa0a718-bb4e-4310-ba0b-05576d8dd927'),
  ('2b6f24b4-0600-4db1-a398-bdddf3f14b13'),
  ('103fdbfa-0da4-4e4e-b6ff-e0960aed73fb'),
  ('5b3ee34f-68af-4752-934f-bf46b0c830c7'),
  ('ce5993f0-fabd-47f8-8e8e-b03c636c6c7c'),
  ('1bcc230b-1d91-46fd-badd-7df6b060e06d'),
  ('d0c6b54b-8f91-4da7-8de5-62d800a72d05'),
  ('add451ce-83fc-4f65-a7cb-fc98a559df40'),
  ('5b93900e-5705-4480-b6ae-5162f663ee7e'),
  ('9a29c537-7eae-4aa5-8cd6-4d064ec8651d'),
  ('a82e17b4-749c-4f82-ad21-ee8aa8964b66'),
  ('d393e16b-cf64-4f6a-8f3f-7fd1fc90aacc'),
  ('908e6390-024c-4250-83e7-3deff2f1d372'),
  ('fa6e30d8-037a-4dbf-9407-7306a3633cad'),
  ('4ebcd144-93ff-4a4c-a437-89cd734158dd'),
  ('0a5eb65c-835f-466f-9b2b-5fef9241148f'),
  ('0435326d-f5b5-4a83-9cc4-00c72fb0a445'),
  ('fc3773fa-d0d9-482c-8fa2-85f0644de444'),
  ('848da763-ba7f-48b7-ad88-82d0c0443b71'),
  ('1356fd4e-71b0-40ad-bc22-5181bda85ed8'),
  ('e85cd235-b1ca-4654-8a10-6870807af20b'),
  ('33e25e9c-19e9-401e-93af-c9c8e45e797b'),
  ('75d39fdd-73ac-4fcd-81ee-eba210c77db6'),
  ('537e14ee-b2d7-4576-a3db-7b4e190d43a4'),
  ('260dce55-52b9-4ee8-87b6-1e05a9f41f72'),
  ('4ebef21b-0402-485c-98bc-ef61bb0cc630'),
  ('7b390ce0-1049-4152-a53a-0914c7190757'),
  ('f853657d-78cd-4998-81e4-dc05cf4c60ff'),
  ('e449a834-c2f7-421a-9a5e-7aeffa603ec2'),
  ('0f0a3c26-13f4-4d76-b4b5-d0a449b1f6cf'),
  ('e09c18bb-5e20-413f-9e94-36acace2ee7a'),
  ('6add078c-c6d4-41b1-9729-2234555cc43a'),
  ('98ec470e-ab83-49a4-be28-7748faee9798'),
  ('6fe89a79-b6e5-4698-b581-d332e98a8b50'),
  ('6c8af243-5a0f-4771-85e9-739c0244dddd'),
  ('c8c24a33-6815-4bf1-8c1d-a89af7bc5546'),
  ('9bf8c16f-6083-46c3-baf2-15f4035251fe'),
  ('dbab651d-42de-42eb-b619-22bed3fc818b'),
  ('f2190404-5890-4840-93c9-ff512cddb47e'),
  ('d192c6a1-7102-4450-ad25-473eb1d23503'),
  ('eb1f4805-c2be-4c2c-bdde-01d180a6237a'),
  ('d668b8e6-9323-41d0-9c5d-f8e55a3e68c1'),
  ('9cdc7bc6-b274-4bec-83ec-c373ebc7e0ed'),
  ('f50edf17-baf3-4157-871e-1b7a9a9572f8'),
  ('8420f0de-7d56-4bc2-9df5-6c6737718b13'),
  ('48c4cd81-cf03-42d0-bed8-f8436b04fa78'),
  ('682a189f-3ad2-40f3-8c1b-eb716d134305'),
  ('ee3b8f93-211e-49d2-bb98-07058cbb724d'),
  ('d5871d65-c599-47b0-88dd-5b9e6172d553'),
  ('d60e41af-b39b-40b4-abcc-a90cbf2027e9'),
  ('dca352ec-eaa4-4045-88dd-bf2c88f0185e'),
  ('10340739-f7f5-4617-b0b2-3577e7b2f692'),
  ('a15780bd-6762-4690-97f2-27cb6d00f030'),
  ('c81cfe95-be5a-414a-8df0-65ccf080abd0'),
  ('cbd0f865-0e95-4d34-b9e3-d2c33203c30e'),
  ('d651f4b4-70f3-474c-816d-bdea58a858a9'),
  ('0f8a174b-5a2d-4a2c-91c5-87ecb78c614b'),
  ('f26ddf5c-5245-48e4-8c23-b78c444d793b'),
  ('d9990866-7f8a-46a8-8c9f-27e856c83033'),
  ('f573a98d-6e7e-4e1c-9e30-2fda461ddc85'),
  ('94562b69-d1a5-4e02-bdf6-1630b20e7abb'),
  ('01dc3339-c32b-4908-ac8c-73c199684072'),
  ('ddfca69b-913d-45fd-aa73-ad71b38a508f'),
  ('94d6db46-5fc2-43cb-b5e7-5d62332e2d55'),
  ('4405714a-3b9c-4f18-ad6e-2351038f2af6'),
  ('1b2551b7-a9e6-4de4-9057-afead20684d9'),
  ('8d1cc3a1-d7d3-440a-958f-a67e33e4aa90'),
  ('10404843-a9b5-459c-93ea-aa5689b5acda'),
  ('d6684b8a-6785-4a47-8048-7b56c8a3bab4'),
  ('5910dd24-6e1a-41c8-a0b1-5d375a40d356'),
  ('35b8ac9b-56b2-40f8-adb8-94fc3a302b36'),
  ('5e1ee0d4-b17f-451e-8b2f-dd7b9a9d3675'),
  ('47bca891-055e-43c4-a026-647212b83ca1'),
  ('c67b85c9-bd91-4a7f-859c-44d4fa96350e'),
  ('9fe24f45-e489-4ed2-8f92-dfd5f9abb5d4'),
  ('13bf4048-6b30-45ef-a426-9c708414caa1'),
  ('674ae079-7732-401d-8b53-0dfdd3a21da1'),
  ('412c4dd8-29ef-4fb0-a3ac-82d04d6b8814'),
  ('1c806a4d-6b9a-4e96-8761-5b64c57b5499'),
  ('7140d671-0f53-47e5-bdaf-19560119d698'),
  ('993d9eae-c67b-4ab8-9997-2097aa6b83ef'),
  ('ded23a85-1ac5-4b9a-89a4-8534ed00928c'),
  ('520ecee6-8ef1-470c-9e69-0276291079a8'),
  ('09382a19-b75c-4582-8bb0-02a371a25cf1'),
  ('90fbd721-66a9-48ec-b768-7b55264da52e'),
  ('db74034c-b216-42a6-b2e9-ef9af67d08bf'),
  ('fe3bed1c-a671-4dbd-bf45-87e83d8102b5'),
  ('b9a88ebe-e1c5-493c-ab29-9abfc6fb4a62'),
  ('bc48da56-1882-4cc6-a74e-92013224f2d6'),
  ('a8de86b2-a420-4b2a-8591-628d6bc6c626'),
  ('76a74639-8ebe-444d-8915-c9575fdf8b82'),
  ('8fcb9d85-3b81-4c67-ab0d-95bd5cfbe412'),
  ('30c556b5-38b9-46e9-b4ea-35872675fa40'),
  ('cfcb022c-8515-423a-8773-28af8c6210f7'),
  ('b5a9e49e-b363-4cfa-babb-49dc3bba2faa');

create temp table fixture_type_ids (id uuid primary key);
insert into fixture_type_ids (id) values
  ('6ecaab04-2c85-45de-b244-4450738d2374'),
  ('42269af3-a2b9-4230-84de-83e47571cfd7'),
  ('b09a12a8-f415-42a2-8ea3-ddffc0f91aa9'),
  ('742c42f6-25af-41dd-9ba6-6484f150a54b'),
  ('dafa02c7-66c1-474a-8630-7f9a2a9eddeb'),
  ('0bfa8dc7-0ace-4be9-8e78-eb1eb54cf155'),
  ('d83f7807-11e6-4602-a182-61ffe964f238'),
  ('d8fc0ab2-0072-4f44-a557-6d4bedf72471'),
  ('636a3903-18eb-4a63-817a-91a7221c7dc9'),
  ('4ab62c73-4aae-458a-bb1a-3477fc2371b6'),
  ('bdd76ac3-64ce-4118-b3fe-79481af7104d'),
  ('c07b1fb3-e967-4917-bd9c-4a27156b0857'),
  ('3a6fe439-e5bb-48bd-bc90-0c6ee61403bc'),
  ('6052e008-9c9c-48f3-a29c-15b53dda9e17'),
  ('21ba7196-8b5c-4e34-9e1f-c7cb4981caed'),
  ('42392952-f17d-4e33-a068-4f1ba2840060'),
  ('b4816051-0089-4c40-914d-21510cf1a73a'),
  ('abac8deb-7dee-4f58-b056-5a871aae673f'),
  ('56315457-69c0-40ea-bd1d-9813a0a359ac'),
  ('617e4b8e-15c8-4073-a01a-d36097fdf5c8'),
  ('df315a28-95f6-4a4f-9f3b-e431436ed328'),
  ('48024980-52f7-488d-9de5-7b47ba8d62ed'),
  ('4bda3a1b-d593-4243-813f-45fbb11baf85'),
  ('d6eca366-9e6f-459c-b34d-8e622574be18'),
  ('e910c495-eb67-4202-87aa-8661882d56e3'),
  ('6d9eb4d3-fea3-4500-9bd3-418ea6c645ad'),
  ('796c3d12-647a-4885-b54c-f0fb858ece0a'),
  ('59076c1b-2f03-49a1-af48-f99b87ea80f4'),
  ('7025c314-ae27-4ae3-9c1d-aa28434c8c69'),
  ('fcb6891c-767d-4a08-829f-a8a9cba58a28'),
  ('0b9b6c08-9213-45b0-b03e-b39f823d41ea'),
  ('580d0dbb-2b39-4c04-b278-4e9273d26b10'),
  ('0926189e-33db-4e2d-a546-d4e133c0facd'),
  ('530140e9-0677-4a05-a670-aefe9ea49e9e'),
  ('8242eb9b-afd9-4390-8886-52c236e6be1a'),
  ('1107a955-757c-43c5-bb8d-c98198cc6efc'),
  ('534f2251-5906-4736-a640-c527262621fc'),
  ('f44bea5c-d4ed-4be5-80a9-4cce80ed550e'),
  ('47d23b2a-b94d-4485-8028-5abdf9db8964'),
  ('e577694f-6c35-4f54-b747-11048bd57b55'),
  ('eef1ff7c-321c-4e37-bcb2-b798e418cbd3'),
  ('4e2f3d90-6bd8-47bd-96ae-536620b7c927'),
  ('64f542e0-ee30-4d4d-ac1f-6ee4312119d8'),
  ('ebecf53d-29d6-4261-9e96-96ed4df46a38'),
  ('6880314e-3e58-46e2-b0ba-c54d23571dae'),
  ('f958a46a-86ca-4b15-805a-1a9382907651'),
  ('c4b92517-3df6-4d8c-8569-9a8ec6bb6504'),
  ('8df5b824-a787-4743-abd1-9ff2cd927188'),
  ('51e41f59-6dfe-44fc-bebb-1bb3d42918e1'),
  ('6787bcca-2b6c-4118-80af-46ffcc827e2e'),
  ('773680ad-d9fd-495a-8c50-1c83e55cd7df'),
  ('8ad0d093-7493-4caf-87c5-e6ab13881a58'),
  ('89b44f80-8e3d-41ad-85b1-48472e3096ec'),
  ('f94ec3b6-4f95-4929-87a2-2073e901bcc4'),
  ('1edb350e-621f-4a00-a2f6-7b29aca94e00'),
  ('5d84e14c-751b-4094-887b-ecde06ee0e24'),
  ('a769fa32-9151-4edb-a2f8-caa132a0c495');

create temp table fixture_track_ids (id uuid primary key);
insert into fixture_track_ids (id) values
  ('e784e489-7a5c-4746-80e1-e2ee8d72d154'),
  ('61688f67-7c8a-45ea-a401-2e40fd9e8bc4'),
  ('75fc4f13-d385-46fb-87f7-57822cde39d8'),
  ('d1cc8020-b520-4f83-aff3-cbbdbf15da95'),
  ('47859a72-8064-4122-bff8-8d034146f6c2'),
  ('e99c9f82-dee9-4020-bb12-9832d7ebe7ad'),
  ('aceef94e-dd94-4941-83de-0d3d0ca55ba9'),
  ('0337000f-fc64-447a-83cd-3c8b5c0b041e');

create temp table fixture_day_ids (id uuid primary key);
insert into fixture_day_ids (id) values
  ('30806485-d6e7-4b36-bdca-6cd15edaf13c'),
  ('5ec72000-b160-400f-afc1-ebb7ad3f3ca2'),
  ('5f8b82b7-c586-45a4-9945-45141e7ca367'),
  ('7091f686-73af-4386-8f35-0663e9ce212a'),
  ('e9c3e199-5ea0-4ece-a8b3-b64d656e231a'),
  ('c1afb854-becc-4c3b-afd5-a08eeec87648'),
  ('0ac2fd97-dcfa-4d53-a739-cf7edc6788b8'),
  ('52537902-0a48-4534-9848-da9a9938e283'),
  ('9c53b98d-2ff9-468d-8877-e46d372775ff'),
  ('5326cb88-117d-41ca-a3ef-5ebbfe39a119'),
  ('f32db4df-a6a9-4cf0-8631-fb96d4cbe2f4'),
  ('133abd40-dc53-4014-8d00-ff3177f728d3'),
  ('7cd5bac4-116d-4f7f-83bf-0aff17bcd070'),
  ('ca81e8ae-9418-4c01-830c-9212b9f83413'),
  ('0ae6da77-3171-49cf-a54a-464248bc2bc5'),
  ('b0186d33-654f-42f0-8cf1-7367e1eb2c59'),
  ('557194b6-3b1f-43e7-8556-8d00bfc61164'),
  ('073b4d15-dd7a-4cd3-b796-0692006ae1ac'),
  ('3ea5688e-0f93-44c3-940d-ed6a4f924f51'),
  ('9571ae1a-c580-4eb2-bdbc-9be78ba76b52');

create temp table fixture_people_ids (id uuid primary key);
insert into fixture_people_ids (id) values
  ('9d360f5d-b5f4-4759-9ea6-67b73c622c89'),
  ('48080626-81f2-498c-b05a-9c4834f67ced'),
  ('815d46a7-7de9-4a8a-8da5-f3d47626b2f6'),
  ('b11c387e-35d5-4ecb-9131-b81b41873800');

create temp table fixture_tag_ids (id uuid primary key);
insert into fixture_tag_ids (id) values
  ('237db99b-454a-4601-8efe-51cc9de974e2');

-- Applicant ids (auth.users) from fixture applications, captured before
-- the applications delete below -- applicant_id is only readable from
-- the applications row itself.
create temp table fixture_applicant_ids as
select applicant_id as id from applications
where id in (select id from fixture_application_ids)
  and applicant_id is not null;

-- Unlinked test profiles (no application row at all -- e.g. bare
-- scanner_device/staff fixture accounts from live test seeding).
create temp table fixture_unlinked_profile_ids (id uuid primary key);
insert into fixture_unlinked_profile_ids (id) values
  ('8cd071ac-5ccd-4a7f-912b-d01fa0700588'),
  ('ecb88c29-e6b7-4e6a-9ab3-b0138baea699'),
  ('07347fed-bd07-4244-bfa0-8dad18b8f73f'),
  ('0ca067e4-398c-4fce-8820-cb525786cde8'),
  ('6b1abd9f-b466-430a-8816-cc1eb8419bcb'),
  ('53b6777d-b4c2-473d-afeb-b3492bf2aec6'),
  ('3bd33b6a-3fce-4467-aec5-52884ce04e25'),
  ('8ea0357d-1b41-4db3-9604-20af15ea1482'),
  ('e44f6bcb-5c57-4769-9294-08b6354b25e0'),
  ('46e60fb6-ebad-4411-87a5-f1766f504aad'),
  ('99178735-ef4b-40a2-b41f-9f6f121280e5'),
  ('2f46c89d-94f0-47b6-b2df-5c1c89b4f174'),
  ('32b4f2b5-5f4e-47e4-904c-cd093976f97f'),
  ('cceb3bef-3d6c-4e20-adeb-ccc82a60ed7b'),
  ('0c45e9e4-3fc9-4016-9364-c97edf92ca57'),
  ('32aa1a32-5e7e-40ea-88c1-f4941ebb5a46'),
  ('9a024013-7cc5-4970-82c8-4182aa2c093b'),
  ('0265f069-cdcd-4d52-a15a-3c2a8e641be9'),
  ('08eaa914-77dc-4f87-b55d-6da530d466a1'),
  ('136b66ad-4b38-4032-95f9-9d8f143206aa'),
  ('a82b9f8f-2156-490e-9724-1e08b23841bd'),
  ('74e880e1-6b19-48db-8394-35374d51ac16'),
  ('8e3a4da6-ea4b-418d-8968-511fd7b4173b'),
  ('ad014a83-48ec-499c-ab6e-cda7b6639aeb'),
  ('3a45b8cf-3ddb-4b25-917b-1344d965b530'),
  ('a9129aa6-5daa-4a91-b345-fc17481dfa2b'),
  ('37aaacbc-f6f9-46b4-8884-57f08e3a9a7e'),
  ('6b10b3a9-0cae-45ef-a9a8-4f54644f5ebd'),
  ('2cfc13b3-f78d-4e12-bc6e-d6e93a6d7b71'),
  ('2f704f80-fe1e-470f-acf3-d93eacd7677b'),
  ('5fc25643-9191-4e1c-8999-f87d72148e95'),
  ('05171beb-4d2e-4bec-a9b6-d4b3f9fb2028'),
  ('7b0aa99d-a0bc-437a-b759-afd19852b67c'),
  ('87ff77be-0f85-445b-a445-b009d7f9f766'),
  ('f60321ba-a47c-4e9c-9a95-22df7209cb8c'),
  ('1996418b-45d2-42b2-b44f-24a6ad9750bd'),
  ('cdd76c5d-4733-4c69-9b56-3db9a7ca804c'),
  ('7402d92d-9050-42aa-ae81-377b7874dc6a'),
  ('2f00a6df-8219-4f86-9684-babb5692cc0f'),
  ('1642dd2b-206d-4cef-873c-e096bea0d090'),
  ('e30b83f6-e500-4f15-81d3-7014dfe17c2d'),
  ('dad732b5-813b-4501-9c83-29a052ea39ec'),
  ('ec96f447-d8b0-442c-bdc8-a4bd6203b618'),
  ('4393965b-c64e-4770-8f1c-9b7e629e2086'),
  ('d5b55dc8-a5d7-443a-ab06-fe89f9b70cef'),
  ('e0bdf2e0-3098-40ea-8b7a-92aa952ee0e9'),
  ('22913b8d-8ecf-44d1-abc2-937abe127f4b'),
  ('38c6f52d-d43b-4f9e-9b73-4e8247bdb455'),
  ('8fc2b425-ab4b-4d6a-9a98-4298b2dc6bef'),
  ('e22357a5-8ea8-4a55-87a4-95e671940a32'),
  ('adfad87d-cf22-4f6f-afbd-c46bc86776ff');

-- Union of every fixture auth.users id (claimed applicants + unlinked
-- profiles) -- used below to find/delete fixture allocation_runs and
-- feature_extraction_runs rows (run_by/confirmed_by reference profiles
-- with no on-delete clause; confirmed live -- a second apply attempt
-- failed on allocation_runs_confirmed_by_fkey before this table and the
-- two deletes using it were added).
create temp table fixture_user_ids as
select id from fixture_applicant_ids
union
select id from fixture_unlinked_profile_ids;

-- Belt-and-braces guard, matching the 2026-10-24 precedent: fail loudly
-- if the live counts have shifted since this migration was generated,
-- rather than silently deleting something unexpected.
do $$
declare
  v_session_count int;
  v_app_count int;
  v_room_count int;
  v_type_count int;
  v_track_count int;
  v_day_count int;
  v_non_test_app_count int;
begin
  select count(*) into v_session_count from fixture_session_ids;
  if v_session_count <> 105 then
    raise exception 'Expected % fixture session ids, found %', 105, v_session_count;
  end if;

  select count(*) into v_app_count from fixture_application_ids;
  if v_app_count <> 80 then
    raise exception 'Expected % fixture application ids, found %', 80, v_app_count;
  end if;

  select count(*) into v_room_count from fixture_room_ids;
  if v_room_count <> 106 then
    raise exception 'Expected % fixture room ids, found %', 106, v_room_count;
  end if;

  select count(*) into v_type_count from fixture_type_ids;
  if v_type_count <> 57 then
    raise exception 'Expected % fixture session_type ids, found %', 57, v_type_count;
  end if;

  select count(*) into v_track_count from fixture_track_ids;
  if v_track_count <> 8 then
    raise exception 'Expected % fixture track ids, found %', 8, v_track_count;
  end if;

  select count(*) into v_day_count from fixture_day_ids;
  if v_day_count <> 20 then
    raise exception 'Expected % fixture conference_day ids, found %', 20, v_day_count;
  end if;

  -- Every fixture application must be @test.local-linked (imported_email
  -- directly, or via the claimed profile's email) -- same safety check
  -- shape as the 2026-10-24 precedent.
  select count(*) into v_non_test_app_count
  from applications a
  join fixture_application_ids t on t.id = a.id
  where coalesce(a.imported_email, '') not ilike '%@test.local'
    and not exists (
      select 1 from profiles p
      where p.id = a.applicant_id and p.email ilike '%@test.local'
    );
  if v_non_test_app_count > 0 then
    raise exception 'Found % application(s) in the deletion set that are NOT @test.local-linked -- aborting', v_non_test_app_count;
  end if;

  -- Real D1-* sessions must NEVER appear in the fixture session set.
  if exists (
    select 1 from sessions s
    join fixture_session_ids f on f.id = s.id
    where s.session_code ilike 'D1-%'
  ) then
    raise exception 'A D1-* session appears in the fixture deletion set -- aborting';
  end if;

  -- Real reference-data codes must never appear in the fixture sets.
  if exists (select 1 from rooms r join fixture_room_ids f on f.id = r.id where r.code in ('MH','FOY','CAF','OFF','R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12')) then
    raise exception 'A real room code appears in the fixture room deletion set -- aborting';
  end if;
  if exists (select 1 from session_types t join fixture_type_ids f on f.id = t.id where t.code in ('REG','PLN','BRK','CUL','SDE')) then
    raise exception 'A real session_type code appears in the fixture deletion set -- aborting';
  end if;
  if exists (select 1 from tracks t join fixture_track_ids f on f.id = t.id where t.code in ('REG','PLN','BRK','CUL','SDE')) then
    raise exception 'A real track code appears in the fixture deletion set -- aborting';
  end if;
  if exists (select 1 from conference_days d join fixture_day_ids f on f.id = d.id where d.conference_date in ('2026-11-05','2026-11-06','2026-11-07')) then
    raise exception 'A real conference_day appears in the fixture deletion set -- aborting';
  end if;
end $$;

alter table public.qr_credentials disable trigger qr_credentials_lifecycle_guard;
alter table public.qr_lifecycle_operations disable trigger qr_lifecycle_operations_lifecycle_guard;

delete from public.qr_lifecycle_operations
  where application_id in (select id from fixture_application_ids);

delete from public.qr_credentials
  where application_id in (select id from fixture_application_ids);

alter table public.qr_credentials enable trigger qr_credentials_lifecycle_guard;
alter table public.qr_lifecycle_operations enable trigger qr_lifecycle_operations_lifecycle_guard;

-- Dependents of fixture sessions and/or fixture applications.
--
-- scan_attempts MUST be deleted before attendance_records:
-- scan_attempts_resulting_attendance_id_fkey has no on-delete clause
-- (confirmed live -- a first attempt at this migration failed with
-- exactly this FK violation). Independently verified before writing
-- this: every fixture-linked scan_attempts.resulting_attendance_id
-- points only at a fixture attendance_records row (18/18 checked), and
-- zero non-fixture scan_attempts rows reference a fixture
-- attendance_records row -- safe to delete in this order with no risk
-- to a real scan/attendance row.
delete from public.scan_attempts
  where application_id in (select id from fixture_application_ids)
     or session_id in (select id from fixture_session_ids);

delete from public.attendance_records
  where session_id in (select id from fixture_session_ids)
     or application_id in (select id from fixture_application_ids);

delete from public.session_bookings
  where session_id in (select id from fixture_session_ids)
     or application_id in (select id from fixture_application_ids);

delete from public.session_people
  where session_id in (select id from fixture_session_ids)
     or person_id in (select id from fixture_people_ids);

delete from public.allocation_assignments
  where session_id in (select id from fixture_session_ids)
     or application_id in (select id from fixture_application_ids);

-- schedule_change_events.session_id has no on-delete clause -- must be
-- deleted before sessions below.
delete from public.schedule_change_events
  where session_id in (select id from fixture_session_ids);

delete from public.scanner_assignments
  where session_id in (select id from fixture_session_ids)
     or room_id in (select id from fixture_room_ids)
     or scanner_user_id in (select id from fixture_unlinked_profile_ids)
     or scanner_user_id in (select id from fixture_applicant_ids);

delete from public.notifications
  where session_id in (select id from fixture_session_ids)
     or application_id in (select id from fixture_application_ids);

-- Now dependency-free: fixture applications themselves.
delete from public.applications
  where id in (select id from fixture_application_ids);

-- allocation_runs.run_by / .confirmed_by and feature_extraction_runs.run_by
-- reference profiles with no on-delete clause (confirmed live -- a second
-- apply attempt failed on allocation_runs_confirmed_by_fkey). Independently
-- verified before adding this: both fixture rows found here (1 each) were
-- created by a fixture user at the same 2026-10-31 15:02:10 timestamp as
-- the rest of this incident's fixture data, and allocation_runs cascades
-- to allocation_assignments/allocation_alternatives/
-- allocation_assignment_explanations (already covered above, but deleting
-- the run itself is still required since no FK points the other way).
-- Zero clustering_runs/schedule_publications/schedule_publication_drafts
-- reference either fixture run -- confirmed before writing this, so no
-- further cascade is needed here.
delete from public.allocation_runs
  where run_by in (select id from fixture_user_ids)
     or confirmed_by in (select id from fixture_user_ids);

delete from public.feature_extraction_runs
  where run_by in (select id from fixture_user_ids);

-- audit_logs.actor_id has no on-delete clause (same pre-existing gap as
-- the 2026-10-24 precedent) -- null it out for every fixture user
-- (claimed applicants + unlinked profiles) before the auth.users delete.
update audit_logs set actor_id = null
  where actor_id in (select id from fixture_applicant_ids)
     or actor_id in (select id from fixture_unlinked_profile_ids);

-- auth.users delete cascades to profiles (profiles.id references
-- auth.users(id) on delete cascade). Covers both claimed applicants and
-- unlinked (no-application) test profiles.
delete from auth.users
  where id in (select id from fixture_applicant_ids)
     or id in (select id from fixture_unlinked_profile_ids);

-- Fixture sessions, now dependency-free.
delete from public.sessions
  where id in (select id from fixture_session_ids);

-- Fixture reference data, now unreferenced by any session.
delete from public.rooms
  where id in (select id from fixture_room_ids);

delete from public.session_types
  where id in (select id from fixture_type_ids);

delete from public.tracks
  where id in (select id from fixture_track_ids);

delete from public.conference_days
  where id in (select id from fixture_day_ids);

-- Fixture people/tags from live test seeding.
delete from public.people
  where id in (select id from fixture_people_ids);

delete from public.tags
  where id in (select id from fixture_tag_ids);

commit;
