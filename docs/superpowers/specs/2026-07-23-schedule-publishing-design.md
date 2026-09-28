# Phase 5: Assignment Confirmation & Participant Schedule Publishing — Design Spec

**Phase:** 5 (RCOY MENA 2026 conference platform)
**Status:** Approved by user section-by-section, pending spec review

## Goal

Give `agenda_allocation_manager`/`super_admin` staff a way to publish a confirmed Phase 4 allocation run as immutable per-participant schedule snapshots, which participants view read-only at `/[locale]/schedule`. Nothing reaches a participant's visible schedule without an explicit, reviewed, admin-confirmed publish action — including changes to already-published sessions (time/room/speaker edits, cancellations) made after publication.

## Non-negotiable rules (verbatim from requirements, binding across this whole design)

1. Never publish participant schedules automatically.
2. Only a confirmed allocation run may be published.
3. Publishing requires an explicit `super_admin` or `agenda_allocation_manager` action.
4. Participants may only view their own published schedule.
5. Participants may not select, remove, swap, or modify sessions.
6. A participant missing a mandatory session must block publication unless an authorized admin resolves or explicitly overrides the issue with a documented reason.
7. Low-confidence elective assignments may be published only after admin review.
8. Publication must be atomic: either all affected participant schedules are created successfully or nothing is published.
9. Published schedules must be immutable snapshots.
10. Later changes must create a new revision rather than overwrite historical schedules.
11. Every publication, revision, override, and rollback must be recorded in `audit_logs`.

**Out of scope for this phase**: QR/scanner/attendance, email delivery.

## Architecture

Three layers on top of Phase 4's `allocation_runs`/`allocation_assignments`, following the identical service-role-write / RLS-defense-in-depth / staff-gated-server-action pattern established in Phases 3–4.

### 1. Change detection — event-only triggers

A trigger on `sessions` (fires on `start_time`/`end_time`/`room_id`/`status` change) and a trigger on `session_people` (fires on any row change) each do exactly one thing: insert a deduplicated row into `schedule_change_events`. **No participant fan-out and no revision creation happen inside these triggers** — this is the only thing that runs inside the write transaction that touched `sessions`/`session_people`, so it can never leave a participant-facing table in an inconsistent state and never generates a revision from an incomplete intermediate state (e.g. mid `session_people` delete-and-reinsert).

### 2. Staleness marking — orchestrator, not trigger

A server-side orchestrator (invoked by an admin visiting the "changed schedules" queue, or by a scheduled job — this phase implements the manually-triggered path only) reads unprocessed `schedule_change_events`, joins to `schedule_publication_items` to find affected participants' `active` items, and marks those items `stale` (session/room/speaker change) or `pending_review` (cancellation). This never changes what a participant currently sees — a `stale` item still renders its last-published content until a new revision is published.

### 3. Draft revision build + admin review

The admin "changed schedules" queue and the run-publish flow both funnel into the same staging mechanism: an orchestrator function reads the current committed source state (confirmed run, or the specific sessions/session_people referenced by unprocessed change events) and produces a **draft** — not yet visible to any participant. The admin reviews the draft's diff and blockers, resolves anything blocking, and explicitly confirms.

### 4. Publication engine

Both an initial run-publish and a change-propagation revision batch go through the same two-RPC engine:

- **Stage** (`stage_publication_transactional`): reads `allocation_assignments`/`allocation_issues`/`sessions`/`session_people` (never writes to any of them, nor to `schedule_publications`/`schedule_publication_items`). Computes the candidate publication set, blockers, diffs, and a **source fingerprint** (hash of the canonical data the staged output was computed from — see exact definition below). Writes only to `schedule_publication_drafts`/`schedule_publication_draft_items`.
- **Admin confirms explicitly** — a real, separate user action (batch low-confidence acknowledgment checkbox, per-participant blocker resolution) via ordinary staff-gated server actions, not implicit in staging.
- **Confirm** (`confirm_publication_transactional`): re-validates the fingerprint against current committed source state (rejects with `expired` status if source data moved since staging); acquires a transaction-scoped advisory lock keyed on the run/change-event-batch identity (prevents concurrent publish interleaving); writes new `schedule_publications`/`schedule_publication_items` rows only for participants whose computed content actually differs from their current active revision (idempotent — an unchanged fingerprint produces no new row); all in one short atomic transaction.

