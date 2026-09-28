# Admin Agenda Management — Design Spec

**Phase:** 3 (RCOY MENA 2026 conference platform)
**Status:** Approved by user, pending spec review

## Goal

Give `super_admin` and `agenda_allocation_manager` staff a manual, admin-only interface at `/admin/agenda` to build the full conference agenda: days, tracks, session types, rooms, people (speakers/guests/moderators/facilitators/trainers/session leads), sessions, session-people assignments, and weighted session tags. All data entry is manual. This phase stores the data and enforces its integrity; it does not build clustering, automatic allocation, participant-facing schedules, QR check-in/scanning, attendance tracking, or Excel import.

## Non-Goals (explicit, confirmed with user)

- Clustering or automatic session allocation logic
- Participant-facing schedule/agenda display
- QR code generation or scanning
- Attendance tracking
- Excel/CSV import of agenda data
- Any background/scheduled job (e.g. auto-marking sessions `completed` when their end time passes — this remains a manual admin action)

Fields supporting future phases (`include_in_allocation`, `allocation_priority`, `session_tags` weights, `enable_qr_checkin`, `checkin_opens_at`/`checkin_closes_at`) are stored now as inert data with integrity constraints, but no logic in this phase reads or acts on them beyond validating their own consistency.

## Access Control

- Route group `/admin/agenda` (mirrors Phase 2's `(admin)` route group pattern).
- Every page: session-client `auth.getUser()` → redirect to `/log-in` if unauthenticated → service-role client role lookup → `notFound()` (404, not redirect) if role is not `super_admin` or `agenda_allocation_manager`.
- RLS enabled on every new table, policies scoped to `current_user_role() in ('agenda_allocation_manager', 'super_admin')`, in addition to (not instead of) the route-level and server-action-level checks — defense in depth, matching Phase 2's documented rationale (RLS is a backstop; the server action's own check is the operative gate because all writes go through the service-role client, which bypasses RLS).
- **Every server action independently**: authenticates the real session user via the request-scoped client, verifies the caller's role is `super_admin` or `agenda_allocation_manager` (reusing/extending `isAdmissionStaffRole`-style logic — likely renamed or generalized to an agenda-specific check since the role set differs from Phase 2's), validates all input via Zod, passes the *verified* caller's profile id as `actor_id` on every audit log write, and writes the audit log row itself. The service-role client's use for the actual table writes never implies trust in a claimed identity — `actor_id` is always the id resolved from the authenticated session, never a client-supplied value.
- The Supabase service-role key is never imported into or reachable from any `'use client'` component — enforced by the same `src/lib/supabase/server.ts` factory pattern already used in Phases 1–2, where `createServiceRoleClient()` lives in a server-only module.
- **`updated_by` follows the identical rule as `actor_id`, and is a new convention for this codebase** (Phase 1/2 only have `updated_at`, populated by an `extensions.moddatetime` trigger — that trigger has no notion of an app-level actor and cannot populate `updated_by`). Every table's `updated_by` column (`uuid references profiles(id)`) is set explicitly, by every server action, on every insert/update, to the same verified caller id used for `actor_id` — never left to a trigger, never inferred, never client-supplied. `updated_at` continues to use `moddatetime` as in Phase 1/2; only `updated_by` is the server action's responsibility.

## Timezone Convention

All conference scheduling is Asia/Muscat (UTC+4, no DST). `sessions.start_time`, `sessions.end_time`, `sessions.checkin_opens_at`, `sessions.checkin_closes_at`, and `conference_days.conference_date` (see below) are stored as `timestamptz` (UTC internally, per Postgres convention) or `date`. All app-layer formatting/parsing (forms, display, validation messages) treats those values as Asia/Muscat. The day-matching trigger (see Data Model) explicitly converts `start_time`/`end_time` to Asia/Muscat before comparing against `conference_days.conference_date`.

## Data Model

### Enums

```sql
create type session_status as enum ('draft', 'published', 'confirmed', 'cancelled', 'completed');
create type session_person_role as enum ('speaker', 'guest', 'moderator', 'facilitator', 'trainer', 'session_lead');
create type session_language as enum ('ar', 'en', 'bilingual');
create type session_difficulty as enum ('beginner', 'intermediate', 'advanced', 'all_levels');
create type audit_actor_type as enum ('admin', 'system');
```

### `conference_days`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| conference_date | date | not null, unique |
| label_ar | text | not null |
| label_en | text | not null |
| display_order | int | not null |
| is_active | bool | not null default true (soft-delete flag) |
| created_at / updated_at / updated_by | | standard |

