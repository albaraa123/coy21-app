-- 20261006071000_ops_dashboard_snapshot.sql
--
-- Sub-project 5a (live operations dashboard), Task 1. Adds the
-- ops_dashboard_snapshot() aggregate RPC (one row per confirmed session,
-- every number the dashboard needs precomputed server-side -- see
-- docs/superpowers/specs/2026-10-05-ops-dashboard-design.md's Data Model
-- section, copied verbatim from there) plus the Realtime broadcast
-- trigger that notifies subscribed clients "something changed, go
-- re-fetch the snapshot" on every attendance_records/scan_attempts
-- write.
--
-- Task 0 (spike, already run against this live project) confirmed:
--   realtime.send(payload jsonb, event text, topic text, private boolean)
-- exists on this project with exactly this signature -- no call-shape
-- change needed from the spec's original sketch. However, the spike also
-- found that RLS is enabled on realtime.messages with ZERO prior
-- policies (default-deny), so a broadcast insert succeeds with no SQL
-- error but is never delivered to any subscribed client -- a silent
-- false-positive. The required fix (a SELECT policy admitting
-- `authenticated` for broadcast-extension rows) is included below.
--
-- That exact policy was already applied DIRECTLY to this live database
-- during Task 0's proof-of-concept (via `db query --linked`, not as a
-- tracked migration), to prove the end-to-end mechanism works before
-- committing to it here. Postgres has no `create policy if not exists`,
-- so it must be dropped first -- immediately before this migration is
-- applied -- so this migration becomes the single tracked source of
-- truth for it going forward, rather than leaving an undocumented
-- live-only policy coexisting with (or blocking) this one.
--
-- ops_dashboard_snapshot() is copied verbatim from the spec's Data Model
-- section SQL block, which already incorporates two review rounds' worth
-- of fixes: (1) count(distinct scanner_user_id), not count(*), so a
-- single physical scanner holding both a room-scoped and a session-scoped
-- scanner_assignments row matching the same session isn't double-counted;
-- (2) the room-vs-session staleness scoping fix, so a room-scoped
-- scanner that just finished the previous back-to-back session in the
-- same room isn't wrongly flagged stale for the next one.

create or replace function ops_dashboard_snapshot() returns table (
  session_id uuid,
  title_en text,
  title_ar text,
  room_name_en text,
  room_name_ar text,
  capacity int,
  occupied_count int,
  occupancy_pct float8,
  is_full boolean,
  is_near_full boolean,
  scanner_count int,
  stale_scanner_count int,
  last_scan_at timestamptz,
  rejection_count_30m int,
  rejection_breakdown jsonb
) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- is_staff() returns NULL (not false) for an unauthenticated/anon
  -- caller, since current_user_role() looks up profiles by auth.uid()
  -- and finds no row -- "not NULL" is also NULL, which `if` treats as
  -- falsy, so a bare `if not is_staff()` would silently skip this
  -- check entirely for anon callers. coalesce(..., false) is required
  -- to make the unauthenticated case correctly raise.
  --
  -- service_role (this project's live test fixtures, and any future
  -- server-side admin code) also has no auth.uid(), so it hits the
  -- exact same NULL path as anon unless explicitly allowed here --
  -- confirmed by a live regression this fix originally introduced:
  -- the test suite's own service-role admin client started getting
  -- "Not authorized" once coalesce(..., false) correctly started
  -- treating NULL as not-staff. auth.role() = 'service_role' is the
  -- correct, narrow way to allow it back in without reopening the
  -- anon hole this whole fix exists to close.
  if not (coalesce(is_staff(), false) or auth.role() = 'service_role') then
    raise exception 'Not authorized';
  end if;

  return query
  select
    s.id,
    s.title_en, s.title_ar,
    r.name_en, r.name_ar,
    s.capacity,
    session_effective_occupied_count(s.id),
    round(100.0 * session_effective_occupied_count(s.id) / greatest(s.capacity, 1), 1)::float8,
    session_effective_occupied_count(s.id) >= s.capacity,
    session_effective_occupied_count(s.id) >= (s.capacity * 0.9), -- near-full threshold
    -- count(distinct scanner_user_id), not count(*): a single physical
    -- scanner can hold two assignment rows (one room-scoped, one
    -- session-scoped) that both match this session, and count(*) would
    -- double-count it.
    (select count(distinct sa.scanner_user_id)::int from scanner_assignments sa where sa.is_active and (sa.session_id = s.id or sa.room_id = s.room_id)),
    (select count(distinct sa.scanner_user_id)::int from scanner_assignments sa
       where sa.is_active and (sa.session_id = s.id or sa.room_id = s.room_id)
         and not exists (
           -- Room-scoped assignments must count a recent scan against ANY
           -- session in that room, not just this one -- otherwise a
           -- room-scoped scanner that just finished scanning the PREVIOUS
           -- back-to-back session in the same room would be wrongly
           -- flagged stale for the next one, even though it's clearly
           -- online. Session-scoped assignments still only count a scan
           -- against this exact session -- but only because
           -- scanner-assignment-management.ts's two insert call sites
           -- never set both session_id and room_id on the same row. The
           -- scanner_assignments_scope_check constraint itself is an
           -- inclusive OR (room_id is not null or session_id is not
           -- null), not XOR, so it permits both fields set; if a future
           -- caller ever created such a row, this subquery would widen
           -- past the single session for it too. Not reachable today,
           -- but worth tightening the constraint to a true XOR, or
           -- adding an explicit `and sa.room_id is null` guard here, if
           -- that assumption ever needs to stop being implicit.
           select 1 from scan_attempts sc
           where sc.scanned_by = sa.scanner_user_id
             and sc.created_at > now() - interval '15 minutes'
             and (
               sc.session_id = s.id
               or (sa.room_id is not null and sc.session_id in (select id from sessions where room_id = sa.room_id))
             )
         )),
    (select max(sc.created_at) from scan_attempts sc where sc.session_id = s.id),
    (select count(*)::int from scan_attempts sc where sc.session_id = s.id and sc.created_at > now() - interval '30 minutes'
       and sc.result not in ('admitted', 'flexible_admitted', 'override_admitted')),
    (select coalesce(jsonb_object_agg(breakdown.result, breakdown.cnt), '{}'::jsonb) from (
       select sc.result, count(*) as cnt from scan_attempts sc
       where sc.session_id = s.id and sc.created_at > now() - interval '30 minutes'
         and sc.result not in ('admitted', 'flexible_admitted', 'override_admitted')
       group by sc.result
     ) breakdown)
  from sessions s
  join rooms r on r.id = s.room_id
  where s.status = 'confirmed'
  order by s.start_time, r.name_en, s.id;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, which
