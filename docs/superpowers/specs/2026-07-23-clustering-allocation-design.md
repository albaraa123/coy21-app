# Accepted Participant Clustering & Automatic Session Allocation — Design Spec

**Phase:** 4 (RCOY MENA 2026 conference platform)
**Status:** Approved by user; spec review passed

## Goal

Give `agenda_allocation_manager`/`super_admin` staff a system that (a) clusters already-manually-accepted participants for analytical insight, and (b) computes a draft, explainable, reproducible session allocation for those participants — which staff must explicitly review and confirm before it becomes real. This phase never decides admission; it only operates on applications already at `status = 'accepted'`.

## Non-Goals (explicit, confirmed with user)

- Any form of automated applicant scoring, screening, admission recommendation, automatic acceptance/rejection/waitlisting. Admission remains entirely manual (Phase 2's existing workflow, untouched).
- QR code generation/scanning, attendance tracking, or participant-facing schedule publishing — a schedule is never automatically published; confirming an allocation run only makes assignments the *system's* source of truth, not something participants see (a future phase's job).
- Clusters directly driving allocation — clustering is a decoupled, admin-facing analytical layer only. Allocation runs independently off participant↔session suitability scores.
- LLM/NLP-based feature extraction — extraction is fully deterministic and rule-based, so runs are genuinely reproducible with no external-API non-determinism.
- Cross-run awareness — every clustering/allocation run is independent and self-contained (a fresh computation over a data snapshot), never building on or diffing against a prior run.
- Joint whole-schedule optimization — allocation is computed independently per time-slot group, not as one combined multi-slot optimization problem.

## Architecture

Two decoupled subsystems sharing one upstream feature-extraction step:

