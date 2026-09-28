# Flexible Admission, QR Check-In & Attendance — Design Spec

**Phase:** 6 (RCOY MENA 2026 conference platform)
**Status:** Spec-reviewer pass complete (7 findings fixed: false precedent citation, missing late-entry-cutoff enforcement branch, unaddressed legacy QR-checkin columns, operator-confirmation divergence handling, missing participant-dashboard copy, missing Implementation Phases section, missing audit-trail/late-cutoff test cases). Pending final user review.

## Goal

Shift the platform from "allocation = mandatory attendance" to **"flexible participant choice with controlled entry."** Participants receive a personalized recommended schedule (unchanged allocation engine), but are not forced to attend only their recommended sessions. Physical room entry is decided at the door by a new admission-policy/capacity layer plus a QR scan + operator confirmation, which becomes the final operational authority for attendance — independent of what the allocation engine recommended.

## Non-Goals (explicit, confirmed with user)

- Rewriting the existing matching algorithm (`run-allocation.ts`'s deferred-acceptance + top-N mandatory pass, `hard-constraints.ts`, `scoring.ts`, `time-slot-grouping.ts`). It stays untouched; only its *output's meaning* is reinterpreted.
- Removing or renaming `allocation_assignments`/`allocation_alternatives`/`allocation_issues` tables. They keep their existing shape; new columns/values are additive.
- A persisted "walk-in occupancy" concept beyond confirmed check-ins (see Attendance Semantics below) — no live people-counting sensor, no automatic checkout-on-timeout.
- Dropping `sessions.is_mandatory` in this phase. The column becomes unused by new logic but is not removed from the schema yet (separate future migration, only after the new system is proven stable).
- `sessions.enable_qr_checkin`, `checkin_opens_at`, `checkin_closes_at` — these pre-existing placeholder columns (added in Phase 3, never read by any code) are **superseded by this spec's `admission_policy`/`priority_release_at`/`late_entry_cutoff_minutes` fields**, not reused or merged with them. New logic never reads the old three columns. They are left in the schema unused (same treatment as `is_mandatory`) rather than dropped now, to avoid two migrations touching the same table's semantics in one phase. A future cleanup migration should drop all four legacy columns (`is_mandatory`, `enable_qr_checkin`, `checkin_opens_at`, `checkin_closes_at`) together once the new system is proven stable.
- Building the actual Scanner PWA UI/offline-sync behavior in full detail here — this spec defines the server-side contract (RPC, roles, decision logic) the PWA calls into; PWA-specific offline-queueing design is a follow-up spec once this backend is approved.
- Redesigning `program_attendance_manager`'s existing agenda/allocation/schedule RLS grants (built in the prior session) — only additive grants for the new attendance tables are in scope.

## Terminology (binding for code, UI, and reports)

| Term | Meaning |
|---|---|
| **Recommended session** | The participant's top-ranked successful `allocation_assignments` row for a timeslot. Never described as "assigned" or "mandatory" in any user-facing text. |
| **Priority-access entitlement** / **provisional priority reservation** | The fact that a recommended participant gets priority admission consideration at the door. Never called a "reserved seat" — it can expire (release timing) and is not a guarantee of physical entry. |
| **Admitted / check-in confirmed** | A row in `attendance_records` with `status = 'admitted'` — the operator confirmed physical entry after a scan. |
| **Rejected** | A scan attempt that did not result in entry (`scan_attempts.result` in a failure state). Never creates an `attendance_records` row. |
| **Transferred / corrected** | An `attendance_records` row whose `status` became `'transferred_out'` or `'corrected'` via an explicit admin action, with a linked successor row. |
| **Actual attendance** | The set of `attendance_records` rows with `status = 'admitted'` — the only source of truth for "who really entered which session." |

## Architecture — Three Layers

1. **Recommendation layer** (existing, unchanged code): `allocation_assignments` represents the participant's recommended session, expected-demand signal, and priority-access entitlement for a timeslot. It never represents confirmed or mandatory attendance.
2. **Admission-policy & capacity layer** (new): resolves, at any moment, whether a specific participant may enter a specific session right now — based on the session's `admission_policy`, priority/flexible seat state, release timing, hard capacity, and any active override.
3. **Actual-attendance layer** (new): the QR scan → operator confirmation → `attendance_records` insert flow. This is the sole operational authority for physical entry; it consults but is never overridden by the recommendation layer.

Each layer is independently testable and independently modifiable — changing admission policy never touches the matching algorithm; changing QR/scanner logic never touches allocation or admission-policy resolution.

## Data Model

### `sessions` — new columns (additive)

| column | type | notes |
|---|---|---|
| admission_policy | text not null default `'priority_then_open'` | `check in ('open','priority_then_open','restricted','plenary','cross_cutting')` |
| priority_seats | int, nullable | `check (priority_seats is null or (priority_seats between 0 and capacity))`. `null` means "all seats are priority seats" (equivalent to `priority_seats = capacity`). |
| priority_release_at | timestamptz, nullable | absolute release time for unused priority seats |
| priority_release_minutes_before | int, nullable | relative alternative to `priority_release_at` (minutes before `start_time`); if both are null, priority seats never auto-release (manager must open flexible entry manually) |
| late_entry_cutoff_minutes | int, nullable | minutes after `start_time` after which normal (non-override) entry is blocked |
| flexible_entry_manual_override | boolean, nullable | `null` = automatic (governed by release timing); `true`/`false` = manager-forced open/closed, takes precedence over automatic timing |

`sessions.is_mandatory` is left in place, unused by any new logic, and untouched by this migration (see Non-Goals).

### `attendance_records` (new)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| application_id | uuid not null, references applications(id) | |
| session_id | uuid not null, references sessions(id) | |
| time_slot_group_key | text not null | denormalized copy of the allocation engine's slot-grouping key, computed at scan time — lets conflict checks run without joining back to `allocation_assignments` |
| status | text not null default `'admitted'` | `check in ('admitted','rejected','transferred_out','corrected')` — note: `'rejected'` here refers to a status transition only used internally by correction flows; ordinary scan rejections never create a row at all (they live only in `scan_attempts`) |
| entry_type | text not null | `check in ('priority','flexible','override')` |
| admitted_at | timestamptz not null default now() | |
| scanned_by | uuid not null, references profiles(id) | the `scanner_device` account or supervisor who confirmed |
| device_identifier | text, nullable | |
| superseded_attendance_id | uuid, nullable, references attendance_records(id) | set on the *old* row when transferred/corrected, pointing forward is not needed — the new row's existence plus this backward link is sufficient to reconstruct history |
| correction_reason | text, nullable | required (app-layer, not DB constraint) whenever status becomes `transferred_out`/`corrected` |
| created_at | timestamptz not null default now() | |

Unique partial index: `(application_id, session_id) where status = 'admitted'` — prevents a genuinely duplicate *active* admission (a corrected/transferred-out row does not block a new admission for the same pair).

### `scan_attempts` (new)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| application_id | uuid, nullable, references applications(id) | nullable: an invalid/unresolvable QR never identifies a participant |
| session_id | uuid, nullable, references sessions(id) | |
| scanned_by | uuid not null, references profiles(id) | |
| device_identifier | text, nullable | |
| result | text not null | `check in ('admitted','flexible_admitted','priority_hold','full','restricted_denied','duplicate','timeslot_conflict','invalid_qr','override_admitted')` |
| resulting_attendance_id | uuid, nullable, references attendance_records(id) | set only when the attempt produced a new admission |
| metadata | jsonb, nullable | e.g. which existing attendance row caused a duplicate/conflict result |
| created_at | timestamptz not null default now() | |

Every scan attempt is recorded here regardless of outcome — this is the complete audit trail for confirmations, rejections, and conflicts.

### `scanner_assignments` (new)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| scanner_user_id | uuid not null, references profiles(id) | |
| room_id | uuid, nullable, references rooms(id) | |
| session_id | uuid, nullable, references sessions(id) | |
| is_active | boolean not null default true | |
| assigned_by | uuid not null, references profiles(id) | |
| assigned_at | timestamptz not null default now() | |

`check (room_id is not null or session_id is not null)` — every assignment must scope to at least a room or a specific session. Multiple rows per `scanner_user_id` are allowed (a device covering several sessions), and multiple rows may share the same `room_id`/`session_id` (several devices covering one busy door).

### `allocation_issues` — new allowed `issue_type` value

`issue_type` is a plain `text` column with a `check` constraint (not a Postgres enum — confirmed against `20260723100000_allocation_tables.sql`), so this is a single ordinary migration (drop + recreate the constraint), not an isolated-enum-value migration:

```sql
alter table allocation_issues drop constraint allocation_issues_issue_type_check;
alter table allocation_issues add constraint allocation_issues_issue_type_check
  check (issue_type in ('unassigned','low_confidence','capacity_bottleneck','schedule_conflict','no_eligible_sessions','priority_pool_exceeded'));
```

### `user_role` — new enum value (isolated migration, per existing convention)

```sql
alter type user_role add value 'scanner_device';
```

Display label: **"QR & Attendance Operator"** / **"مسؤول المسح وتسجيل الحضور"**.

## Recommendation-to-Priority-Pool Validation

The existing allocation algorithm fills sessions up to `sessions.capacity` (it has no concept of `priority_seats`). When `priority_seats < capacity`, the algorithm can recommend more participants for a session than its configured priority pool — this is expected and *not* a bug to fix by touching the algorithm.

**Resolution (report, don't block):** immediately after `runAllocation` completes (no change to the algorithm itself), a new post-processing step compares, per session in the run:

```
recommended_count = count(allocation_assignments where session_id = X, status in ('proposed','confirmed'))
effective_priority_pool = coalesce(session.priority_seats, session.capacity)
if recommended_count > effective_priority_pool:
    insert into allocation_issues (issue_type='priority_pool_exceeded', session_id, details jsonb)
```

This never blocks run confirmation — it surfaces exactly like the existing `capacity_bottleneck`/`low_confidence` issues in the admin review UI, for `program_attendance_manager`/`super_admin` to resolve (raise `priority_seats`, or accept it since `priority_then_open` already absorbs overflow at the door via flexible entry once release timing hits).

## Effective Admission-Policy Resolution

Pure function, unit-testable in isolation, called both by the transactional scan RPC (for real decisions) and by the dynamic-alternatives lookup (for preview-only availability checks):

```
resolveAdmissionDecision(participant, session, now, existingAttendanceForParticipant, sessionCounts, isOverrideCaller):
  1. if participant already has an 'admitted' row for this exact session → 'duplicate'
  2. if participant already has an 'admitted' row for a DIFFERENT session with the same time_slot_group_key → 'timeslot_conflict'
  3. if session.status != 'confirmed' → reject (not open for entry)
  4. if isPastLateEntryCutoff(session, now) and not isOverrideCaller → reject as late-entry-blocked
     [session.late_entry_cutoff_minutes is null → this check never fires. Otherwise: now > session.start_time + late_entry_cutoff_minutes.
      This check applies to EVERY policy branch below — a restricted/priority/flexible entry attempt past cutoff is blocked the same way,
      unless the caller is program_attendance_manager/super_admin performing an explicit admitOverride, which bypasses this step entirely.]
  5. if sessionCounts.total_admitted >= session.capacity → 'full'
  6. switch session.admission_policy:
     'restricted':
       if not isRecommended(participant, session) → 'restricted_denied' (overridable by program_attendance_manager/super_admin only)
       else → 'admitted' (entry_type='priority')
     'plenary' | 'open' | 'cross_cutting':
       → 'flexible_admitted' (entry_type='flexible')   [step 5's capacity check already gates this]
     'priority_then_open':
       if isRecommended(participant, session):
         → 'admitted' (entry_type='priority')            [priority participants are prioritized ahead of flexible admission, but are still subject to the same step-5 capacity check as everyone else — priority_seats is a door-timing threshold controlling WHEN non-recommended participants may enter, not a second hard cap, and it is not a guarantee of entry once total capacity is reached]
       else:
         priority_used = sessionCounts.admitted_priority_count
         released = isPriorityReleased(session, now)       [manual override wins; else compares now to priority_release_at / start_time - priority_release_minutes_before]
         flexible_pool = (session.capacity - effective_priority_pool)
                         + (released ? max(0, effective_priority_pool - priority_used) : 0)
         if sessionCounts.total_admitted < session.capacity and sessionCounts.admitted_flexible_count < flexible_pool:
           → 'flexible_admitted' (entry_type='flexible')
         else:
           → 'priority_hold'
```

`isRecommended(participant, session)` = an `allocation_assignments` row exists for this `(application_id, session_id)` with `status in ('proposed','confirmed')`.

A `priority_hold` result has no separate "resume" mechanism — the operator simply re-scans later (offering the participant a wait, an alternative session, or a supervisor-override request in the meantime). A later re-scan re-runs this same function from scratch with fresh `now`/`sessionCounts`, and naturally resolves to `flexible_admitted` once release timing or capacity conditions change; no queued/pending state is persisted for a hold.

## Dynamic Alternatives (not persisted)

Alternatives are computed on demand, never stored as a new table:

```
getAlternativesForTimeslot(application_id, time_slot_group_key):
  candidates = sessions where
    time_slot_group_key matches (reusing the existing allocation-time grouping logic)
    and admission_policy in ('open','cross_cutting','priority_then_open')
    and status = 'confirmed'
    and id != the recommended session
  for each candidate: compute a live availability preview via the same resolveAdmissionDecision logic (read-only, no scan_attempts row)
  order: candidates present in this participant's existing allocation_alternatives rows first (by their stored rank, reused purely as a display-priority hint), then any other open/cross_cutting session in the slot
```

`allocation_alternatives` (existing table) is reused exactly as-is for ranking hints only — never rewritten or repurposed as the alternatives source of truth.

## Participant Experience & Dashboard

The existing participant schedule page (`(participant)/(shell)/schedule/page.tsx`, `day-timeline.tsx`, `session-card.tsx`) is extended, not replaced. Per timeslot, the participant sees:

- **Recommended session** — title, track relevance, language, room, and a clearly non-coercive framing (see copy below). The existing "Mandatory"/"Elective" badge (`session-card.tsx`) is removed entirely, replaced by the session's `admission_policy` shown in plain language (e.g. "Open entry," "Priority seating," "Limited — approval required").
- **Priority-access indicator** — a small, factual note when the participant has priority-access entitlement for the recommended session (not a "reserved" claim).
- **Alternative sessions available in the same timeslot** — the `getAlternativesForTimeslot` output, shown as a secondary, clearly-labeled list under the recommended session, not as equal-weight competing options.
- **Actual attendance** — once `attendance_records` has an `admitted` row for a timeslot, the schedule view shows what the participant actually attended, which may differ from the recommended session. Both are shown, never one overwriting the other.

**Required copy (exact strings, en/ar, to be added to `src/messages/{en,ar}.json`)**:

> EN: "Your schedule is personalized based on your interests. You may attend another available session during the same time slot where capacity and entry policy allow."
> AR: "جدولك مخصّص بناءً على اهتماماتك. يمكنك حضور جلسة أخرى متاحة بنفس الفترة الزمنية إذا سمحت السعة وسياسة الدخول بذلك."

This notice appears once, prominently, near the top of the schedule page — not repeated per session card. Individual session cards use neutral, factual policy labels (per the bullet above) rather than repeating the full notice.

The participant-facing UI never exposes: `allocation_assignments.suitability_score`, `priority_seats` counts, `admitted`/`flexible_admitted` internal codes, or any other staff-facing terminology from the Terminology table above — only the plain-language equivalents shown here.

## QR Scan Decision Flow

1. **Scan**: scanner device/account scans a participant's QR (encodes/resolves to `application_id` only — no personal data embedded in the code itself). The device already knows its assigned `session_id`/`room_id` from `scanner_assignments`.
2. **Request**: client calls a `'use server'` action wrapping a single transactional RPC — `scan_attempt_transactional(application_id, session_id, scanner_user_id, device_identifier)`.
3. **Server-side, one transaction**:
   - Verify `scanner_user_id` is authorized for this `session_id`/`room_id` via `scanner_assignments` (app-layer check before entering the RPC, backed by RLS as defense-in-depth).
   - Verify the `application_id` exists and is `status = 'accepted'` → else `'invalid_qr'`.
   - **Lock a single fixed row representing the session** (`select capacity from sessions where id = session_id for update`) before counting — this serializes concurrent scans for the same session, so the second transaction's count reflects the first transaction's just-committed insert. **Note this is a stricter pattern than existing prior art**: the closest precedent, `override_allocation_assignment_transactional` (`20260723130000_override_capacity_check_in_transaction.sql`), does a capacity count-then-write inside one function transaction but uses **no explicit `for update` row lock** — it relies solely on default `read committed` isolation. This new RPC introduces an explicit row lock deliberately, since QR check-in concurrency (many devices scanning in real time at a live event) is a materially higher-contention scenario than admin overrides, and the correctness bar here is "never physically overshoot capacity," not just "usually correct."
   - Run `resolveAdmissionDecision`.
   - On an admitting outcome: insert `attendance_records` + `scan_attempts` (with `resulting_attendance_id` set), commit.
   - On a non-admitting outcome: insert `scan_attempts` only (recording the attempt), commit.
4. **Response**: server returns the result code plus the display-safe participant summary (below) — never a raw `applications`/`application_answers` row.
5. **Operator confirmation**: an admitting result (`admitted`/`flexible_admitted`) is a *proposal* shown to the operator, not an automatic write — see below.

### Operator Confirmation Requirement

The scan alone does not create `attendance_records` for admitting outcomes. The server RPC above already performs the insert transactionally (this is intentional: the transactional capacity check must happen atomically with the insert, or two concurrent "proposals" for the last seat could both display as available). To preserve the "operator must actively confirm" requirement without reopening the race condition, the flow is split as:

- **Step A (pre-check, no write)**: a read-only preview call runs `resolveAdmissionDecision` against current counts (no lock, no insert) and returns the proposed outcome + participant summary. This is what the operator sees on screen after the raw scan.
- **Step B (confirm, transactional write)**: only after the operator taps "Confirm Entry" does the client call the real `scan_attempt_transactional` RPC (step 3 above), which re-resolves the decision *atomically* at that moment — the pre-check was only a preview and can be stale by the time of confirmation (e.g. the seat filled in between, or release timing crossed). The operator sees the RPC's actual result, which may differ from the preview in a genuine race (e.g. preview said `flexible_admitted`, confirm returns `full`).

**Divergence must be surfaced distinctly, not silently substituted.** If the confirm-time result differs from the previewed result, the UI must show this as its own explicit state (e.g. "This seat was taken while confirming — result changed to Full") rather than simply repainting the screen with a different color as if it were an ordinary first-try outcome. The operator confirmed a specific proposal; if the system produced a different outcome, that must read as "your confirmation could not be honored as previewed," not as an unremarkable status update. If more than a short, fixed staleness window (e.g. 10 seconds) elapses between preview and the operator's tap, the client should silently re-run the preview before submitting the confirm, so genuinely stale screens are refreshed automatically rather than surfaced as a false divergence.

This gives explicit operator confirmation while keeping the actual capacity-safe decision atomic and authoritative at write time.

### Scan Results (color coding)

| Result | Color | Creates attendance? |
|---|---|---|
| `admitted` | Green | Yes (`entry_type='priority'`) |
| `flexible_admitted` | Blue | Yes (`entry_type='flexible'`) |
| `priority_hold` | Orange | No — operator offers wait / alternative / supervisor request |
| `full` | Red | No |
| `restricted_denied` | Red | No, unless a supervisor override (`entry_type='override'`) |
| `duplicate` | Gray | No — original `admitted_at` shown |
| `timeslot_conflict` | Yellow (warning) | No — requires correction/transfer/override |
| `invalid_qr` | Red | No |

### Participant Summary Shown to the Operator (allow-list, not a blocklist)

Allowed: full name, participant photo (only if a pre-approved public display photo exists — never sourced from any sensitive table), country/delegation, recommended-session status (yes/no, no score), current scan result, conflicting session name only (no further detail) if a `timeslot_conflict` applies.

Never included: anything from `application_travel_info`, `application_health_info`, `application_answers where is_sensitive`, phone number. Enforced by (a) a dedicated retrieval function/view that selects only the allowed columns — never `select *` from `applications` on this path — and (b) RLS denying `scanner_device` any access to the sensitive tables outright, as defense-in-depth.

## `program_attendance_manager` — New Administrative Capabilities

All via new server actions gated by the existing `requireProgramAttendanceStaffCaller()` (no change to that helper's role check — these are new actions, not new roles allowed into it):

- View expected demand per session (`allocation_assignments` count vs. `priority_seats`/`capacity`).
- View live confirmed check-in counts and remaining capacity per session.
- Force-open/close flexible entry (`sessions.flexible_entry_manual_override`).
- Apply/remove late-entry cutoff (`sessions.late_entry_cutoff_minutes`).
- Identify overcrowded sessions (high admitted/capacity ratio, or an open `priority_pool_exceeded`/`capacity_bottleneck` issue).
- View suggested alternative sessions/rooms (same `getAlternativesForTimeslot`, manager-facing view).
- **Override admission** (`admitOverride`): bypasses `restricted_denied`/`full`/the late-entry cutoff; requires a mandatory written reason; writes `attendance_records` with `entry_type='override'` and a full `audit_logs` entry.
- **Correct attendance** (`correctAttendance`): sets `status='corrected'` on the existing row — never deletes it. Writes a full `audit_logs` entry (actor, reason, old/new values), same as `admitOverride`.
- **Transfer attendance** (`transferAttendance`): one transaction — old row → `status='transferred_out'`; new row inserted with `entry_type='override'` and `superseded_attendance_id` pointing back to the old row. Writes a full `audit_logs` entry, same as `admitOverride`.
- Monitor all scanner devices/operators (`scanner_assignments`, `scan_attempts` across every session — unlike a `scanner_device` account, which only sees its own assigned sessions).
- View attendance by session, room, timeslot, participant, and track (aggregate queries joining `attendance_records` with `sessions`/`applications`).

`scanner_device` has no path — RLS or server-side — to any of the above; it is confirmed by dedicated tests (below).

## `scanner_device` — Access Boundary

**Allowed:** read `sessions`/`rooms` (only the fields needed to display current session/room name, via a dedicated narrow view — never the full row), execute the scan-preview and `scan_attempt_transactional` RPCs (only for sessions/rooms present in its own `scanner_assignments`), read its own `attendance_records`/`scan_attempts` history (own sessions only).

**Denied (RLS + server guard, matching every other role's established double-gate pattern):** `application_travel_info`, `application_health_info`, `application_answers where is_sensitive`, participant-account management, email sending, allocation/schedule-publication management, staff/role management, system settings, and any cross-session/cross-room attendance report.

## Permission Matrix Summary

| Table / action | super_admin | program_attendance_manager | scanner_device | participants_communications_manager |
|---|---|---|---|---|
| `sessions`, `rooms`, agenda tables | full | full | read, own scope only | none |
| `allocation_*` | full | full | none | none |
| `schedule_publication*` | full | full | none | read-only |
| `attendance_records` write | full | correct/transfer/override only | insert via RPC, own scope only | none |
| `attendance_records` read | full | full | own scope only | none |
| `scan_attempts` | full | full | own scope: insert + read | none |
| `scanner_assignments` | full | full (assign devices) | read own row only | none |
| `application_travel_info` / `application_health_info` | full | none | none | none |
| Participant account management | no | no | no | full |
| Staff/role management | full | no | no | no |

## Implementation Phases

1. **Schema + RLS** — all migrations listed below (Migration Plan), plus regenerated `database.ts`. No server actions or UI yet. Verified by direct SQL/RPC calls only.
2. **Admission-policy resolution + scan RPC + tests** — `resolveAdmissionDecision` as a pure function with full unit coverage, `scan_attempt_transactional` RPC, `requireProgramAttendanceStaffCaller`/new `requireScannerDeviceCaller` server-action guards, and the full live-test suite (Testing Plan below) passing against the real database, including the concurrency scenarios. No UI yet — this phase is complete when the backend contract is proven correct and safe under real concurrent load.
3. **Manager admin UI** — `program_attendance_manager`-facing pages: demand/capacity dashboards, flexible-entry open/close controls, override/correct/transfer actions, scanner-device monitoring. Built against the already-proven Phase 2 backend.
4. **Participant dashboard updates** — schedule page changes (Participant Experience & Dashboard section above): admission-policy labels, alternatives list, actual-attendance display, removal of the Mandatory/Elective badge.
5. **Scanner PWA** — the actual operator-facing scan/preview/confirm UI, plus its offline-queueing design (explicitly a separate follow-up spec per Non-Goals) built once phases 1–3 are stable in production.

Each phase should be reviewable and independently mergeable — phase 2 in particular should not begin until phase 1's schema is confirmed migrated and phase 2 should not be considered done until its own live-test suite is green, matching this codebase's established phase-by-phase review discipline.

## Migration Plan (additive only)

1. `add_admission_policy_and_priority_fields.sql` — new `sessions` columns.
2. `add_scanner_device_role.sql` — isolated enum-value migration (existing convention).
3. `create_attendance_records_table.sql` — table + unique partial index.
4. `create_scan_attempts_table.sql` — audit table.
5. `create_scanner_assignments_table.sql` — device/account scope table.
6. `attendance_rls_policies.sql` — RLS for the three new tables.
7. `scan_attempt_transactional_function.sql` — the core RPC (row-lock + resolve + insert).
8. `admission_management_functions.sql` — override/correct/transfer RPCs.
9. `add_priority_pool_exceeded_issue_type.sql` — ordinary check-constraint update (not an enum, no isolation needed).

`sessions.is_mandatory` is explicitly **not** touched in this migration set (see Non-Goals).

## Testing Plan

**Pure-function unit tests** (`resolveAdmissionDecision`): every branch in the decision table — recommended/not-recommended × each `admission_policy` value × before/after release timing × at/under/over capacity × duplicate × timeslot conflict × before/after late-entry cutoff × override-caller bypassing the cutoff.

**Live integration tests** (mirroring this codebase's established live-test pattern against the real Supabase project):
- Recommended participant → green admission.
- Non-recommended participant, `open`/`cross_cutting` session → immediate blue admission.
- `priority_then_open` before release time → non-recommended participant gets `priority_hold`.
- `priority_then_open` after release time → non-recommended participant gets flexible admission if capacity allows.
- `restricted` session, non-authorized participant → red denial; `program_attendance_manager` override succeeds and is fully audited.
- `plenary` session → direct admission, no priority gating.
- Session at hard `capacity` → any further attempt is `full`, including for a recommended participant.
- Unused priority seats auto-release at the configured time and become available to flexible entry.
- Duplicate scan for an already-admitted participant/session → gray, original `admitted_at` shown, no new row.
- **Real concurrency**: two simultaneous scans (`Promise.all`) for the session's last seat → exactly one succeeds, the other gets `full`.
- **Real concurrency**: the same participant scanned by two devices at the same instant for the same session → exactly one `attendance_records` row (unique index holds even under a transaction race).
- Timeslot conflict: participant admitted to session A, then scanned for session B in the same slot group → yellow warning, no silent admission.
- Approved transfer: `transferAttendance` correctly supersedes the old row and creates a valid new one.
- `scanner_device` restricted to its assigned rooms/sessions — an out-of-scope scan attempt is rejected at both the RLS layer and the server-action layer.
- `scanner_device` cannot reach any manager-only action, full report, or sensitive table — verified by direct negative-path calls.
- Post-allocation validation: a run producing more recommendations than `priority_seats` for a session produces a `priority_pool_exceeded` issue row.
- The published participant schedule remains descriptive-only — no code path allows a participant to write to their own schedule (unchanged from current behavior, re-verified under the new terminology).
- Reporting: a query distinguishing "recommended session actually attended" vs. "attended a different (flexible) session" returns correct counts from `attendance_records` joined with `allocation_assignments`.
- Late-entry cutoff: a normal scan attempt after `late_entry_cutoff_minutes` has elapsed is blocked regardless of `admission_policy`; the same scan via `admitOverride` succeeds and is fully audited.
- Full audit trail: every scan attempt (admitted, rejected, held, duplicate, conflict alike) produces exactly one `scan_attempts` row, and every `admitOverride`/`correctAttendance`/`transferAttendance` call produces exactly one corresponding `audit_logs` row — verified directly by counting rows after a mixed sequence of successful and failed attempts plus at least one of each admin action.

## Risks and Operational Edge Cases

- **Clock skew / release-timing ambiguity**: `priority_release_at` vs. `priority_release_minutes_before` — if both are set, `priority_release_at` wins (explicit beats relative); if neither is set, priority seats never auto-release and require a manual manager action, which must be clearly surfaced in the admin UI so a session doesn't accidentally stay priority-locked all day.
- **Late-entry cutoff interacting with overrides**: a supervisor override must still be able to admit after cutoff (the cutoff blocks *normal* entry, not authorized exceptions) — implemented as an explicit step in `resolveAdmissionDecision` (step 4) that is skipped entirely when the caller is performing an `admitOverride`.
- **QR photo/display data governance**: the "pre-approved public display photo" concept assumes a photo-approval mechanism exists or will be added; if no such mechanism exists yet, the scanner UI must omit photos entirely for the first version rather than pulling an unapproved image from another source.
- **Device offline behavior**: this spec defines the server contract only; a real venue will have intermittent connectivity, and the PWA's offline-queue/sync design (a separate follow-up spec) must preserve the same atomicity guarantees (no local "optimistic" admission that could double-book on reconnect) — flagged here as a known gap the next spec must close before real deployment.
- **`is_mandatory` transition period**: until it's dropped in a later migration, ensure no *new* code reads it (only historical/legacy display, if any, should reference it) to avoid two competing "is this required" signals coexisting.
