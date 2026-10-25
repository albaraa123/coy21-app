-- 20261025000000_add_profile_identity_fields.sql
--
-- My Profile gains editable Name/Email/Phone/Photo fields (see
-- docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-design.md
-- Item 1). full_name and email already exist on profiles (set once at
-- signup by handle_new_user(), never previously user-editable). phone and
-- avatar_path are new. Both nullable -- "required" is enforced at the
-- application layer only (client + server validation in actions.ts),
-- matching this codebase's existing pattern for every other "required"
-- field (e.g. the admin manager forms) -- not a DB-level NOT NULL, to
-- avoid breaking any existing profile row.
alter table profiles add column phone text;
alter table profiles add column avatar_path text;