1. **Feature extraction** (shared foundation): deterministic, versioned, rule-based mapping from `applications` answers to weighted `tags` (reusing Phase 3's `tags`/`session_tags` vocabulary), producing an immutable snapshot per accepted applicant per extraction run.
2. **Clustering** (analytical/reporting only): groups accepted participants by tag-weight similarity via k-means, for admin insight (e.g. participant archetypes and their sizes). Does not feed allocation.
3. **Allocation** (the assignment engine): for each conference time-slot group independently, hard-filters eligible sessions per participant, scores by cosine similarity of tag-weight vectors, then runs deferred-acceptance stable matching to assign seats under capacity. Produces a draft run requiring explicit admin confirmation before assignments are final.

Access control, RLS shape, and server-action conventions are inherited unchanged from Phase 3 (`agenda_allocation_manager`/`super_admin`, `requireAgendaStaffCaller`, service-role-client writes, RLS as defense-in-depth).

## Data Model

### Feature Extraction

**`feature_extraction_rules`** — admin-configured, versioned mapping rules.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| version | int | not null |
| source_field | text | not null — e.g. `'interests'`, `'topics_to_learn'`, `'track_interests'` |
| match_type | text | not null — `'array_value'` or `'keyword_substring'` |
| match_value | text | not null — the array value or keyword to match |
| tag_id | uuid | not null, references tags(id) |
| weight | numeric | not null, `check (weight >= 0 and weight <= 1)` |
| is_active | bool | not null default true |
| created_at / updated_at / updated_by | | standard |

**`feature_extraction_runs`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| rules_version | int | not null — which version of `feature_extraction_rules` was active |
| application_count | int | not null — how many accepted applications were snapshotted |
| run_at | timestamptz | not null default now() |
| run_by | uuid | not null, references profiles(id) |

**`participant_feature_snapshots`** — the frozen, per-run tag-weight vector.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| feature_extraction_run_id | uuid | not null, references feature_extraction_runs(id) on delete cascade |
| application_id | uuid | not null, references applications(id) |
| tag_id | uuid | not null, references tags(id) |
| weight | numeric | not null, `check (weight >= 0 and weight <= 1)` |
| created_at | timestamptz | not null default now() |

Constraint: `unique(feature_extraction_run_id, application_id, tag_id)`.

### Clustering

**`clustering_runs`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| feature_extraction_run_id | uuid | not null, references feature_extraction_runs(id) |
| k | int | not null, `check (k > 0)` |
| random_seed | int | not null |
| status | text | not null — `'completed'` \| `'failed'` |
| run_at | timestamptz | not null default now() |
| run_by | uuid | not null, references profiles(id) |

**`clusters`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| clustering_run_id | uuid | not null, references clustering_runs(id) on delete cascade |
| label | text | nullable, admin-editable display name |
| centroid | jsonb | not null — `{tag_id: weight}` map |
| member_count | int | not null default 0 |

**`cluster_memberships`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| cluster_id | uuid | not null, references clusters(id) on delete cascade |
| application_id | uuid | not null, references applications(id) |
| distance_to_centroid | numeric | not null |

Constraint: `unique(cluster_id, application_id)`.

### Allocation

**`allocation_runs`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| feature_extraction_run_id | uuid | not null, references feature_extraction_runs(id) |
| status | text | not null default `'draft'` — `'draft'` \| `'confirmed'` \| `'discarded'` |
| run_at | timestamptz | not null default now() |
| run_by | uuid | not null, references profiles(id) |
| confirmed_at | timestamptz | nullable |
| confirmed_by | uuid | nullable, references profiles(id) |

**`allocation_assignments`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| allocation_run_id | uuid | not null, references allocation_runs(id) on delete cascade |
| application_id | uuid | not null, references applications(id) |
| session_id | uuid | not null, references sessions(id) |
| time_slot_group_key | text | not null — deterministic key identifying the connected-component slot group this assignment belongs to (see Allocation Algorithm) |
| suitability_score | numeric | not null |
| is_low_confidence | bool | not null default false |
| is_mandatory_assignment | bool | not null default false |
| is_manual_override | bool | not null default false |
| overridden_by | uuid | nullable, references profiles(id) |
| override_reason | text | nullable |
| status | text | not null default `'proposed'` — `'proposed'` \| `'confirmed'` |
| created_at / updated_at / updated_by | | standard |

Constraint: `unique(allocation_run_id, application_id, time_slot_group_key)` — one assignment per participant per slot-group per run.

**`allocation_alternatives`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| allocation_assignment_id | uuid | not null, references allocation_assignments(id) on delete cascade |
| session_id | uuid | not null, references sessions(id) |
| suitability_score | numeric | not null |
| rank | int | not null — 1 = best alternative |

**`allocation_issues`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| allocation_run_id | uuid | not null, references allocation_runs(id) on delete cascade |
| issue_type | text | not null — `'unassigned'` \| `'low_confidence'` \| `'capacity_bottleneck'` \| `'schedule_conflict'` \| `'no_eligible_sessions'` |
| application_id | uuid | nullable, references applications(id) — null for session-level issues |
| session_id | uuid | nullable, references sessions(id) — null for participant-level issues |
| details | jsonb | nullable — shape varies by `issue_type`, see below |
| created_at | timestamptz | not null default now() |

`details` shape per `issue_type`:

- `'unassigned'`: `{ "time_slot_group_key": "...", "eligible_session_ids": ["..."], "reason": "capacity_exhausted" }`
- `'low_confidence'`: `{ "allocation_assignment_id": "...", "suitability_score": 0.12, "threshold": 0.4 }`
- `'capacity_bottleneck'`: `{ "session_id": "...", "capacity": 30, "eligible_count": 47, "assigned_count": 30, "excluded_application_ids": ["..."] }`
- `'schedule_conflict'`: `{ "application_id": "...", "conflicting_assignment_ids": ["...", "..."], "conference_day_id": "..." }`
- `'no_eligible_sessions'`: `{ "time_slot_group_key": "...", "failed_constraints_summary": { "language": 3, "difficulty": 5, "capacity": 0 } }` — count of candidate sessions excluded per failing constraint, for admin diagnosis.

**`allocation_assignment_explanations`**

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| allocation_assignment_id | uuid | not null, references allocation_assignments(id) on delete cascade |
| constraint_type | text | not null — e.g. `'language_match'`, `'difficulty_match'`, `'capacity'`, `'confirmed_status'`, `'include_in_allocation'`, `'tag_similarity'` |
| passed | bool | not null |
| detail | text | not null — human-readable, e.g. "Session language 'ar' matches applicant preferred_language 'ar'" |

### Audit

Reuses Phase 3's `audit_logs` table — no new table. New `entity_type` values: `'feature_extraction_run'`, `'clustering_run'`, `'allocation_run'`, `'allocation_assignment'` (for manual overrides specifically). `action` values include `'run'`, `'confirm'`, `'discard'`, `'override'`.

## Feature Extraction Rules

- **Array fields** (`interests`, `track_interests`): each array element matched exactly against `match_value` where `match_type = 'array_value'`.
- **Free-text fields** (`topics_to_learn`, `participation_goals`, `past_initiatives`): case-insensitive substring/keyword match against `match_value` where `match_type = 'keyword_substring'`.
- **Excluded from extraction**: `special_needs` (accommodation data, never a matching signal — remains visible to admins in the UI, never scored). `experience_level` and `preferred_language` also produce no tags — they feed hard constraints 5 and 4 respectively, not the soft similarity score (see Hard Constraints). `age_group` and `climate_experience` are informational only in this phase: displayed to admins alongside an assignment, but consumed by no hard constraint, no scoring, and no extraction rule — there is no allocation logic that reads them. A future phase could add a constraint or scoring signal for them; Phase 4 does not.
- A `participant_feature_snapshots` row is only created for tags where the computed weight is > 0 (no zero-weight rows stored).
- Multiple rules matching the same participant+tag combination: for a given `(application_id, tag_id)` pair, sum the `weight` of every **distinct matching rule** (by `feature_extraction_rules.id`) that matched, then clamp to 1.0. A rule matches at most once per participant regardless of how many times its `match_value` occurs within a field (e.g. a keyword appearing twice in `topics_to_learn` still contributes that rule's weight once, not twice). Summing is per-tag, across all source fields and rules that produced that tag — not scoped to a single field.

## Hard Constraints (participant × session eligibility filter)

All must pass for a session to be included in a participant's eligible set for a given time-slot group:

1. `session.status = 'confirmed'`
2. `session.include_in_allocation = true`
3. Room/session capacity has a remaining seat at matching time (checked dynamically during deferred acceptance as seats fill within the run)
4. Language: `session.language = applicant.preferred_language` OR `session.language = 'bilingual'`. If `applicant.preferred_language` is `null` OR is not one of the recognized values (`'ar'`, `'en'`) — Phase 1's Zod layer is the only enforcement, so out-of-vocabulary values are possible — this constraint is treated as automatically satisfied (matches any language). Constraint 5 below defines the equivalent unrecognized-value fallback for `experience_level`, the only other participant field a hard constraint consumes.
5. Difficulty: exact-or-adjacent tier. Experience-to-difficulty tier mapping: `none/beginner → beginner`, `intermediate → intermediate`, `expert → advanced`. A participant is eligible for their mapped tier ±1 (e.g. `beginner` experience → eligible for `beginner` and `intermediate` sessions, not `advanced`). `all_levels` sessions are always eligible regardless of experience. If `applicant.experience_level` is `null` or not one of the recognized values (`none`, `beginner`, `intermediate`, `expert`), treat it as `beginner` for tier-mapping purposes (the most inclusive non-`all_levels` mapping, so an unrecognized value never silently excludes a participant from entry-level content).
6. No schedule overlap — structurally guaranteed by time-slot-group independence (a participant is matched at most once per slot-group), not a runtime check within a group.
7. `is_mandatory` sessions are excluded from this filter/matching pipeline entirely — handled by the separate Mandatory Pass (see Algorithm).

Constraint checks 1, 2, 4, 5 are static per participant-session pair within a run (computed once); check 3 is dynamic (evaluated as the deferred-acceptance process fills seats).

## Suitability Score

Cosine similarity between the participant's `participant_feature_snapshots` tag-weight vector and the session's `session_tags` weight vector, restricted to sessions that passed every hard constraint. Score range: 0–1. Sessions/participants with no tag overlap score 0 (not excluded by this alone — a 0-scoring session can still be a participant's only, least-bad eligible option, surfaced honestly as low-confidence rather than hidden).

**Zero-vector convention**: cosine similarity is mathematically undefined (0/0) when either vector has zero magnitude — i.e. a participant with no extracted tags at all (no `participant_feature_snapshots` rows for that run), or a session with no `session_tags` rows. By convention, this resolves to a suitability score of exactly `0`, identical in value to the "both vectors non-empty but no overlap" case, but distinguished internally so it can be surfaced with its own explanation detail (e.g. `"Participant has no extracted interest tags — similarity score is not meaningful"`) rather than the standard tag-overlap explanation.

## Allocation Algorithm (per run)

1. **Extraction**: build `participant_feature_snapshots` for every application with `status = 'accepted'` (a fresh `feature_extraction_runs` row, or reuse an existing one if the admin selects a prior extraction run rather than re-extracting — see Pages).
2. **Time-slot grouping**: compute connected components over `sessions` where `status = 'confirmed' and include_in_allocation = true`, per `conference_day_id`, linking any two sessions whose `tstzrange(start_time, end_time, '[)')` overlap (transitively). This includes `is_mandatory` sessions — they participate in grouping on the same basis as elective sessions, even though constraint 7 excludes them from the hard-filter/scoring pipeline; grouping only needs a session's day and time range, not its mandatory flag. Each component is a `time_slot_group_key`, computed as: take the component's session `id`s, sort them lexicographically as strings, join with `,`, then SHA-256 the resulting UTF-8 string and hex-encode the digest. This is pure and order-independent (same session-id set always produces the same key regardless of discovery order), which is what makes it safe as the unique-constraint key in `allocation_assignments` and reproducible byte-for-byte across runs and implementations. A session with no time-overlap partners forms a singleton component (its own one-session set), and the hash function works identically for a one-element set.
3. **Score precomputation**: before any assignment happens, compute the suitability score (per the Suitability Score section) for every `(participant, session)` pair that passes hard constraints 1, 2, 4, 5 — across *all* confirmed, `include_in_allocation = true` sessions, mandatory and elective alike. Steps 4 and 5 below both read from this precomputed set; neither step scores anything itself.
4. **Mandatory pass**: for every `is_mandatory = true` confirmed session, assign every hard-constraint-eligible (checks 1,2,4,5) accepted participant, using the scores from step 3. If the eligible participant count exceeds capacity, select by suitability score descending up to capacity; participants who don't fit are logged as a `capacity_bottleneck` issue (session-level) and become `unassigned` for that slot-group (participant-level `unassigned` issue), explicitly surfaced — never silently dropped.
5. **Elective pass**: for each remaining time-slot group, for each accepted participant not already filled in that group by the mandatory pass: take the hard-filtered eligible session set and scores from step 3, then run deferred acceptance (participants propose to highest-scored eligible session first; sessions accept up to remaining capacity ranked by score, bumping lower scorers on a better late proposal; repeat until every participant is matched or has exhausted their eligible set).
6. **Alternatives**: for every assignment (mandatory or elective), store the top-N ranked eligible sessions from that participant's slot-group eligible set in `allocation_alternatives`, with the winning session excluded from its own alternatives list. N and the low-confidence threshold (next step) are fixed constants for this phase — `ALTERNATIVES_COUNT = 5` and `LOW_CONFIDENCE_THRESHOLD = 0.4` — defined once in code, not admin-configurable and not stored per-run (there is no admin config UI for them in this phase). Because they're fixed constants rather than per-run inputs, they don't threaten reproducibility: the same code version always applies the same values.
7. **Low-confidence flagging**: `is_low_confidence = true` where `suitability_score` is below `LOW_CONFIDENCE_THRESHOLD`.
8. **Issue computation**: `unassigned` (exhausted eligible set with no capacity anywhere), `no_eligible_sessions` (hard filter produced zero candidates for that participant/slot — distinct from a capacity-driven `unassigned`), `schedule_conflict` (defensive validation pass, run once per allocation run after all assignments are made: for each participant, fetch all their `allocation_assignments` in this run joined to `sessions` for `start_time`/`end_time`, group by `conference_day_id`, and check every pairwise combination within a day for `tstzrange` overlap — the same overlap-detection shape as Phase 3's `enforce_speaker_no_conflict` trigger, applied here as a read-only post-hoc query rather than a write-time trigger. Should be structurally impossible given step 2's grouping guaranteeing at most one assignment per participant per connected component; any hit is raised as a `schedule_conflict` issue — a bug signal, never silently trusted), `capacity_bottleneck` (any session, mandatory or elective, that filled to capacity while eligible participants remained unmatched to it).
9. **Explanations**: for every assignment, one `allocation_assignment_explanations` row per hard constraint checked (pass/fail + human-readable detail) and one summarizing the tag-similarity contribution to the winning score.

## Manual Override Workflow

Within a `draft` allocation run, staff may override any individual `allocation_assignment`'s `session_id` to a different session (typically chosen from that assignment's stored alternatives, though not restricted to them — an admin can assign any session, subject to the same hard constraints being re-validated server-side at override time). Sets `is_manual_override = true`, `overridden_by`, `override_reason` (required text). Overriding does not re-run deferred acceptance for anyone else — it's a targeted, single-assignment edit within the draft, consistent with "each run is independent" (the override is part of *this* run's final state, not a new run).

**Failure behavior**: hard constraints are never bypassed for an override, exactly as for the initial run's own filtering. The server action re-checks constraints 1, 2, 4, 5 and dynamic capacity (constraint 3) for the target session before writing the override; if any fail, the action is rejected outright with a clear error identifying which constraint failed (e.g. "Cannot assign: session is at capacity", "Cannot assign: language mismatch"). There is no bypass, warning-and-proceed, or force flag — a rejected override leaves the existing assignment untouched.

**Capacity re-validation scope**: the capacity check at override time is scoped to *this allocation run only* — it counts this run's own `allocation_assignments` rows currently pointing at the target session (any status, `proposed` or `confirmed`) against that session's `capacity`. It does not consider assignments from other allocation runs, consistent with the independent-runs model (two draft runs over the same data snapshot never contend with each other for the same seats).

## Confirmation

A `draft` allocation run is confirmed via one explicit action (`confirmAllocationRun`) that transitions `allocation_runs.status → 'confirmed'`, sets `confirmed_at`/`confirmed_by`, and transitions every `allocation_assignments.status → 'confirmed'` in that run, all within one transaction (mirroring Phase 3's RPC-based transactional pattern for multi-row atomic operations). Once confirmed, a run's assignments become immutable — no further overrides are permitted on a confirmed run (a new run must be created if changes are needed later, per the independent-runs model). A run may alternatively be `discarded` (never confirmed, kept for audit history) rather than confirmed.

## Pages (surface, following Phase 3's route-group/auth-gate conventions)

- `/admin/allocation` — overview linking to sub-sections.
- `/admin/allocation/extraction` — manage `feature_extraction_rules` (CRUD, versioned), trigger new extraction runs, view past runs.
- `/admin/allocation/clustering` — list/trigger clustering runs, view clusters and membership per run.
- `/admin/allocation/runs` — list allocation runs, trigger new runs.
- `/admin/allocation/runs/[id]` — draft-run review: summary counts, filterable assignment table, per-assignment detail (score/explanation/alternatives) with override control, Confirm/Discard actions.
- `/admin/allocation/runs/[id]/capacity` — per-session capacity usage view (filled/capacity, oversubscription flags). For a `draft` run, "filled" counts assignments in **either** `'proposed'` or `'confirmed'` status (a draft run's assignments are almost entirely `'proposed'` until confirmation — excluding them would show the view as permanently empty). For a `confirmed` run, all its assignments are `'confirmed'`, so the distinction is moot there.

## Access Control

Identical to Phase 3: `agenda_allocation_manager`/`super_admin` only, reusing `requireAgendaStaffCaller`/`isAgendaStaffRole` as-is (same role pair, no new role introduced). RLS enabled on every new table, staff-only `for all` policies, defense-in-depth (the operative gate is each server action's own role check via the service-role client). Extraction/allocation computation reads `applications` via the service-role client because the existing `applications_select_staff` RLS policy (from `20260721212035_rls_policies.sql`) only grants read access to `registration_admission_manager` and `super_admin` — it does not include `agenda_allocation_manager`. Phase 4 does **not** modify that policy or add `agenda_allocation_manager` to it; `applications` is owned by the admission-review feature (Phase 2), and widening its RLS policy is out of scope here. The service-role client is the correct, minimal way for Phase 4's staff-gated server actions to read the accepted-applications data they need without touching another phase's access-control surface.

## Testing Requirements

1. Feature extraction: unit tests for array-value matching, keyword-substring matching, multi-rule weight summing/clamping, rule versioning — pure functions, no DB.
2. Clustering: unit test confirming k-means determinism (identical seed+k+input → byte-identical output across repeated invocations).
3. Hard constraints: unit tests per constraint (language, difficulty-adjacency including boundary tiers, mandatory exclusion, capacity, confirmed-status, include-in-allocation) — pure functions over fixture data.
4. Deferred acceptance: unit tests for the matching algorithm (capacity respected, determinism given fixed scores, correct bumping behavior on a late higher-scored proposal).
5. Live behavioral suite (hosted Supabase, real throwaway users/data, mirroring Phase 3's pattern): oversubscribed mandatory session produces a `capacity_bottleneck` + correct `unassigned` set; a participant with zero eligible sessions in a slot produces `no_eligible_sessions`; low-confidence threshold correctly flags/doesn't-flag at the boundary; manual override persists and is reflected in the confirmed run's final state; confirming a run makes it immutable (a second override/confirm attempt on a confirmed run is rejected); unauthorized roles (`participant`, wrong-module staff) rejected at every new server action.
6. Reproducibility test: running identical extraction+clustering+allocation parameters twice against an unchanged data snapshot produces byte-identical stored output (same assignments, same scores, same cluster memberships) — the test that actually proves the "reproducible runs" requirement.

## Out of Scope (confirmed non-goals, do not implement here)

- Automated applicant scoring, screening, admission recommendations, automatic accept/reject/waitlist
- QR code generation/scanning, attendance tracking
- Participant-facing schedule publishing/display
- LLM/NLP-based feature extraction
- Cross-run diffing or "aware of previous run" allocation logic
- Joint whole-schedule (multi-slot) optimization
- Clusters influencing or gating allocation decisions