### `tracks`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| code | text | not null, unique — stable identifier independent of display name |
| name_ar / name_en | text | not null |
| color | text | nullable, for UI |
| is_active | bool | not null default true |
| created_at / updated_at / updated_by | | standard |

### `session_types`

Same shape as `tracks` (id, code unique, name_ar, name_en, is_active, standard timestamps) — no `color`.

### `rooms`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| code | text | not null, unique |
| name_ar / name_en | text | not null |
| capacity | int | not null, `check (capacity > 0)` |
| location | text | nullable (building/area) |
| floor | text | nullable |
| is_accessible | bool | not null default false |
| is_active | bool | not null default true |
| created_at / updated_at / updated_by | | standard |

### `people`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| full_name_ar / full_name_en | text | not null |
| title_ar / title_en | text | nullable |
| organization_ar / organization_en | text | nullable |
| bio_ar / bio_en | text | nullable |
| photo_path | text | nullable — Supabase Storage object path, not a public URL |
| email / phone | text | nullable |
| linked_profile_id | uuid | nullable, **unique**, `references profiles(id)` — optional tie to a real platform account |
| is_active | bool | not null default true (soft-delete flag) |
| created_at / updated_at / updated_by | | standard |

### `tags`

Same shape as `tracks` minus `color` (id, code unique, name_ar, name_en, is_active, standard timestamps).

### `sessions`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| session_code | text | not null, unique, admin-entered free text |
| title_ar / title_en | text | not null |
| description_ar / description_en | text | nullable |
| conference_day_id | uuid | not null, `references conference_days(id)` |
| start_time / end_time | timestamptz | not null; `check (end_time > start_time)` |
| track_id | uuid | not null, `references tracks(id)` |
| session_type_id | uuid | not null, `references session_types(id)` |
| room_id | uuid | not null, `references rooms(id)` |
| language | session_language | not null |
| difficulty_level | session_difficulty | not null |
| capacity | int | not null, `check (capacity > 0)` |
| min_capacity | int | not null default 0, `check (min_capacity >= 0)`, `check (min_capacity <= capacity)` |
| is_mandatory | bool | not null default false |
| is_public | bool | not null default true |
| include_in_allocation | bool | not null default true (inert — future clustering phase) |
| allocation_priority | int | not null default 0 (inert — future clustering phase) |
| enable_qr_checkin | bool | not null default false |
| checkin_opens_at / checkin_closes_at | timestamptz | nullable; see Validation Rules |
| status | session_status | not null default 'draft' |
| internal_notes | text | nullable, admin-only, never shown to participants |
| published_at / confirmed_at / cancelled_at | timestamptz | nullable, set by the server action on the corresponding transition |
| cancellation_reason | text | nullable, required when status becomes `cancelled` — enforced in Zod, in the server action, AND in the `enforce_session_status_transition` trigger (see Triggers below), so a direct DB update bypassing the server action cannot cancel a session without a reason either |
| created_at / updated_at / updated_by | | standard |

**Constraints:**

```sql
alter table sessions add constraint sessions_end_after_start check (end_time > start_time);
alter table sessions add constraint sessions_min_capacity_valid check (min_capacity >= 0 and min_capacity <= capacity);
alter table sessions add constraint sessions_capacity_positive check (capacity > 0);
alter table sessions add constraint sessions_checkin_window_order check (
  checkin_opens_at is null or checkin_closes_at is null or checkin_opens_at < checkin_closes_at
);
alter table sessions add constraint sessions_checkin_window_required check (
  enable_qr_checkin = false or (checkin_opens_at is not null and checkin_closes_at is not null)
);

-- Room double-booking: draft, published, and confirmed sessions all block the room.
-- Cancelled and completed sessions do not.
create extension if not exists btree_gist;

alter table sessions add constraint sessions_room_no_overlap
  exclude using gist (
    room_id with =,
    tstzrange(start_time, end_time, '[)') with &&
  ) where (status in ('draft', 'published', 'confirmed'));
```

**Triggers:**

1. **`enforce_session_day_match`** (`before insert or update of start_time, end_time, conference_day_id on sessions`): converts `start_time` and `end_time` to `Asia/Muscat`, confirms both fall on the same calendar date, and confirms that date equals `conference_days.conference_date` for the row's `conference_day_id`. Raises an exception if either check fails (a session cannot span midnight into a different conference day, and cannot be scheduled against a day it doesn't belong to).

