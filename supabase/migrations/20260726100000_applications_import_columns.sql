-- applications_import_columns.sql
alter table applications alter column applicant_id drop not null;
alter table applications add column imported_email text;
alter table applications add column import_batch_id uuid;

-- Self-registered applications must still have an owner. Imported-and-
-- unclaimed applications are the only legal NULL applicant_id case, and only
-- when they carry a non-null imported_email — a NULL applicant_id row is
-- always traceable to a claim-in-progress import, never an identity-less
-- orphan. See design spec § Schema changes / rule 4.
alter table applications add constraint applications_owner_or_import_identity
  check (applicant_id is not null or imported_email is not null);

-- Case-insensitive matching is achieved by normalizing (trim + lowercase) in
-- application code before every write to this column — never re-derived
-- from profiles.email, and never silently changed after claim (design spec
-- rule 5) — matching this codebase's existing convention of app-layer
-- normalization before insert (see registration's email handling) rather
-- than a DB-level citext/trigger transform. Partial: claimed applications
-- may retain imported_email for provenance and future re-import matching,
-- so the index only needs to prevent duplicate *unclaimed* identities.
create unique index applications_imported_email_unclaimed_unique
  on applications (imported_email) where applicant_id is null;

create index applications_import_batch_idx on applications (import_batch_id);
