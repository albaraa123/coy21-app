# Sub-project 5a: Live Operations Dashboard — Design

## Problem

The original COY21 project request calls for operational tooling that lets conference staff watch live attendance during the event (5-7 Nov 2026, Antalya, ~500 participants). Today, nothing like this exists: the closest thing, `src/app/[locale]/(admin)/attendance/demand/page.tsx` ("Phase 8.5"), is a single server-rendered snapshot with raw counts per session (capacity, admitted, admitted-priority, admitted-flexible, remaining, an at/over-capacity boolean badge) and zero live update — staff must manually reload the page to see anything new. There is no view of scanner device health, no rejection/problem-rate visibility, and no alerting. Supabase Realtime is not used anywhere in this codebase.

This sub-project (5a of the 6-part platform decomposition; 5b, offline scanning support, is deliberately deferred — see Out of Scope) builds a genuinely live operations dashboard for a centralized control-room team to watch during the conference.

## Scope Decisions

1. **Audience and placement**: a new page, `src/app/[locale]/(admin)/attendance/ops-dashboard/`, gated to the same role set `demand/page.tsx` already uses: `isStaffRole()` (`'staff' | 'super_admin'`). Note: `demand/page.tsx`'s own header comment says "for program_attendance_manager," but that role no longer exists as a distinct value — all staff-domain roles were consolidated into a single `'staff'` enum value during an earlier sub-project (`docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md`). `isStaffRole()` is therefore already the correct, current implementation of "program_attendance_manager + super_admin" in today's role model — this spec reuses it as-is, not introduce anything new.
2. **Four live metrics, chosen by the user as equally important**: (a) actual occupied-count per session plus occupancy percentage, (b) alerts for full/near-full sessions, (c) scanner device health (flagging a device "stale" after 15 minutes with no scan), (d) rejection/problem rate per session (`invalid_qr`, `timeslot_conflict`, `duplicate`, `restricted_denied`, `full`, etc.) over a trailing window.
3. **Live update mechanism**: Supabase Realtime, used here for the first time in this codebase. Chosen over polling because a centralized control-room screen left open for hours benefits from instant updates without a fixed-interval compromise between freshness and request volume.
4. **Architecture split — "RPC for data, Realtime for notification only"**: all actual computation (occupancy, which admission policy applies, priority-release timing, etc.) stays server-side in one RPC, re-invoked on demand. Realtime's only job is telling the browser "something changed, re-fetch" — never computing or transmitting the business data itself. This avoids duplicating the admission-policy logic client-side (a real risk flagged during 4e's final review: client-side deadline logic had already drifted out of sync with server enforcement once before) and keeps a single source of truth.
5. **Realtime transport — broadcast via trigger, not postgres_changes on the base tables**: `attendance_records` and `scan_attempts` have no RLS policies today (default-deny; access is `service_role`-only, enforced at the function level, not the row level — see `qr_credentials`' identical pattern). Subscribing a browser client (anon/authenticated key) directly to `postgres_changes` on these tables would either return nothing (RLS blocks it) or require opening RLS on sensitive attendance data purely to carry a change notification — out of proportion to what's needed. Instead: a lightweight `AFTER INSERT OR UPDATE` trigger on each table calls Supabase's Realtime broadcast helper (`realtime.send(...)`, confirmed as the current Supabase-provided mechanism; exact function name to be verified against the live project's Supabase version during implementation) to a fixed channel, with a minimal payload (at most `{session_id}`, possibly no payload at all — the client doesn't need data, just the fact that something changed). This leaves the existing service-role-only security posture on both tables completely untouched.
6. **Staleness threshold**: a scanner device is flagged "stale" after 15 minutes with no scan, matching the existing no-show cron's threshold from sub-project 4e (`process-session-no-shows`, 15-minute post-session-start threshold) — not because the two thresholds are conceptually related, but to keep a single "15 minutes" mental model across the ops tooling rather than introducing an arbitrary second number.
7. **Rejection-rate window**: a trailing 30-minute window (`scan_attempts.created_at > now() - interval '30 minutes'`), not a cumulative since-conference-start count — the dashboard's job is surfacing an active, ongoing problem (e.g., a scanner misconfigured for the wrong session producing a run of `timeslot_conflict`s right now), not a historical report.
8. **Occupancy source of truth**: the dashboard's occupied-count reuses the existing `session_effective_occupied_count(p_session_id uuid)` RPC (from sub-project 4e) rather than reimplementing an occupancy calculation — this guarantees the number staff see on the dashboard is always identical to the number `book_session`/`join_waitlist`/the capacity-downsize trigger actually enforce, never a second, driftable definition of "how full is this session."
9. **Fallback polling**: in addition to the Realtime-triggered refetch, the dashboard client also polls on a fixed interval (every 30 seconds) as a safety net against a silently-dropped WebSocket connection — a control-room screen that goes stale without any visible indication is worse than one that's merely slightly less instant. The 30-second interval is a deliberate floor under normal conditions (Realtime should make it visually irrelevant most of the time) and a ceiling on how stale the screen can ever silently become.
10. **No new business logic or write paths**: this sub-project is read-only, mirroring `demand/page.tsx`'s own "deliberately read-only" framing. No admission-policy changes, no new mutation RPCs, no changes to the scanner client itself (sub-project 5a doesn't touch `src/components/scanner/` or `/scanner`'s existing camera flow at all).

## Data Model

### New RPC: `ops_dashboard_snapshot()`

```sql
create or replace function ops_dashboard_snapshot() returns table (
  session_id uuid,
  title_en text,
  title_ar text,
  room_name_en text,
  room_name_ar text,
  capacity int,
  occupied_count int,
  occupancy_pct numeric,
  is_full boolean,
  is_near_full boolean,
  scanner_count int,
  stale_scanner_count int,
  last_scan_at timestamptz,
  rejection_count_30m int,
  rejection_breakdown jsonb
) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_staff() then
    raise exception 'Not authorized';
  end if;

  return query
  select
    s.id,
    s.title_en, s.title_ar,
    r.name_en, r.name_ar,
    s.capacity,
    session_effective_occupied_count(s.id),
    round(100.0 * session_effective_occupied_count(s.id) / greatest(s.capacity, 1), 1),
    session_effective_occupied_count(s.id) >= s.capacity,
    session_effective_occupied_count(s.id) >= (s.capacity * 0.9), -- near-full threshold
    (select count(*) from scanner_assignments sa where sa.is_active and (sa.session_id = s.id or sa.room_id = s.room_id)),
    (select count(*) from scanner_assignments sa
       where sa.is_active and (sa.session_id = s.id or sa.room_id = s.room_id)
         and not exists (
           select 1 from scan_attempts sc
           where sc.scanned_by = sa.scanner_user_id and sc.session_id = s.id
             and sc.created_at > now() - interval '15 minutes'
         )),
    (select max(sc.created_at) from scan_attempts sc where sc.session_id = s.id),
    (select count(*) from scan_attempts sc where sc.session_id = s.id and sc.created_at > now() - interval '30 minutes'
       and sc.result not in ('admitted', 'flexible_admitted', 'override_admitted')),
    (select coalesce(jsonb_object_agg(sc.result, sc.cnt), '{}'::jsonb) from (
       select sc.result, count(*) as cnt from scan_attempts sc
       where sc.session_id = s.id and sc.created_at > now() - interval '30 minutes'
         and sc.result not in ('admitted', 'flexible_admitted', 'override_admitted')
       group by sc.result
     ) sc)
  from sessions s
  join rooms r on r.id = s.room_id
  where s.status = 'confirmed';
end;
$$;

grant execute on function ops_dashboard_snapshot() to authenticated;
```

(Exact SQL to be finalized/reviewed during planning — the shape above establishes the contract: one row per confirmed session, every number the dashboard needs precomputed server-side, nothing for the client to calculate.)

**Note on "stale scanner" per-scanner detail**: the snapshot above returns an aggregate `stale_scanner_count` per session for the summary view. If the implementation plan's UI design wants a per-device breakdown (e.g., "Scanner SC-07 last scanned 22 minutes ago"), a second, smaller RPC (`ops_dashboard_scanner_detail(p_session_id uuid)`) can be added — deferred to planning rather than over-specified here, since the clarifying questions settled on "scanner health" as a metric category, not a specific per-device UI.

### Realtime broadcast trigger

```sql
create or replace function notify_ops_dashboard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(
    jsonb_build_object('session_id', coalesce(new.session_id, old.session_id)),
    'change',
    'ops-dashboard-events',
    false  -- public channel; payload carries no sensitive data, only a session_id
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
```

(The exact Supabase Realtime broadcast call — `realtime.send(...)` vs. an alternative helper — must be verified against the live project's current Supabase/Postgres extension version before this migration is written for real; this is a sketch of the intended shape, not verbatim final SQL.)

## UI

- **Page**: `src/app/[locale]/(admin)/attendance/ops-dashboard/page.tsx` — server component, same auth-gate shape as `demand/page.tsx` (`createClient()` + `auth.getUser()` + service-role `profiles.role` lookup + `isStaffRole()` + `notFound()`), fetches the initial snapshot via `ops_dashboard_snapshot()`, passes it to a client component.
- **Client component**: subscribes to the `ops-dashboard-events` broadcast channel; on any message, debounces ~1-2 seconds then re-invokes the snapshot RPC; also polls every 30 seconds as a fallback; re-renders the grid/cards on each new snapshot.
- **Layout**: a top alerts summary (full/near-full sessions, stale scanners, elevated rejection rates, each listed by session/device) above a per-session card grid (mirroring `demand/page.tsx`'s existing mobile-card-list + desktop-table dual layout convention) showing an occupancy bar (green → amber near full → red at capacity), a scanner-staleness badge, and a small rejection-count indicator per session.
- **i18n**: this page lives under `(admin)`, where `demand/page.tsx` uses next-intl (`getTranslations`) — the ops dashboard follows the same convention, not hardcoded English.

## Testing Requirements

1. `ops_dashboard_snapshot()` returns `occupied_count`/`occupancy_pct` matching `session_effective_occupied_count()` exactly for a seeded session with a mix of active bookings and confirmed allocations.
2. `is_full`/`is_near_full` boundary tests at exactly capacity and exactly the near-full threshold.
3. A scanner with a scan within the last 15 minutes is not counted in `stale_scanner_count`; one with no scan in 15+ minutes is.
4. `rejection_count_30m`/`rejection_breakdown` correctly exclude admitted-flavored results and correctly age out scans older than 30 minutes.
5. The RPC rejects a non-staff caller with "Not authorized."
6. The broadcast trigger fires without breaking a normal `attendance_records`/`scan_attempts` insert (regression check against existing scanner-flow live tests).
7. (If feasible in a live-test harness) a Realtime client receives a broadcast event after a seeded insert — otherwise this is verified manually during implementation, since asserting on a WebSocket event in the existing Vitest-against-live-Supabase test style may need a different approach than this codebase's current live-test pattern.

## Out of Scope

- Sub-project 5b: offline scanning support (service worker queue, sync-on-reconnect) — deliberately deferred; the existing online-only design in `use-network-status.ts` is left untouched by this sub-project.
- Any change to the scanner camera flow itself (`src/components/scanner/`, `/scanner` route).
- Any new admission-policy logic, mutation RPC, or write path — this is a read-only dashboard.
- Historical/cumulative reporting (post-conference analytics) — this dashboard is for live, in-the-moment operational awareness only.
- Per-device granular scanner UI beyond an aggregate stale count, unless the implementation plan's UI design determines it's needed (see note under the RPC section above).
