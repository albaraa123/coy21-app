-- scripts/diagnose-booking-allocation-conflicts.sql
--
-- Read-only diagnostic. Finds every ACTIVE session_bookings row whose
-- participant also has a CONFIRMED allocation_assignments row for a
-- time-overlapping session -- i.e. bookings made before
-- 20261003000000_book_session_respects_allocation.sql existed, which
-- are now inconsistent with the new rule but were never automatically
-- cancelled or modified (explicit scope decision, see
-- docs/superpowers/specs/2026-10-01-booking-allocation-conflict-design.md
-- section 1). Run manually and review with the team; this script makes
-- no changes.
select
  sb.id as booking_id,
  sb.application_id,
  sb.session_id as booked_session_id,
  aa.session_id as assigned_session_id,
  s1.title_en as booked_session_title,
  s2.title_en as assigned_session_title
from session_bookings sb
join sessions s1 on s1.id = sb.session_id
join allocation_assignments aa on aa.application_id = sb.application_id and aa.status = 'confirmed'
join sessions s2 on s2.id = aa.session_id
where sb.status = 'active'
  and tstzrange(s1.start_time, s1.end_time, '[)') && tstzrange(s2.start_time, s2.end_time, '[)');