2. **`enforce_session_status_transition`** (`before update of status on sessions`): looks up `OLD.status → NEW.status` against a hardcoded transition table mirroring the Zod-side `VALID_TRANSITIONS` (see Validation Rules), raises an exception if the transition isn't in the allowed set. `OLD.status = NEW.status` (no-op update) is always allowed. Additionally, when `NEW.status = 'cancelled'`, raises an exception if `NEW.cancellation_reason is null` — this makes the trigger a complete defense-in-depth backstop for cancellation (not just the transition itself), so a direct DB update bypassing the server action cannot produce a reason-less cancellation. This mirrors exactly what the server action already validates in Zod, per the "never trust a single layer" principle stated in Access Control.

3. **`enforce_session_room_capacity`** (`before insert or update of capacity, room_id on sessions`): raises an exception if `NEW.capacity > (select capacity from rooms where id = NEW.room_id)`.

4. **`revalidate_sessions_on_room_capacity_change`** (`before update of capacity on rooms`): raises an exception if any session referencing this room (status in draft/published/confirmed) has `capacity > NEW.capacity`. This makes a room-capacity reduction fail transactionally rather than silently orphaning an over-capacity session — the admin must first reduce or reassign the conflicting sessions' capacity before shrinking the room. (Alternative considered: silently cascading a downward adjustment to affected sessions' capacity — rejected because silently changing a session's stated capacity without admin awareness is a worse outcome than a blocked room edit with a clear error listing the conflicting sessions.)