**Atomicity scope (rule 8) applies to Confirm's writes, not the whole stage → resolve blockers → confirm human workflow.** Staging is deliberately a separate, earlier, read-only step — nothing is published by staging alone, so rule 8 ("either all affected participant schedules are created successfully or nothing is published") is scoped to what Confirm actually writes in its one transaction. Resolving a `blocked_mandatory` item via the `reassigned` path (below) is itself a separate small transaction against the still-`staged` draft, before Confirm ever runs — this does not weaken rule 8, since nothing becomes visible to any participant until Confirm's single transaction commits; a reassignment that fails or is abandoned mid-review simply leaves the draft in `staged` with an unresolved item, never partially published.

Access control, RLS shape, and server-action conventions are inherited unchanged from Phase 3/4 (`agenda_allocation_manager`/`super_admin`, `requireAgendaStaffCaller`, service-role-client writes for staff paths, RLS-scoped client for the participant's own-data read, RLS as defense-in-depth).

## Data Model

### `schedule_publications` — one row per participant per revision

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| application_id | uuid | not null, references applications(id) |
| allocation_run_id | uuid | not null, references allocation_runs(id) — the run this revision was derived from |
| revision_number | int | not null — per-participant counter, starts at 1 |
| status | text | not null — `'active'` \| `'superseded'` |
| source_fingerprint | text | not null — hash this revision's content was computed from |
| published_at | timestamptz | not null default now() |
| published_by | uuid | not null, references profiles(id) |

Constraints: `unique(application_id, revision_number)`. Partial unique index `on schedule_publications (application_id) where status = 'active'` — exactly one active revision per participant.

### `schedule_publication_items` — one row per session in a revision

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| schedule_publication_id | uuid | not null, references schedule_publications(id) on delete cascade |
| session_id | uuid | nullable, references sessions(id) on delete set null — nullable so history survives a later session deletion; also null for a `publish_with_gap` override item |
| session_title_ar / session_title_en | text | frozen at publish time |
| room_name_ar / room_name_en | text | frozen; nullable for a gap item |
| start_time / end_time | timestamptz | frozen; nullable for a gap item |
| is_mandatory | boolean | not null |
| speakers | jsonb | frozen array of `{full_name_ar, full_name_en, role}` (field names match `people.full_name_ar`/`full_name_en` via `session_people.person_id`), default `[]` |
| suitability_score | numeric | nullable, `check (suitability_score is null or (suitability_score >= 0 and suitability_score <= 1))` |
| explanation_summary | text | nullable |
| item_status | text | not null default `'active'` — `check (item_status in ('active','stale','changed','cancelled','pending_review'))` |
| gap_reason | text | nullable — set only for a `publish_with_gap` override item (see Issue/Blocker Policy) |

Index on `(schedule_publication_id)`, `(session_id)`.

### `schedule_change_events` — trigger-only event log

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| session_id | uuid | not null, references sessions(id) — no `on delete` clause specified (defaults to `restrict`): deliberately blocks a hard session delete while an unprocessed change event still references it, forcing that event to be processed (or the session's cascade path reconsidered) first rather than silently losing the event |
| change_type | text | not null — `check (change_type in ('time_or_room','speakers','cancelled'))` |
| detected_at | timestamptz | not null default now() |
| processed_at | timestamptz | nullable — set once the orchestrator has run staleness-marking for this event |

Unique partial index `on schedule_change_events (session_id, change_type) where processed_at is null` — the dedup mechanism. Trigger inserts use `on conflict (session_id, change_type) where processed_at is null do nothing`, so a `session_people` delete-and-reinsert (two row changes) collapses to one unprocessed `speakers` event.

### `schedule_publication_drafts` — staged, unconfirmed publication engine output

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| allocation_run_id | uuid | nullable, references allocation_runs(id) — set for a run-publish |
| triggered_by_change_event_ids | uuid[] | nullable — set for a change-propagation batch; mutually exclusive with `allocation_run_id` being null (exactly one of the two set) |
| staged_at | timestamptz | not null default now() |
| staged_by | uuid | not null, references profiles(id) |
| source_fingerprint | text | not null |
| status | text | not null default `'staged'` — `check (status in ('staged','confirmed','expired','discarded'))` |

Constraint: `check ((allocation_run_id is not null) <> (triggered_by_change_event_ids is not null))` — exactly one source per draft.

### `schedule_publication_draft_items` — per-participant staged verdict

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| schedule_publication_draft_id | uuid | not null, references schedule_publication_drafts(id) on delete cascade |
| application_id | uuid | not null, references applications(id) |
| verdict | text | not null — `check (verdict in ('publishable','blocked_mandatory','no_change'))` |
| blocker_details | jsonb | nullable |
| resolution | text | nullable — `check (resolution is null or resolution in ('reassigned','override_publish_with_gap'))` |
| override_reason | text | nullable — required (enforced at the application layer, not a DB check, since it depends on `resolution`) when `resolution = 'override_publish_with_gap'` |

Index on `(schedule_publication_draft_id)`.

### Audit

Reuses Phase 3/4's existing `audit_logs` table — no new table. New `entity_type` values: `'schedule_publication_draft'`, `'schedule_publication'`, `'schedule_change_event'`. `action` values: `'stage'`, `'confirm'`, `'discard'`, `'override'`, `'process_change_event'`.

## Publication Transaction Design

### `stage_publication_transactional(p_allocation_run_id uuid, p_change_event_ids uuid[], p_staged_by uuid)`

Exactly one of `p_allocation_run_id` / `p_change_event_ids` is non-null per call (mirrors the draft table's own constraint). Read-only against `schedule_publications`/`schedule_publication_items`:

1. Compute source fingerprint (hash of the confirmed run's assignment set, or of the affected sessions'/session_people's current committed rows).
2. Insert one `schedule_publication_drafts` row (`status = 'staged'`).
3. For every candidate `application_id`, diff proposed items against the current `active` `schedule_publications` row (if any); classify `verdict` per the Issue/Blocker Policy below; insert one `schedule_publication_draft_items` row.
4. Return the draft row.

`language plpgsql set search_path = public, pg_temp`, matching the established Phase 4 RPC hardening convention.

### `confirm_publication_transactional(p_draft_id uuid, p_confirmed_by uuid)`

```sql
create function confirm_publication_transactional(
  p_draft_id uuid,
  p_confirmed_by uuid
) returns schedule_publication_drafts as $$
declare
  v_draft schedule_publication_drafts;
  v_current_fingerprint text;
  v_lock_key bigint;
begin
  select * into v_draft from schedule_publication_drafts where id = p_draft_id and status = 'staged';
  if v_draft.id is null then
    raise exception 'Draft % is not in staged status (already confirmed, expired, discarded, or does not exist)', p_draft_id;
  end if;

  -- Advisory lock scoped to this draft's source, transaction-scoped (auto
  -- releases at commit/rollback, no separate unlock call needed). Prevents
  -- two concurrent confirms against the same run/change-event-batch from
  -- interleaving.
  v_lock_key := hashtext(coalesce(v_draft.allocation_run_id::text, array_to_string(v_draft.triggered_by_change_event_ids, ',')));
  if not pg_try_advisory_xact_lock(v_lock_key) then
    raise exception 'Another publication for this source is already in progress';
  end if;

  -- Revalidate: recompute the fingerprint from current committed source
  -- state. If it differs from what was staged, the underlying data moved
  -- since staging — reject rather than publish against a stale diff.
  v_current_fingerprint := compute_publication_fingerprint(v_draft.allocation_run_id, v_draft.triggered_by_change_event_ids);
  if v_current_fingerprint <> v_draft.source_fingerprint then
    update schedule_publication_drafts set status = 'expired' where id = p_draft_id;
    raise exception 'Source data changed since this draft was staged — re-stage before publishing';
  end if;

  -- For every schedule_publication_draft_items row with verdict IN
  -- ('publishable') — i.e. excluding 'blocked_mandatory' rows that were
  -- never resolved, and excluding 'no_change' rows (idempotency: nothing
  -- to write for a participant whose content is unchanged) — supersede the
  -- current active schedule_publications row (if any) and insert the new
  -- one + its items, sourced from the draft item's computed content
  -- (or the gap-item shape when resolution = 'override_publish_with_gap').
  -- A 'blocked_mandatory' row with no resolution set is skipped entirely
  -- (excluded from this publish batch, per-participant blocking).

  update schedule_publication_drafts set status = 'confirmed' where id = p_draft_id;
  select * into v_draft from schedule_publication_drafts where id = p_draft_id;
  return v_draft;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

`compute_publication_fingerprint(allocation_run_id, change_event_ids)` is a shared helper function (used by both `stage_publication_transactional` and the revalidation step above) so the two fingerprint computations can never drift apart. Its exact definition, per source:

- **Run-publish path** (`allocation_run_id` set): hash of every `allocation_assignments` row for that run — `(application_id, session_id, suitability_score, status, is_manual_override)` — ordered by `application_id, session_id` for stability, concatenated with every `allocation_issues` row for that run (`issue_type, application_id, session_id`), also ordered. Two runs with identical assignments but different issue sets must not collide.
- **Change-propagation path** (`change_event_ids` set): hash of, for every distinct `session_id` referenced by those change events: the session's `(start_time, end_time, room_id, status)` **and** every `session_people` row for that session (`person_id, role, display_order`, ordered), regardless of which specific `change_type` triggered the event — so a `speakers`-only event's fingerprint still reflects the session's current time/room too, and vice versa. This closes the gap where a `session_people` change without an accompanying `sessions` change would otherwise not perturb a fingerprint that only covered `sessions` columns.

Both use a stable, order-independent-input-but-order-explicit-serialization scheme (sort keys as stated above, then hash the concatenated, delimited string) — the same determinism requirement Phase 4's `time_slot_group_key` hashing already established (`src/lib/allocation/time-slot-grouping.ts`), reused here rather than reinvented.

## Issue/Blocker Policy

Computed per participant during staging, against the candidate `application_id`:

| Condition | Verdict | Publish behavior |
|---|---|---|
| An `allocation_issues` row of type `unassigned` leaves a **mandatory** slot empty | `blocked_mandatory` | Excluded from this batch until admin sets `resolution`: `reassigned` (see below — a new Phase-5-owned reassignment, not Phase 4's `overrideAssignment`) or `override_publish_with_gap` (requires non-empty `override_reason`; publishes with a `schedule_publication_items` row for that slot with `session_id = null`, `item_status = 'active'`, `gap_reason` set — the participant's timeline shows an explicit "no mandatory session assigned" notice, never a silent hole) |
| `capacity_bottleneck` / `schedule_conflict` / `no_eligible_sessions` for this participant, affecting a **mandatory** session | `blocked_mandatory` | Same as above — anything leaving a mandatory slot empty blocks |
| Same issue types, affecting only an **elective** session | `publishable` | Never blocks; surfaced only informationally |
| `is_low_confidence = true` on any included assignment, no mandatory blocker | `publishable` | Included, but every such item across the whole draft is listed together, gated behind the single "I have reviewed the low-confidence assignments above" checkbox before Confirm is enabled |
| No issues; computed content identical to current active revision | `no_change` | No new row written — this is the idempotency mechanism, not a special case |
| No issues; computed content differs from current active revision (or no active revision exists yet) | `publishable` | Standard new/first revision |

### The `reassigned` resolution mechanism

Phase 4's `override_allocation_assignment_transactional` cannot be reused here: it hard-rejects unless the target `allocation_runs.status = 'draft'` (`20260723130000_override_capacity_check_in_transaction.sql`), and per rule 2 only a `confirmed` run ever reaches Phase 5's staging step — so calling it here would always throw. Phase 5 instead adds its own **`reassign_blocked_participant_transactional(p_draft_item_id uuid, p_new_session_id uuid, p_reassigned_by uuid)`** RPC:

1. Loads the `schedule_publication_draft_items` row (must have `verdict = 'blocked_mandatory'` and belong to a still-`staged` draft — re-raises if not).
2. Re-validates the new session against the same hard constraints Phase 4 already codifies (`checkStaticHardConstraints` — status/inclusion/language/difficulty). Capacity re-count: `select count(*) from schedule_publication_draft_items where schedule_publication_draft_id = <this draft> and verdict = 'publishable' and <computed session for that item> = p_new_session_id`, compared against `sessions.capacity` for `p_new_session_id` — i.e. only `publishable` items already pointed at the target session within this same draft count against its limit, mirroring `override_allocation_assignment_transactional`'s own this-run-only capacity scoping but reimplemented against draft items rather than `allocation_assignments`.
3. Updates the draft item's computed content in place (new session's frozen fields), sets `resolution = 'reassigned'`, flips `verdict` to `publishable`.

This is a within-draft correction, entirely separate from and never mutating Phase 4's `allocation_assignments`/`allocation_runs` — the confirmed run stays untouched; only this draft's proposed publication content changes. No "re-stage" round-trip is needed (removing the earlier "then re-stage" note, which was inaccurate: re-staging would recompute from `allocation_assignments` and discard the reassignment). Search-path-hardened, same conventions as every other RPC in this spec.

## Change Propagation Policy

| Trigger event | `schedule_change_events.change_type` | Orchestrator effect | Admin path |
|---|---|---|---|
| `sessions.start_time`/`end_time`/`room_id` changes | `time_or_room` | Marks affected `active` items `stale` | Changed-schedules queue → stage a draft that refreshes only the frozen time/room fields, same session assignment; review + confirm |
| `session_people` insert/update/delete on a session with active published items | `speakers` | Marks affected `active` items `stale` | Same queue → draft refreshes only the frozen `speakers` jsonb |
| `sessions.status` → `'cancelled'` | `cancelled` | Marks affected `active` items `pending_review` (not `stale`) | Changed-schedules queue's dedicated cancellation view → admin must pick reassignment or explicit "confirm cancelled" resolution (mirrors the mandatory-blocker resolution UI) before any draft including this participant can be confirmed |
| A newer `allocation_runs` (status `confirmed`) is staged for publish while an older run's revisions are still active | — (no event row; this is a normal `stage_publication_transactional(new_run_id)` call) | Diff-based: only participants whose new-run content differs from current active get a `publishable` draft item; identical ones are `no_change` | Normal run-publish flow (§ Publication Transaction Design) |
| `allocation_runs.status` → `'discarded'` | — | No effect | A discarded run was never published from; nothing references it |

**Explicitly out of scope for change detection**: a change to `sessions.is_mandatory` on an already-published session is not one of the three `change_type`s the trigger watches for, so it does not go `stale` and does not re-trigger blocker evaluation. A mandatory→elective (or reverse) flip after publication is a rare edit that would need its own admin-driven re-stage of the affected participants if it ever happens; not automated in this phase.

## RLS and Authorization Model

All 5 new tables have RLS enabled.

**Staff-only** (`schedule_change_events`, `schedule_publication_drafts`, `schedule_publication_draft_items`):
```sql
create policy X_staff_all on X
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
```

**Self-scoped + staff** (`schedule_publications`, `schedule_publication_items`):
```sql
create policy schedule_publications_select_own on schedule_publications
  for select using (application_id in (select id from applications where applicant_id = auth.uid()));
create policy schedule_publications_staff_all on schedule_publications
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy schedule_publication_items_select_own on schedule_publication_items
  for select using (
    schedule_publication_id in (
      select id from schedule_publications
      where application_id in (select id from applications where applicant_id = auth.uid())
    )
  );
create policy schedule_publication_items_staff_all on schedule_publication_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
```

No `insert`/`update`/`delete` policy grants a participant write access to any schedule table — the `_select_own` policies are `select`-only; combined with default-deny for unlisted operations, a participant cannot select, remove, swap, or modify anything (rule 5).

**Server-side conventions** (unchanged from Phase 3/4):
- Every admin server action calls `requireAgendaStaffCaller()` first, no exceptions.
- All admin writes go through the service-role client; RLS above is defense-in-depth only.
- The participant `/schedule` page uses the regular RLS-scoped client (matching `my-application/page.tsx`), so `applicant_id = auth.uid()` is enforced by Postgres, not just app logic.
- Every server action validates IDs with `idSchema` (`z.string().guid()`); new Phase-5-specific schemas live in `src/lib/validation/schedule.ts`.
- `writeAuditLog()`'s `actorId` is always the authenticated `userId` from `requireAgendaStaffCaller()`, never client-submitted input.
- The `sessions`/`session_people` triggers only ever write to `schedule_change_events` — they never touch participant-facing tables, so they carry no participant-authorization surface.

## Admin and Participant Page Structure

**Participant-facing:**
```
src/app/[locale]/(participant)/schedule/
  page.tsx                          -- server component; RLS-scoped client; own active schedule_publications + items
src/components/ui/
  badge.tsx, card.tsx, empty-state.tsx, skeleton.tsx     -- generic primitives, seed of the future design system
src/components/schedule/
  day-timeline.tsx, session-card.tsx, time-marker.tsx, status-banner.tsx   -- schedule-specific composites
```
Tailwind-styled (not the codebase's prior bare-HTML convention — an intentional, approved exception since this is the first genuinely participant-facing, frequently-revisited page). Vertical day-timeline layout, mobile-responsive, full Arabic/English + RTL/LTR support (locale-driven `dir`, already handled globally in `layout.tsx`), accessible contrast and keyboard navigation on all interactive elements, loading/empty/error states as first-class UI states (not just happy-path). No business logic in these components — pure presentation over server-fetched data.

**Admin-facing**, under `src/app/[locale]/(admin)/allocation/schedules/`:
```
schedules/
  page.tsx, run-list.tsx                    -- publication overview: runs published, revision counts per run
  stage/[allocationRunId]/
    page.tsx, actions.ts                    -- stage a draft; preview publishable/blocked/no_change split;
                                                low-confidence batch acknowledgment; per-blocker resolution
                                                (reassign / override_publish_with_gap); confirm
  changed/
    page.tsx, actions.ts                    -- pending_review (cancellations) + stale-but-unstaged items queue;
                                                trigger staging for a change-event batch
  participants/[applicationId]/
    page.tsx                                -- one participant's full revision history (read-only)
```
Follows Phase 3/4's exact admin page convention: server-component auth gate (session client `auth.getUser()` → redirect if unauthenticated; service-role `profiles.role` lookup → `notFound()` if not staff), plain unstyled HTML (admin surfaces keep the existing bare convention — only the participant page gets the new styling investment), client components calling server actions directly + `router.refresh()`.

## Test Strategy

**Pure logic (no DB):**
1. Fingerprint computation is stable for identical input, changes when any frozen field changes.
2. Verdict classification: mandatory-unassigned → `blocked_mandatory`; elective-only issue → `publishable`; identical-to-active content → `no_change`.
3. Diff computation for a re-publish-from-newer-run correctly identifies only participants whose content actually changed.

**Live behavioral suite** (hosted Supabase, real throwaway users/data, mirroring Phase 3/4's pattern):
1. Cannot stage or confirm from a non-`confirmed` allocation run.
2. Mandatory-unassigned blocks that participant only; other participants in the same run publish successfully.
3. `override_publish_with_gap` with a documented reason produces a published item with `session_id = null` and `gap_reason` set; an empty/missing reason is rejected before confirm.
3a. `reassign_blocked_participant_transactional` on a `blocked_mandatory` draft item re-validates hard constraints and this-draft capacity before flipping `verdict` to `publishable`; a reassignment attempt that fails those checks is rejected and the item stays `blocked_mandatory`. Confirming afterward publishes the reassigned session for that participant, and Phase 4's own `allocation_assignments`/`allocation_runs` rows are unchanged throughout.
4. A forced mid-confirm failure (e.g. a constraint violation injected on one participant's item) rolls back the entire transaction — prior active revisions for every participant remain untouched.
5. A real signed-in participant session reading `/schedule` returns only their own `schedule_publications`/`schedule_publication_items` rows — zero rows for another participant's data.
6. No write path exists for a participant to mutate any schedule table — attempting an insert/update via the RLS-scoped client as a participant is rejected.
7. Re-confirming an already-`confirmed` draft, or staging+confirming again with an unchanged fingerprint, produces no new revision (`revision_number` unchanged, no duplicate row) — idempotency.
8. A second publish with real content differences creates `revision_number + 1`; the prior revision flips to `superseded`.
9. The `superseded` revision's `schedule_publication_items` rows are byte-identical after the new revision is created — immutability.
10. Cancelling a session with active published items produces exactly one unprocessed `schedule_change_events` row (`change_type = 'cancelled'`) and, after orchestration, marks affected items `pending_review` — never silently `cancelled` without admin resolution.
11. Two concurrent `confirm_publication_transactional` calls against drafts sharing the same source — exactly one succeeds; the other receives the advisory-lock rejection; no duplicate revisions result.
12. Rendering the schedule page's time display against a known UTC `start_time` produces the correct Asia/Muscat wall-clock string (reusing the existing `toLocaleString('en-US', { timeZone: 'Asia/Muscat' })` idiom already established in Phase 3/4).

## Out of Scope (confirmed non-goals, do not implement here)

- QR code generation/scanning, attendance tracking.
- Email delivery of published schedules.
- Automated/scheduled staleness-marking (this phase implements the manually-triggered orchestrator path only; a cron/scheduled job is a future enhancement).
- Any write path for a participant to influence their own schedule content.
