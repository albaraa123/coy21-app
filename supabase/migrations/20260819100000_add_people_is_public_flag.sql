-- 20260819100000_add_people_is_public_flag.sql
--
-- Phase 9.2 — smallest architecture change needed to power the public
-- Speakers page: a staff-curated visibility flag on the existing `people`
-- table. No new table (people/session_people already model everything
-- else needed — name, title, org, bio, photo, and the 'speaker' role via
-- session_people), no RLS/GRANT change (the public page reads via the
-- service-role client with a narrow field allowlist, per the explicit
-- decision to avoid a new anon-grant surface on this table — see
-- src/lib/content/public-speakers.ts).
--
-- Defaults to false: every existing `people` row (all internal
-- agenda-assignment entities today, none curated for public display)
-- stays invisible on the public site until a staff member explicitly
-- opts a person in, per the approved "staff picks who shows" decision.
alter table people add column is_public boolean not null default false;

comment on column people.is_public is
  'Staff-curated flag: true means this person may appear on the public Speakers page (subject to also having a session_people role=speaker row and is_active=true). Never auto-derived from role or activity.';
