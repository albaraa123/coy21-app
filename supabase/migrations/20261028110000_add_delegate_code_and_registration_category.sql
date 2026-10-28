-- supabase/migrations/20261028110000_add_delegate_code_and_registration_category.sql
--
-- Adds the two columns needed to import participants from a source file
-- with pre-assigned delegate codes (e.g. DEL-INT-001) without disturbing
-- the existing auto-generated application_number scheme
-- (next_application_number(), COY21-DEL-NNNN format). Both nullable:
-- the vast majority of applications (self-registered, or imported from
-- a source with no such code) will never have these set.
--
-- external_delegate_code is unique (Postgres unique constraints permit
-- unlimited NULLs, so this never conflicts with existing/future rows
-- that have none). registration_category is a plain display-only text
-- field (e.g. "Onground Volunteers") with no constraint -- it's derived
-- from external_delegate_code's prefix by application code, not
-- independently validated at the DB level.
alter table applications
  add column if not exists external_delegate_code text,
  add column if not exists registration_category text;

alter table applications
  add constraint applications_external_delegate_code_unique unique (external_delegate_code);
