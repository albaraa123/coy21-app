-- 20260820130000_add_attendance_confirmation.sql
--
-- Adds applications.attendance_confirmation: whether an already-accepted
-- participant has confirmed they will actually attend, or declined, or has
-- not responded yet. Deliberately independent of application status
-- (admission decision) and of funding_type — three separate, orthogonal
-- facts, per explicit user decision. Purely operational, used to compute a
-- real headcount for room/catering logistics ahead of the conference.
--
-- Intentionally NOT built: a participant-facing confirmation link, any
-- notification/email trigger, or any link to the 'withdrawn' application
-- status — explicitly deferred to a later phase per user instruction.

create type attendance_confirmation_status as enum (
  'confirmed',
  'not_confirmed',
  'declined'
);

-- default 'not_confirmed' (not null-by-default): every freshly imported
-- accepted participant starts unconfirmed until staff record a real
-- response, per explicit user decision -- distinct from funding_type, which
-- has no default and stays null until set.
alter table applications add column attendance_confirmation attendance_confirmation_status not null default 'not_confirmed';

------------------------------------------------------------------
-- RLS: read/write stays exactly as funding_type's existing policies
-- already grant (applications_select_staff / applications_update_staff,
-- unchanged by this migration -- they already cover the whole applications
-- row, not per-column, so program_attendance_manager/travel_operations_staff/
-- registration_admission_manager/participants_communications_manager/
-- super_admin already have read+write access to this new column with zero
-- policy change needed here).
--
-- participant_care_staff gets its own ADDITIONAL, READ-ONLY policy --
-- deliberately NOT folded into applications_select_staff (which would also
-- imply broader access to every other applications column this role has no
-- business reading) and NOT given any write policy at all (staff.write
-- limited to program_attendance_manager/travel_operations_staff/super_admin
-- per explicit user decision -- participant_care_staff needs to know who is
-- coming to prepare reception/special-needs support, but does not own the
-- attendance decision).
------------------------------------------------------------------
create policy applications_select_participant_care_staff on applications
  for select
  using (current_user_role() in ('participant_care_staff', 'super_admin'));