**Deactivation of referenced entities (`tracks`, `session_types`, `rooms`, `people`, `tags`, `conference_days` — all `is_active`-flag soft-deletes):** the same principle as trigger 4 applies uniformly — **deactivating a reference row does not touch or invalidate any existing session that already references it.** `is_active = false` only removes the row from *new-selection* pick-lists in the UI (a deactivated room/track/person/tag can no longer be *newly assigned* to a session, enforced in the server action's Zod/lookup validation, not the DB — the FK itself has no `is_active` awareness). Existing `sessions`/`session_people`/`session_tags` rows that already reference a now-inactive entity keep working exactly as before; the admin sees the (now-labeled-inactive) name wherever that session is displayed. This is a deliberate, uniform choice — matching room-capacity trigger 4's "block, never silently cascade a change onto existing sessions" philosophy, but here nothing needs blocking at all, since deactivation only affects future selection, not existing references. No trigger is needed to enforce this: it falls directly out of `is_active` being an ordinary boolean column with no FK-level `on delete`/`on update` behavior tied to it (there's nothing to cascade, since deactivation is an UPDATE of `is_active`, not a DELETE of the row).

### `session_people` (join)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| session_id | uuid | not null, `references sessions(id) on delete cascade` |
| person_id | uuid | not null, `references people(id)` |
| role | session_person_role | not null |
| display_order | int | not null default 0 |
| is_primary | bool | not null default false |
| created_at / updated_at / updated_by | | standard |

**Constraints:** `unique(session_id, person_id, role)` — the same person can hold multiple distinct roles on one session (e.g. moderator and trainer) but not the same role twice. `is_primary` has no exclusivity constraint — multiple `session_people` rows for the same session may have `is_primary = true` simultaneously (e.g. co-primary moderators are allowed); this is a display-hint flag only, not a single-primary-per-session invariant.

**Speaker conflict enforcement** (trigger-based, not a GiST exclude, since the time range lives on `sessions` not `session_people`):

- **`enforce_speaker_no_conflict`** (`before insert or update of session_id, person_id, role on session_people`): for the affected `person_id`, queries all *other* `session_people` rows for that person whose `session_id` maps to a session in status draft/published/confirmed, joins to `sessions` for the time range, and raises an exception if the new/updated row's session time range overlaps any of them (using `tstzrange(...) && tstzrange(...)`). Runs regardless of `role` — a person double-booked as both "speaker" in one session and "moderator" in an overlapping session is still a conflict.
- **`enforce_speaker_no_conflict_on_session_change`** (`before update of start_time, end_time, status on sessions`): when a session's time range or status changes, re-runs the same overlap check for every person currently assigned to that session via `session_people` (excluding the session itself), raising an exception if the new time/status now conflicts with any of that person's other active sessions. This closes the gap where a session's *own* time changes after its speakers were already assigned without conflict.
- **Multi-step transaction safety**: these two triggers each validate against the state visible *at the moment they fire*. If a single server action performs multiple writes in one transaction — e.g. `updateSession` changing `start_time` and, in the same call, also reassigning `session_people` rows — each trigger only checks the sub-state current when its own statement runs, so the two checks together do not guarantee the *final* combined state (after all statements in the transaction) is conflict-free; a scenario where each individual write looks valid in isolation but the combined result is not can only be caught by re-checking after all writes complete. To close this, **any server action that modifies both a session's schedule (`start_time`/`end_time`/`status`) and its `session_people` rows in the same call must, as its last step before returning success, re-run the conflict-check query once more for every person currently assigned to that session** (the same query the triggers use), and roll back/error if it finds a conflict. This is redundant with the triggers in the common case (each individual write is independently valid) and only matters for the specific multi-write-in-one-transaction scenario; it is enforced in the server action, not a new trigger, since it needs to run once at the end of a variable-length sequence of writes rather than being tied to any single column change.

### `session_tags` (join)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| session_id | uuid | not null, `references sessions(id) on delete cascade` |
| tag_id | uuid | not null, `references tags(id)` |
| weight | numeric | not null, `check (weight >= 0 and weight <= 1)` |
| created_at / updated_at / updated_by | | standard |

**Constraints:** `unique(session_id, tag_id)`.

### `audit_logs`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| entity_type | text | not null (e.g. `'session'`, `'room'`, `'session_people'`) |
| entity_id | uuid | not null |
| action | text | not null (e.g. `'create'`, `'update'`, `'delete'`, `'publish'`, `'cancel'`, `'status_change'`) |
| actor_type | audit_actor_type | not null default `'admin'` |
| actor_id | uuid | nullable, `references profiles(id)` — null only for `actor_type = 'system'` rows, which nothing in this phase writes; every admin-initiated write sets this to the verified session user's profile id |
| request_id | uuid | nullable — correlates multiple audit rows from a single logical operation (e.g. a session update that also touches `session_people`) |
| metadata | jsonb | nullable — free-form context (e.g. which fields changed, a human-readable summary) |
| old_values | jsonb | nullable |
| new_values | jsonb | nullable |
| created_at | timestamptz | not null default now() |

No RLS write policy for clients (default-deny, same as `application_status_history`/`email_log` in Phase 1) — only the service-role client writes, and only from within a server action that has already independently verified the caller.

`entity_type` is deliberately free text, not an enum — unlike the closed sets used for `session_status`/`session_person_role`/etc., new entity types are expected to be added to this module (and future phases) without a migration, so an enum here would defeat the table's purpose as a generic, extensible log.

### Indexes

Every foreign key column gets a btree index (`conference_day_id`, `track_id`, `session_type_id`, `room_id` on `sessions`; `session_id`, `person_id`, `tag_id` on the join tables; `linked_profile_id` on `people`; `entity_id` and `actor_id` on `audit_logs`). Additional composite indexes for common agenda filters: `sessions(status, conference_day_id)`, `sessions(status, track_id)`, `sessions(room_id, start_time)`, `audit_logs(entity_type, entity_id, created_at desc)`.

A further composite index, `session_people(person_id, session_id)`, exists specifically for `enforce_speaker_no_conflict`'s hot path — this trigger runs on *every* insert/update to `session_people` (not just admin-facing filtering), so its "find all other sessions this person is on" lookup benefits from an index distinct from the single-column `person_id` FK index above.

## Validation Rules (Zod + server action, mirrored by DB constraints/triggers above)

Server-side validation happens in two layers: Zod schemas validate shape/format before any DB call (fast-fail, good error messages), and the database constraints/triggers above are the actual source of truth (defense in depth — a Zod bug or a future direct-SQL write cannot violate these invariants).

- **End time after start time**: Zod schema check + `sessions_end_after_start` DB constraint.
- **Duplicate session codes**: Zod cannot check uniqueness (requires a DB round-trip); the server action queries for an existing `session_code` before insert/update as a fast-fail, and the table's `unique` constraint is the actual guarantee (race-safe).
- **Overlapping sessions in the same room**: `sessions_room_no_overlap` EXCLUDE constraint is authoritative; the server action catches the resulting Postgres error (a specific exclusion-violation error code) and surfaces a clear message rather than a raw DB error.
- **Overlapping sessions for the same speaker**: `enforce_speaker_no_conflict`/`enforce_speaker_no_conflict_on_session_change` triggers are authoritative; same catch-and-translate pattern in the server action.
- **Session capacity exceeding room capacity**: `enforce_session_room_capacity` trigger is authoritative; server action pre-checks for a fast-fail UX, same catch-and-translate pattern.
- **Invalid conference dates**: `conference_days.conference_date` uniqueness (DB constraint) plus Zod-level sanity checks (e.g. date falls within a configured conference date range, if the admin wants that guardrail — open question, see below).
- **Missing required fields/relationships**: Zod `.min(1)`/required-field checks on every not-null column before the DB call; DB `not null` constraints are the backstop.
- **Status transitions**: `VALID_TRANSITIONS` map in `src/lib/validation/agenda.ts` (or similar), structurally identical in shape to Phase 2's admission-review transitions but with agenda's own graph:
  ```
  draft: ['published'],
  published: ['confirmed'],
  confirmed: ['completed'],
  cancelled: [],
  completed: [],
  ```
  plus `cancelled` reachable from `draft`, `published`, and `confirmed` (added as extra allowed targets from those three states, not from `completed`). Mirrored exactly in the `enforce_session_status_transition` DB trigger's hardcoded table.
- **Check-in window**: `checkin_opens_at < checkin_closes_at` (when both present) and "both required if `enable_qr_checkin = true`" — both enforced as DB `check` constraints (shown above) and mirrored in Zod for fast-fail.

## Server Actions (surface, not full implementation)

One actions file per major entity, following Phase 2's `(admin)/applications/[id]/actions.ts` pattern (a `requireAgendaStaffCaller()` helper analogous to `requireStaffCaller()`, reused across all agenda entity actions):

- `conference-days/actions.ts`: `createConferenceDay`, `updateConferenceDay`, `deactivateConferenceDay`
- `tracks/actions.ts`, `session-types/actions.ts`, `rooms/actions.ts`, `tags/actions.ts`: same CRUD + deactivate shape per entity
- `people/actions.ts`: `createPerson`, `updatePerson`, `deactivatePerson`
- `sessions/actions.ts`: `createSession`, `updateSession`, `updateSessionStatus` (wraps the transition check), `assignSessionPerson`, `removeSessionPerson`, `setSessionTags`

Every mutating action: authenticates → verifies role → validates via Zod → performs the write via the service-role client → writes one (or more, sharing a `request_id`) `audit_logs` row with `actor_id` set from the verified session, never inferred.

## Pages (surface)

- `/admin/agenda` — overview/dashboard linking to each sub-section
- `/admin/agenda/days`, `/admin/agenda/tracks`, `/admin/agenda/session-types`, `/admin/agenda/rooms`, `/admin/agenda/people`, `/admin/agenda/tags` — list + create/edit for each reference entity
- `/admin/agenda/sessions` — list with filters (day, track, room, status)
- `/admin/agenda/sessions/[id]` — detail/edit page: all session fields, speaker/guest assignment, tag weighting, status transition controls

Exact page-level UI is deferred to the implementation plan (per-task, following Phase 2's precedent of writing full code in the plan itself).

## Testing Requirements

Per user requirement, the RLS/behavioral test suite (live hosted Supabase project, same pattern as Phase 1/2) must cover:

1. Adjacent, non-overlapping sessions in the same room — both succeed.
2. Overlapping room bookings — second insert/update fails with a clear error.
3. Speaker conflict created by changing an *existing* session's time (not just at creation) — covers `enforce_speaker_no_conflict_on_session_change` specifically.
4. Mismatched conference day and timestamp — a session's `start_time`/`end_time` (in Asia/Muscat) not matching its `conference_day_id`'s `conference_date` is rejected.
5. Room capacity reduction — reducing a room's `capacity` below an existing active session's `capacity` is rejected; reducing it to a value that still accommodates all active sessions succeeds.
6. Invalid status transitions — every disallowed transition in the graph is attempted and rejected, both at the Zod/server-action layer and (at least once, to confirm defense-in-depth) via a direct DB update bypassing the server action. The direct-DB-update case specifically means: using the **service-role client** (the same client the server actions themselves use to write) to attempt the update directly, skipping the server action's own role/Zod checks entirely. This proves the DB trigger is a real backstop independent of the server action, not merely that RLS blocks a lower-privileged client — RLS is a separate, already-covered concern (Testing Requirement 7 below covers unauthorized access; this requirement covers "what if the server action's own logic has a bug or is bypassed entirely").
7. Unauthorized direct server-action calls — a `participant` and a wrong-role staff member (e.g. `registration_admission_manager`, which is staff but not agenda staff) are both rejected by every agenda server action, tested directly (not inferred from RLS), mirroring Phase 2's explicit server-action-authorization test requirement.

## Open Questions for Plan-Writing Stage

These don't block spec approval but should be resolved with concrete decisions in the implementation plan:

1. Whether `conference_days.conference_date` needs an application-level sanity range (e.g. "must be within the conference's overall date span") or uniqueness alone is sufficient guarding.
2. Exact Postgres error code(s) for EXCLUDE-constraint and trigger-raised violations (`23P01` for exclusion violations; custom `RAISE EXCEPTION` SQLSTATEs for the triggers), to be confirmed during implementation so the server action's catch-and-translate logic matches real error codes rather than guessed ones.