-- includes anon -- confirmed live via information_schema.role_routine_grants
-- that PUBLIC had EXECUTE here despite only ever `grant`ing to
-- `authenticated`. The is_staff() coalesce fix above stops an anon
-- caller's RPC from returning data, but revoking PUBLIC here closes the
-- hole at the grant layer too, defense in depth.
revoke execute on function ops_dashboard_snapshot() from public;
grant execute on function ops_dashboard_snapshot() to authenticated;

-- Realtime broadcast trigger. Only job: tell the browser "something
-- changed, re-fetch" -- never computes or transmits the actual business
-- data itself (architecture split described in the spec's scope decision
-- 4). Payload carries only a session_id, nothing else, so it can never
-- leak attendance/applicant data regardless of RLS.
create or replace function notify_ops_dashboard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send( -- CONFIRMED by Task 0: realtime.send(payload jsonb, event text, topic text, private boolean) exists on the live project with this exact signature
    jsonb_build_object('session_id', coalesce(new.session_id, old.session_id)),
    'change',
    'ops-dashboard-events',
    true -- private=true is REQUIRED for the realtime.messages RLS policy
         -- below to apply at all. Found during final branch re-review:
         -- with private=false (the original value), Realtime's RLS check
         -- on realtime.messages is skipped entirely for this channel --
         -- the policy existed but was dead code, and any anon-key client
         -- with no signed-in user could subscribe to 'ops-dashboard-events'
         -- and receive every broadcast. Confirmed live before this fix:
         -- an anon client subscribed and received a test broadcast.
  );
  return new;
end;
$$;

create trigger attendance_records_notify_ops_dashboard
  after insert or update on attendance_records
  for each row execute function notify_ops_dashboard();

create trigger scan_attempts_notify_ops_dashboard
  after insert on scan_attempts
  for each row execute function notify_ops_dashboard();

-- REQUIRED (found missing by Task 0's spike): without this policy, the
-- trigger above inserts into realtime.messages with no SQL error, but
-- RLS on that table (enabled, zero prior policies) silently blocks
-- every subscribing client from ever receiving the broadcast -- but
-- ONLY for a PRIVATE channel (see notify_ops_dashboard()'s `true`
-- private flag above). Realtime only checks RLS on realtime.messages
-- for private channels; a public channel (private=false) bypasses this
-- policy entirely regardless of what it says. This was found live
-- during final branch re-review: the trigger originally sent with
-- private=false while the client subscribed with no private config,
-- so this policy -- despite being correctly written -- was dead code,
-- and any anon-key client with no signed-in user could subscribe and
-- receive every broadcast. `to authenticated` is sufficient -- every
-- real caller of this dashboard is already gated through is_staff(),
-- which requires an authenticated session; there is no need to also
-- admit `anon`.
--
-- This exact policy was already applied directly to this live database
-- during Task 0's spike (to prove the broadcast mechanism end-to-end
-- before this migration existed) and is dropped here first so this
-- migration can (re-)create it cleanly and become the single tracked
-- source of truth for it, rather than leaving an undocumented live-only
-- policy in place alongside this one.
drop policy if exists "ops_dashboard_broadcast_select" on realtime.messages;

-- Scoped to this exact topic AND staff-only -- a bare `extension =
-- 'broadcast'` policy (the original, Task-0-spike-proven shape) would
-- let ANY authenticated user, including participants and scanner
-- devices, read every private broadcast channel in the project, not
-- just this one. Nothing else uses realtime.messages today, so this
-- was latent rather than actively exploitable, but the first future
-- channel for non-staff-visible data would silently inherit this open
-- read policy. realtime.topic() confirmed to exist on this project
-- (pg_proc lookup) with signature topic() returns text.
create policy "ops_dashboard_broadcast_select" on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'ops-dashboard-events'
    and coalesce(is_staff(), false)
  );
