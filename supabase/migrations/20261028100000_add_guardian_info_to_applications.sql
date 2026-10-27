-- supabase/migrations/20261028100000_add_guardian_info_to_applications.sql
--
-- Adds nullable guardian/companion contact fields for under-18
-- applications. Lives on `applications` (not application_health_info)
-- per the design spec's reasoning: this is about who is responsible for
-- the attendee, not a medical/health concern, and applications already
-- owns age_group/birth_date (the under-18 signal these fields depend
-- on). No RLS policy change needed: applications' existing staff
-- UPDATE policy already covers this, and the server action's
-- requireParticipantCareStaffCaller() check (service-role, bypasses
-- RLS) is the real gate, same as every other participant-care write in
-- this codebase.
alter table applications
  add column if not exists guardian_name text,
  add column if not exists guardian_phone text;
