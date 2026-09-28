-- Adds narrow, read-only RLS policies allowing anyone (no login required)
-- to SELECT: sessions rows where is_public = true, plus rooms/tracks/
-- session_types in full (small reference tables with no per-row sensitivity
-- of their own — a room name, track name, or session-type label is not
-- meaningful to restrict once the sessions row referencing it is already
-- public). Purely additive: every existing *_staff_all policy (full access
-- for agenda_allocation_manager/program_attendance_manager/super_admin) is
-- untouched. Enables the public /conference-agenda page to query the real
-- session catalog, and its room/track/type labels, for the first time.
create policy sessions_select_public
  on public.sessions
  for select
  to anon, authenticated
  using (is_public = true);

create policy rooms_select_public
  on public.rooms
  for select
  to anon, authenticated
  using (true);

create policy tracks_select_public
  on public.tracks
  for select
  to anon, authenticated
  using (true);

create policy session_types_select_public
  on public.session_types
  for select
  to anon, authenticated
  using (true);

-- RLS only narrows an already-granted privilege. Confirmed live on all
-- four tables: authenticated already had table-level SELECT (Supabase's
-- default provisioning), but anon had none at all ("permission denied for
-- table sessions" even with the policy above in place) — so only anon
-- needs the grant here; re-granting authenticated would be redundant, not
-- incorrect, but is skipped to keep this migration's diff exactly matched
-- to the actual gap. SELECT only — no INSERT/UPDATE/DELETE for anon on
-- any of the four tables.
grant select on public.sessions to anon;
grant select on public.rooms to anon;
grant select on public.tracks to anon;
grant select on public.session_types to anon;
