-- 20261006035000_add_attendance_booking_id.sql
--
-- Nullable link from a door-entry attendance record back to the
-- self-service booking it satisfies, if any. Populated best-effort by
-- scan_attempt_transactional (Task 6) and by admit_walk_in (Task 6).
-- NULL is a normal, expected state -- not every admission originates
-- from a session_bookings row (e.g. allocation-assignment-only
-- attendance, or priority-pool admission with no prior booking). Added
-- here (Task 4) rather than Task 6 because process_session_no_shows
-- needs it to exist first; Task 6 only needs to START POPULATING it,
-- not create it. See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 1.

alter table attendance_records add column booking_id uuid references session_bookings(id);

create index attendance_records_booking_id_idx on attendance_records (booking_id);
