-- add_travel_operations_and_participant_care_roles.sql
--
-- Phase A of the controlled-account-provisioning design
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 3.3a). Adds the two new staff roles approved for the sensitive-data
-- separation: travel_operations_staff (travel/visa/passport/funding) and
-- participant_care_staff (medical/accessibility/dietary/emergency-contact).
--
-- Isolated in its own migration file, with nothing else in it: Postgres
-- requires a new enum value to be committed before it can be referenced by
-- any policy or check constraint. No prior migration in this repo has ever
-- used `alter type ... add value`, so this keeps the ordering
-- correct-by-construction rather than relying on how the migration runner
-- batches statements.
alter type user_role add value 'travel_operations_staff';
alter type user_role add value 'participant_care_staff';
