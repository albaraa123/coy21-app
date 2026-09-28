# Phase 6 — Secure Participant QR Issuance: RPC & Token-Lifecycle Reference (Draft)

Status: draft under review, not yet part of the approved design spec. Consolidates every
correction made through this brainstorming round. Once approved, folds into the full
`2026-08-02-participant-qr-issuance-design.md` spec alongside the permission/RLS matrix,
scanner-integration section, mockups, migration strategy, testing strategy, phased plan,
and risks/alternatives.

---

## 1. Schema changes (additive to the approved `qr_credentials` design + `scan_attempts`)

**New dependency this round:** the finalizers in §5.1/§5.2 compute `finalization_fingerprint`
using `digest()`, which requires the `pgcrypto` extension. Supabase projects have it available by
default (`extensions` schema, pre-installed), but it is not automatically enabled in every
project — verify and enable explicitly as the first migration statement, not assumed silently:
```sql
create extension if not exists pgcrypto with schema extensions;
```
This is a verification item for the Migration Strategy section, tracked here since it is a hard
prerequisite for the fingerprint logic introduced this round.

### 1.1 `qr_credentials` — verified against the actual repository state

**Correction this round:** the previous draft carried both an `ALTER TABLE qr_credentials ADD
COLUMN reissue_channel ...` statement (§1.1) and a full `CREATE TABLE qr_credentials (...)`
statement (§1.2) that already included `reissue_channel` in its column list — an invalid
migration sequence (the `ALTER` would fail with "column already exists" if run after the
`CREATE`, or "relation does not exist" if run before it). Verified directly against this
repository: `supabase\migrations\` contains **no** migration creating `qr_credentials` under any
name — grepped across every `.sql` file in that directory with zero matches. This confirms
`qr_credentials` does not exist in this codebase yet; Phase 6 is a from-scratch schema addition,
not an incremental change against an already-applied table. The stray `ALTER TABLE` (a leftover
artifact from an earlier brainstorming round, before `reissue_channel` had been folded into the
`CREATE TABLE` statement directly) is removed. §1.2 below is the entire, single, correct
migration statement for this table — no separate `ALTER` precedes or follows it.

### 1.2 `qr_credentials` — full final constraint set

```sql
create table public.qr_credentials (
  id                        uuid primary key default gen_random_uuid(),
  application_id            uuid not null references public.applications(id) on delete restrict,

  token_version             smallint not null default 1 check (token_version between 1 and 32767),
  token_hash                bytea not null check (octet_length(token_hash) = 32),
  token_ciphertext          bytea,
  encryption_key_version    smallint check (encryption_key_version between 1 and 32767),

  status                    text not null check (status in ('active','revoked','replaced')),
  issuance_channel          text not null check (issuance_channel in
                               ('participant_self_service','staff_individual','staff_bulk','system')),

  issued_at                 timestamptz not null default now(),
  issued_by                 uuid references public.profiles(id) on delete set null,
  issuance_reason_code      text,
  issuance_note             text check (char_length(issuance_note) <= 500),

  revoked_at                timestamptz,
  revoked_by                uuid references public.profiles(id) on delete set null,
  revocation_reason_code    text,
  revocation_note           text check (char_length(revocation_note) <= 500),

  replaced_at               timestamptz,
  replaced_by               uuid references public.profiles(id) on delete set null,
  replaced_by_credential_id uuid,
  reissue_channel           text check (reissue_channel in
                               ('participant_self_service','staff_individual','staff_bulk','system')),
  reissue_reason_code       text,
  reissue_note              text check (char_length(reissue_note) <= 500),

  created_at                timestamptz not null default now(),

  constraint qr_credentials_token_hash_unique unique (token_hash),
  constraint qr_credentials_no_self_replacement check (id is distinct from replaced_by_credential_id),

  -- Required so qr_credentials_replacement_same_application_fkey below can
  -- reference (id, application_id) as a composite FK target — id alone is
  -- already the primary key, but Postgres requires the EXACT column pair a
  -- composite FK references to be covered by its own unique constraint/
  -- index, not merely implied by a unique constraint on a subset of it.
  -- This is a unique constraint on a superset of the primary key
  -- (id is already unique on its own), which is standard practice for this
  -- "FK must agree with a sibling column" pattern and adds no new
  -- uniqueness requirement beyond what the primary key already guarantees.
  constraint qr_credentials_id_application_unique unique (id, application_id),

  -- CORRECTED this round: replaced_by_credential_id was previously a plain
  -- single-column FK against qr_credentials(id), which enforced only "this
  -- id exists somewhere in the table" — it never required the replacement
  -- target to belong to the SAME application as the row being replaced. A
  -- direct service_role write (or a bug in a future RPC) could otherwise
  -- record a credential from a completely different application as the
  -- "replacement" for this one, corrupting the reissue lineage. Enforced
  -- now as a genuine database invariant via a deferred COMPOSITE FK against
  -- (id, application_id) instead of a single-column FK against id alone —
  -- requires qr_credentials_id_application_unique above, a unique
  -- constraint on that exact pair (a unique constraint on a superset of
  -- the primary key is standard practice for this "FK must agree with a
  -- sibling column" pattern; id alone already being the primary key does
  -- not by itself let Postgres reference (id, application_id) as a
  -- composite FK target).
  -- deferrable initially deferred for the same reason the previous
  -- single-column FK was: the old row must leave 'active' status before
  -- the new row becomes active (satisfying qr_credentials_one_active_per_application),
  -- while the FK requires the new row to already exist before the old
  -- row's update references it — deferring to commit resolves the
  -- opposing ordering requirement exactly as before.
  constraint qr_credentials_replacement_same_application_fkey
    foreign key (replaced_by_credential_id, application_id)
    references public.qr_credentials (id, application_id)
    on delete restrict
    deferrable initially deferred,

  -- issued_by/replaced_by are required only at creation time for staff
  -- channels, enforced transactionally in the RPC, not as a durable
  -- row-shape check (a durable NOT NULL would conflict with ON DELETE SET
  -- NULL once a staff profile is deleted). The only durable channel/actor
  -- rule the database itself enforces forever — restored this round after
  -- the finalizers were found unconditionally writing
  -- v_op.requested_by_profile_id into issued_by/replaced_by regardless of
  -- channel, which populated a "staff actor" on a participant_self_service
  -- row (requested_by_profile_id is auth.uid() itself for the participant
  -- reservation RPCs, never null):
  constraint qr_credentials_self_service_has_no_actor check (
    issuance_channel <> 'participant_self_service' or issued_by is null
  ),
  constraint qr_credentials_self_service_reissue_has_no_actor check (
    reissue_channel is distinct from 'participant_self_service' or replaced_by is null
  ),

  constraint qr_credentials_active_is_consistent check (
    status <> 'active' or (
      token_ciphertext is not null and encryption_key_version is not null
      and revoked_at is null and revoked_by is null and revocation_reason_code is null and revocation_note is null
      and replaced_at is null and replaced_by is null and replaced_by_credential_id is null
      and reissue_channel is null and reissue_reason_code is null and reissue_note is null
    )
  ),
  constraint qr_credentials_revoked_is_consistent check (
    status <> 'revoked' or (
      revoked_at is not null and revocation_reason_code is not null
      and token_ciphertext is null and encryption_key_version is null
      and replaced_at is null and replaced_by is null and replaced_by_credential_id is null
      and reissue_channel is null and reissue_reason_code is null and reissue_note is null
    )
  ),
  constraint qr_credentials_replaced_is_consistent check (
    status <> 'replaced' or (
      replaced_at is not null and replaced_by_credential_id is not null
      and reissue_channel is not null and reissue_reason_code is not null
      and token_ciphertext is null and encryption_key_version is null
      and revoked_at is null and revoked_by is null and revocation_reason_code is null and revocation_note is null
    )
  )
);

create unique index qr_credentials_one_active_per_application
  on public.qr_credentials (application_id) where status = 'active';

create unique index qr_credentials_replacement_target_unique
  on public.qr_credentials (replaced_by_credential_id) where replaced_by_credential_id is not null;

create index qr_credentials_application_idx on public.qr_credentials (application_id);

-- No RLS policies of any kind are added for any client role. Default-deny.
-- All access goes through the security-definer RPCs in this document.
alter table public.qr_credentials enable row level security;
```

Note on `qr_credentials_replacement_same_application_fkey`: **is** `deferrable initially deferred`,
and **is** a composite FK against `(replaced_by_credential_id, application_id)` rather than a
single-column FK against `id` alone. The single-column version (previous draft) only proved the
target id existed somewhere in the table — it never required the replacement to belong to the SAME
application as the row being replaced, which is a real invariant this design depends on (a reissue
must produce a new credential for the same applicant, never silently reference an unrelated
application's credential via a direct write or a future RPC bug). The composite form forces
Postgres to verify both columns against the same target row via
`qr_credentials_id_application_unique`, closing that gap as a durable database constraint instead
of an application-level assumption.

The deferral itself is required, not optional — a plain (non-deferred) FK, or a same-statement CTE
insert-then-update, cannot satisfy both the partial unique index (`qr_credentials_one_active_per_application`)
and the FK simultaneously, because the two constraints have opposing ordering requirements: the
unique index requires the OLD row to leave `active` status *before* the NEW row becomes active
(otherwise two active rows briefly coexist for one application, immediately violating the
index — this is a same-statement, non-deferrable btree check, not something CTE row-evaluation
order can work around), while a non-deferred FK on `replaced_by_credential_id` requires the NEW
row to already exist *before* the OLD row's `update` can legally reference it. These two orderings
are mutually exclusive under immediate constraint checking. Deferring the FK to end-of-transaction
resolves this: the OLD row is updated first (freeing the unique-index slot immediately, satisfying
the index with no deferral needed there), the NEW row is inserted second (satisfying the index,
now the only active row), and the FK's referential check — deferred — only actually runs at
`commit`, by which point the referenced row unquestionably exists. The exact transaction is
specified in full in §5.2.

### 1.3 `scan_attempts` — additive columns, backfill, and `result` values

**Live constraint verified before touching anything.** The current
`scan_attempts_result_check` (from `supabase/migrations/20260804130000_create_scan_attempts_table.sql`,
cross-checked against every `v_result :=` assignment in
`20260804160000_scan_attempt_transactional_function.sql` to confirm no value is missing from the
written-out list) is exactly:
```sql
check (result in (
  'admitted', 'flexible_admitted', 'priority_hold', 'full',
  'restricted_denied', 'duplicate', 'timeslot_conflict', 'invalid_qr', 'override_admitted'
))
```
All nine values are carried forward unchanged below — none dropped, none renamed.

**Migration must run as four ordered steps, not one, because a NOT-VALID-for-existing-rows
constraint cannot be added before those rows are backfilled:**

**Step 1 — add both columns as nullable (no constraint yet):**
```sql
alter table scan_attempts add column finalized_at timestamptz;
alter table scan_attempts add column expires_at timestamptz;
```

**Step 2 — backfill every existing row.** `scan_attempts` has no separate "completion
timestamp" column today — every historical row was written by the current
`scan_attempt_transactional`, which only ever writes already-terminal outcomes (the pending
concept does not exist before this migration), so `created_at` is the correct and only
available backfill source for every existing row:
```sql
update scan_attempts set finalized_at = created_at where finalized_at is null;
```

**Step 3 — update every existing writer to set `finalized_at` going forward**, before the
constraint can be safely added. `scan_attempt_transactional` (existing function, migration
`20260804160000`) has exactly one `insert into scan_attempts (...)` statement (line 142 of that
file); it is altered to include `finalized_at) values (..., now())` — this is the one small,
additive change to that function's existing insert list. (Its full internal decision logic is
separately refactored into `perform_admission_decision` per §5.8 — that refactor and this
`finalized_at` addition are described together in the Migration Strategy section of the full
spec, since they touch the same migration.)

**Step 4 — only now add the check constraint**, with the corrected result-value list and the
new pending/finalized mutual-exclusivity rule:
```sql
alter table scan_attempts drop constraint scan_attempts_result_check;
alter table scan_attempts add constraint scan_attempts_result_check check (result in (
  -- existing values, UNCHANGED (verified above), still used for their current pre-QR meanings:
  'admitted', 'flexible_admitted', 'priority_hold', 'full',
  'restricted_denied', 'duplicate', 'timeslot_conflict', 'invalid_qr', 'override_admitted',
  -- new, additive, QR-specific:
  'token_malformed', 'token_unknown', 'token_revoked', 'token_replaced', 'token_ineligible',
  'token_valid_pending_confirmation', 'expired_pending', 'cancelled_by_operator'
));

alter table scan_attempts add constraint scan_attempts_finalization_state_check check (
  (
    result = 'token_valid_pending_confirmation'
    and finalized_at is null
    and expires_at is not null
    and expires_at > created_at
  )
  or
  (
    result <> 'token_valid_pending_confirmation'
    and finalized_at is not null
    and expires_at is null
  )
);

create index scan_attempts_pending_expiry_idx on scan_attempts (expires_at)
  where result = 'token_valid_pending_confirmation' and finalized_at is null;
```
By step 4, every historical row was backfilled in step 2 (`finalized_at = created_at`,
`expires_at = null`, `result` one of the original nine, none of which is
`'token_valid_pending_confirmation'`) — satisfying the constraint's second branch — and every
row written after step 3 already carries a correct `finalized_at`, so the constraint add
validates cleanly against 100% of existing data with no exceptions.

`finalized_at is null` (now database-enforced, not just documented, to mean exactly
`result = 'token_valid_pending_confirmation'`) is the sole "is this row still pending" signal.
Exactly three RPCs are permitted to finalize such a row: `confirm_scan_attempt_transactional`,
`cancel_scan_attempt_transactional`, and the scheduled `expire_stale_pending_scan_attempts`
job — each via a locked, conditional update that can only succeed once per row (proven in §6).

**Addition per this round's review — `scan_attempts_finalization_state_check` requires
`expires_at IS NULL` on every terminal row, not merely `finalized_at IS NOT NULL`.** This means
every one of the three finalizer paths above must, in the *same* `update` statement, set all
three of `result`, `finalized_at = now()`, **and `expires_at = null`** — setting only `result`
and `finalized_at` while leaving a stale non-null `expires_at` on a now-terminal row would
violate the constraint immediately. This applies without exception to:
- `confirm_scan_attempt_transactional` (§5.5) — its terminal `update` must include `expires_at = null`
  alongside `result`/`finalized_at`/`resulting_attendance_id`;
- `cancel_scan_attempt_transactional` (§5.6) — same;
- `expire_stale_pending_scan_attempts` (the scheduled job) — its `update ... where result =
  'token_valid_pending_confirmation' and finalized_at is null and expires_at <= now()` must
  likewise set `expires_at = null` as part of the same statement that sets
  `result = 'expired_pending'`/`finalized_at = now()`;
- the one place inside `confirm_scan_attempt_transactional` that self-expires a stale row it
  discovers mid-confirmation (§5.5's independent expiry re-check) — same three-column update.

This requirement is stated here, in the schema section, precisely so that the RPC bodies
written out in Group 3 cannot be drafted against only "set result and finalized_at" and
silently violate the constraint — every finalizing `update` in this document is written with
all three columns from this point forward.

**Repository-wide compatibility sweep, performed for this correction (not assumed):** every
file in this repository referencing `scan_attempts` was searched, not just the current
production RPC. Findings:
- `supabase/migrations/20260804160000_scan_attempt_transactional_function.sql` — the existing
  function's one `insert into scan_attempts (...)` statement (already covered by §1.3 Step 3's
  `finalized_at` addition above; the same statement also needs no `expires_at` column at all,
  since a direct insert of an already-terminal row satisfies the constraint's second branch
  with `expires_at` simply omitted/defaulting to its column default of `null`).
- `tests/attendance/scan-attempt-live.test.ts` — despite a comment saying it "seeds N raw
  attendance_records + scan_attempts rows directly," its actual `seedAttendanceRecords` helper
  (lines 143–156) inserts **only** into `attendance_records`, never `scan_attempts` — no change
  needed; the comment is imprecise but the code is compatible.
- `tests/attendance/scanner-device-access-live.test.ts:424-430` — **a real incompatibility**: a
  service-role fixture-seeding insert writes a terminal result (`'flexible_admitted'`) with no
  `finalized_at` at all. Once `scan_attempts_finalization_state_check` exists, this insert fails
  outright. **Required fixture change:**
  ```ts
  const { error: scanAttemptInsertError } = await admin.from('scan_attempts').insert({
    application_id: outOfScopeApplicationId,
    session_id: outOfScopeSessionId,
    result: 'flexible_admitted',
    scanned_by: scannerId,
    finalized_at: new Date().toISOString(),
  });
  ```
- `tests/attendance/admission-management-live.test.ts:686-701` — this test asserts that a
  **participant-role RLS-scoped insert is rejected**; the insert is expected to fail on RLS
  before it ever reaches the check constraint (participants have no `scan_attempts` insert
  policy today, and this design adds none). No change needed, but flagged explicitly rather
  than silently assumed compatible without inspection.
- `tests/attendance/scan-attempt-concurrency-live.test.ts` and the remaining files in the
  16-file `scan_attempts` reference set (`tests/import/*.ts`, `resolve-admission-decision.test.ts`,
  `admission-management.ts`, `scan-attempt.ts`, `src/types/database.ts`) — read-only queries,
  `.delete()` cleanup calls, or type definitions; none construct a `scan_attempts` row and so
  none are affected by the new constraint. `src/types/database.ts`'s generated types will need
  regenerating after the migration lands (new columns), a routine step noted for the Migration
  Strategy section, not a compatibility risk.

The one required code change (`scanner-device-access-live.test.ts`) is small and will be made
as part of this feature's migration PR, alongside the schema changes themselves, so the test
suite never observes a broken intermediate state.

### 1.4 Reason-code vocabularies (enforced, not free text)

**Correction from the previous round:** the participant reissue vocabulary previously listed
only four codes; the actually-approved mockup vocabulary has **six**. The two missing codes
(`qr_display_issue`, `security_concern`) are added below. The prior round's text incorrectly
claimed "the participant-facing four... are fixed from the already-approved... mockup" — that
claim is withdrawn; the approved set was always six, and only four were carried into the SQL.

```sql
alter table qr_credentials add constraint qr_credentials_issuance_reason_code_valid check (
  issuance_reason_code is null or issuance_reason_code in (
    'advance_badge_printing', 'participant_not_logged_in', 'bulk_event_preparation', 'staff_other',
    -- Added per this round's correction: the SYSTEM-INTERNAL code
    -- automatically applied to a replacement credential's OWN
    -- issuance_reason_code when reissue_qr_credential_transactional
    -- creates it (§5.2) — distinct from a fresh, ground-up issuance.
    -- Never supplied directly by any RPC caller as an input value; only
    -- ever written by reissue_qr_credential_transactional itself. The
    -- detailed cause of the reissue lives on the OLD (now-replaced)
    -- credential's reissue_reason_code/reissue_note, not here.
    'reissued_credential'
  )
);
alter table qr_credentials add constraint qr_credentials_revocation_reason_code_valid check (
  revocation_reason_code is null or revocation_reason_code in (
    'suspected_compromise', 'participant_request', 'administrative_correction', 'staff_other'
  )
);
alter table qr_credentials add constraint qr_credentials_reissue_reason_code_valid check (
  reissue_reason_code is null or reissue_reason_code in (
    -- Participant self-service — the full approved six-option vocabulary:
    'lost_or_stolen_phone', 'screenshot_shared', 'printed_copy_lost',
    'qr_display_issue', 'security_concern', 'participant_other',
    -- Staff force-reissue — separate, staff-scoped codes:
    'staff_assisted_recovery', 'suspected_compromise', 'administrative_correction', 'staff_other'
  )
);
```
Human-readable Arabic/English labels for every code live in `src/messages/en.json`/`ar.json`,
never stored in the database. The staff-facing codes remain a first proposal for this draft,
open for adjustment on review; the participant-facing six are now the confirmed, complete set.

**Conditional validation beyond "is this code in the allowed list."** A code being a member of
its vocabulary is necessary but not sufficient — which vocabulary applies, and whether a note
is required, both depend on channel and code together. These rules are enforced **in the
RPCs** (§5), since expressing "the note must be non-empty when the code is X, but only for
channel Y" as a single portable `check` constraint across two columns and a channel column
would be fragile and hard to read; the constraints above catch "wrong code entirely," the RPC
body catches "right code, wrong channel, or missing required note":

- **`participant_self_service` issuance** (first-time, no reissue involved): `issuance_reason_code`
  and `issuance_note` must both be `null` — a normal participant self-issuance carries no reason
  at all, since there's nothing to explain yet. `issue_qr_credential_transactional` rejects the
  call if either is non-null on this channel.
- **`staff_individual`/`staff_bulk` issuance**: `issuance_reason_code` must be one of the four
  staff issuance codes above (never a participant code, never a reissue code) — rejected
  otherwise. If the code is `'staff_other'`, `issuance_note` must be present and, after
  `trim()`, non-empty — rejected otherwise (a bare `'staff_other'` with no explanation is not
  useful audit data).
- **`participant_self_service` reissue**: `reissue_reason_code` must be one of the six
  participant codes above — never a staff code. If the code is `'participant_other'`,
  `reissue_note` must be present and non-empty after trimming — the design's earlier
  "supports the approved optional explanation when the participant selects 'Other'" requirement
  is corrected here from *optional* to *required-when-Other*, matching how `'staff_other'` is
  handled, for consistency and because an empty "Other" reason is not meaningfully auditable.
- **Staff force-reissue** (`p_is_staff_force = true`): `reissue_reason_code` must be one of the
  four staff reissue codes above — never a participant code. `'staff_other'` requires a
  non-empty trimmed `reissue_note`, same rule as staff issuance.
- **Revocation**: `revocation_reason_code` must be one of the four revocation codes above.
  `'staff_other'` requires a non-empty trimmed `revocation_note`.

Every RPC in §5 that accepts a `p_..._reason_code`/`p_..._note` pair validates all of the above
explicitly at the top of its body — defense in depth alongside the column-level `check`
constraints, consistent with the existing `qr_credentials_*_is_consistent` constraints'
philosophy of never trusting a single layer alone. The exact `raise exception` wording for each
validation failure will be finalized alongside the full RPC bodies in Group 3.

### 1.5 Defensive lifecycle/immutability trigger

Default-deny RLS (§1.2's `enable row level security` with zero policies) and routing all writes
through the RPCs in §5 are the primary defense, but neither protects against an accidental
direct `update`/`delete` issued with the `service_role` key (which bypasses RLS entirely) —
whether from a future bug, a misconfigured admin script, or a compromised service-role
credential used carelessly rather than maliciously. A `before update`/`before delete` trigger
on `qr_credentials` is a second, independent layer that enforces the lifecycle rules even
against writes that don't go through any of this document's RPCs.

**Correction from the previous round:** the prior trigger draft was incomplete in two ways —
(a) several columns (`id`, `created_at`, `encryption_key_version`, `issuance_reason_code`,
`issuance_note`) had no immutability protection at all, and (b) the actor-column checks only
blocked *reassignment while still non-null*, not the more dangerous case of a column that has
already gone `non-null → null` (via `on delete set null`) later being written back to a
*different* profile ID — a gap because `old.x is not null and ...` skips the check entirely
once `old.x` is already `null`. The rewrite below tracks "has this column ever been non-null"
implicitly by checking `new.x is not null and old.x is distinct from new.x` unconditionally
(covering both "was null, now non-null" and "was one profile, now a different one"), while
still explicitly permitting the one legal transition (non-null → null).

**Corrections applied this round, on top of the above:**
1. **Actor semantics were still wrong for `system`.** The INSERT branch's staff-actor check
   (`issuance_channel <> 'participant_self_service' and new.issued_by is null` → reject) treated
   `system`-channel rows as if they were staff-channel rows, forcing a non-null `issued_by` on a
   channel that has no staff actor by definition. The corrected rule below distinguishes all four
   channels explicitly: `participant_self_service` and `system` both require `issued_by is null`;
   `staff_individual` and `staff_bulk` both require `issued_by is not null`. The identical
   correction applies to `reissue_channel`/`replaced_by` on the active → replaced UPDATE
   transition — and there the gap was slightly wider than for `issued_by`, since
   `qr_credentials_self_service_reissue_has_no_actor` (§1.2) only excludes
   `reissue_channel = 'participant_self_service'`, not `'system'`; the trigger enforces the full
   four-way split explicitly rather than leaning on that incomplete CHECK constraint.
2. **Authorized-role validation was previously a documented punt** (the removed comment said role
   validity is "intentionally NOT re-verified here"). That left a durable database-level gap: a
   direct `service_role` insert/update naming an arbitrary `profiles.id` as `issued_by`,
   `revoked_by`, or `replaced_by` — including a participant's own profile id, or a profile with no
   staff role at all — was structurally accepted. The corrected trigger now re-verifies, on every
   INSERT and on every legal actor-assignment transition, that the named actor profile actually has
   role `super_admin` or `program_attendance_manager` (the same authorized-staff-role set used
   throughout §4's authorization matrix and §1.6a's bulk-batch checks), raising otherwise. This is
   one extra lookup per actor-assignment — not the hot path (which is INSERT with a `system` or
   `participant_self_service` channel, requiring no lookup at all) — and is deliberately narrower
   than "re-derive authorization from scratch": it checks role membership only, not batch/operation
   linkage, which remains the RPCs' job.
3. **`created_at = issued_at` was not enforced anywhere.** Both are independently defaulted to
   `now()` at INSERT (§1.2), which is two separate clock reads that can differ by microseconds
   under concurrent load, and neither was ever compared against the other. The corrected INSERT
   branch requires `new.created_at = new.issued_at` exactly. This required a matching fix to
   both finalizer `insert`s in §5.1/§5.2 (`finalize_qr_issuance_for_server` and
   `finalize_qr_reissue_for_server`), which previously omitted `created_at` from their column
   list entirely — leaving it to the table's own independent `default now()`, a second clock
   read from the `v_transition_now` value each finalizer already uses for `issued_at`, which
   would have violated this new invariant on every legitimate finalized insert. Both finalizers
   now pass `v_transition_now` explicitly for both columns.
4. **The ciphertext envelope shape and version byte were validated only inside the finalizer RPCs**
   (§5.1/§5.2's `octet_length(p_token_ciphertext) <> 61` / `get_byte(p_token_ciphertext, 0) <> 1`
   checks), never at the table level — meaning a direct `service_role` insert bypassing both
   finalizers entirely could store a malformed or wrong-version envelope with no defense-in-depth
   layer to catch it, defeating §1.5's own stated purpose of protecting "even against a bug in this
   design's own RPCs." The corrected INSERT branch re-validates both the 61-byte length and the
   version-1 tag byte directly against `new.token_ciphertext`.
5. **The encryption-key version was never confirmed active at the table level.** The finalizer
   already re-checks `qr_encryption_key_registry.status = 'active'` under `for share` (§5.1 step 7),
   but a direct `service_role` insert bypassing the finalizer had no equivalent check — it could
   insert an active credential referencing a `decrypt_only` or `retired` key version, silently
   producing a credential that can never be legitimately re-encrypted going forward. The corrected
   INSERT branch requires `public.is_encryption_key_version_active(new.encryption_key_version)` to
   be true.

```sql
-- CORRECTED this round: the previous actor-column guard rejected the
-- LEGITIMATE first assignment of revoked_by/replaced_by. Both columns
-- are null on an active row by construction (§1.2's
-- qr_credentials_active_is_consistent constraint), so on the one legal
-- active -> revoked/replaced transition, old.revoked_by/old.replaced_by
-- IS null and new.revoked_by/new.replaced_by IS the (possibly non-null)
-- staff profile being recorded — exactly the case the previous guard's
-- "new.x is not null and new.x is distinct from old.x" condition matched
-- and rejected. The corrected rule scopes each actor column's "may be set
-- to a non-null value" window to the exact transition where it is
-- legitimately allowed to change, and forbids it everywhere else:
--   issued_by: settable only at INSERT (guarded in the INSERT branch
--     below), immutable non-null-to-different-non-null or null-to-non-null
--     on every subsequent UPDATE; may transition to null via ON DELETE SET
--     NULL at any time.
--   revoked_by: may transition null -> (null | staff profile) ONLY in the
--     same UPDATE that also performs old.status = 'active' -> new.status =
--     'revoked'; immutable thereafter except non-null -> null via ON
--     DELETE SET NULL.
--   replaced_by: identical shape, keyed on the active -> replaced
--     transition instead.
create function public.qr_credentials_enforce_lifecycle_trigger() returns trigger
language plpgsql as $$
declare
  v_actor_role text;
begin
  if tg_op = 'DELETE' then
    raise exception 'qr_credentials rows are never deleted, only transitioned';
  end if;

  -- INSERT guard: a newly inserted credential must always begin in the one
  -- legal "freshly issued" shape — never a pre-revoked or pre-replaced row,
  -- even via a direct service-role insert that bypasses the finalizer RPCs
  -- entirely. The finalizers themselves already only ever insert 'active'
  -- rows; this is the second, independent, table-level enforcement layer.
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'A newly inserted qr_credentials row must have status = active';
    end if;
    if new.revoked_at is not null or new.revoked_by is not null
       or new.revocation_reason_code is not null or new.revocation_note is not null
    then
      raise exception 'A newly inserted qr_credentials row must have all revocation fields null';
    end if;
    if new.replaced_at is not null or new.replaced_by is not null
       or new.replaced_by_credential_id is not null or new.reissue_channel is not null
       or new.reissue_reason_code is not null or new.reissue_note is not null
    then
      raise exception 'A newly inserted qr_credentials row must have all replacement fields null';
    end if;
    if new.token_ciphertext is null or new.encryption_key_version is null then
      raise exception 'A newly inserted qr_credentials row must have non-null ciphertext and encryption_key_version';
    end if;

    -- Correction 3: created_at and issued_at are two independently
    -- defaulted now() reads (§1.2) and must agree exactly on a freshly
    -- inserted row — no legitimate insert path produces a credential
    -- "issued" at a different instant than it was "created."
    if new.created_at is distinct from new.issued_at then
      raise exception 'created_at must equal issued_at on insert';
    end if;

    -- Correction 4: re-validate the ciphertext envelope shape and version
    -- byte at the table level. §5.1/§5.2's finalizers already check this
    -- (octet_length = 61, version byte = 1) before ever calling INSERT, but
    -- this trigger's whole purpose (per the prose above) is to defend even
    -- against a bug in those RPCs or a direct service-role bypass — so the
    -- same check is restated here, independently.
    if octet_length(new.token_ciphertext) <> 61 then
      raise exception 'Invalid or malformed ciphertext envelope';
    end if;
    if get_byte(new.token_ciphertext, 0) <> 1 then
      raise exception 'Unsupported ciphertext envelope version';
    end if;

    -- Correction 5: the referenced key version must currently be active.
    -- The finalizer re-checks this under FOR SHARE (§5.1 step 7) before its
    -- own INSERT, but a direct service-role insert bypassing the finalizer
    -- had no equivalent defense — it could otherwise silently activate a
    -- credential against a decrypt_only/retired key version.
    if not public.is_encryption_key_version_active(new.encryption_key_version) then
      raise exception 'encryption_key_version must be an active key version';
    end if;

    -- Correction 1: actor semantics corrected for all four channels.
    -- participant_self_service and system both carry no staff actor;
    -- staff_individual and staff_bulk both require one. The table CHECK
    -- constraints (qr_credentials_self_service_has_no_actor /
    -- _reissue_has_no_actor) already enforce the participant_self_service
    -- half of this structurally; the trigger enforces the full four-way
    -- split, including the system channel the previous draft mis-grouped
    -- with the staff channels.
    if new.issuance_channel in ('participant_self_service', 'system') then
      if new.issued_by is not null then
        raise exception '% channel rows must have issued_by null', new.issuance_channel;
      end if;
    else
      if new.issued_by is null then
        raise exception '% channel rows must have a non-null issued_by', new.issuance_channel;
      end if;
      -- Correction 2: authorized-role validation, previously a documented
      -- punt. A staff actor must actually hold an authorized staff role at
      -- the moment of insert — the same super_admin/program_attendance_manager
      -- set used throughout §4's authorization matrix and §1.6a's bulk-batch
      -- checks — not merely be some arbitrary profiles.id.
      select role into v_actor_role from public.profiles where id = new.issued_by;
      if v_actor_role is null or v_actor_role not in ('super_admin', 'program_attendance_manager') then
        raise exception 'issued_by must reference a profile with an authorized staff role';
      end if;
    end if;

    return new;
  end if;

  -- Immutable regardless of status transition, forever, no exceptions:
  if new.id is distinct from old.id then
    raise exception 'id is immutable';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at is immutable';
  end if;
  if new.application_id is distinct from old.application_id then
    raise exception 'application_id is immutable';
  end if;
  if new.token_hash is distinct from old.token_hash then
    raise exception 'token_hash is immutable';
  end if;
  if new.token_version is distinct from old.token_version then
    raise exception 'token_version is immutable';
  end if;
  if new.issuance_channel is distinct from old.issuance_channel then
    raise exception 'issuance_channel is immutable';
  end if;
  if new.issued_at is distinct from old.issued_at then
    raise exception 'issued_at is immutable';
  end if;
  if new.issuance_reason_code is distinct from old.issuance_reason_code then
    raise exception 'issuance_reason_code is immutable';
  end if;
  if new.issuance_note is distinct from old.issuance_note then
    raise exception 'issuance_note is immutable';
  end if;

  -- issued_by: set only at INSERT (guarded above); on every UPDATE it may
  -- only transition non-null -> null (ON DELETE SET NULL). It is never
  -- legitimately set to a non-null value by any UPDATE, since it is
  -- always already populated (or intentionally null) at INSERT time.
  if new.issued_by is distinct from old.issued_by and new.issued_by is not null then
    raise exception 'issued_by can never be (re)assigned by update, only set at insert or cleared to null';
  end if;

  -- Status transition whitelist: only active -> revoked and active -> replaced.
  if old.status is distinct from new.status then
    if old.status <> 'active' or new.status not in ('revoked', 'replaced') then
      raise exception 'Illegal status transition: % -> %', old.status, new.status;
    end if;
  end if;

  -- revoked_by: the ONLY transition permitted to move it from null to a
  -- (possibly non-null) value is the active -> revoked transition itself.
  -- Every other UPDATE may only move it non-null -> null (ON DELETE SET
  -- NULL) or leave it unchanged. Correction 2: when it IS legally assigned
  -- a non-null value here, that value must name an authorized staff role —
  -- the same re-verification applied to issued_by at INSERT.
  if old.status = 'active' and new.status = 'revoked' then
    -- legal window: revoked_by may become non-null here.
    if new.revoked_by is not null then
      select role into v_actor_role from public.profiles where id = new.revoked_by;
      if v_actor_role is null or v_actor_role not in ('super_admin', 'program_attendance_manager') then
        raise exception 'revoked_by must reference a profile with an authorized staff role';
      end if;
    end if;
  else
    if new.revoked_by is distinct from old.revoked_by and new.revoked_by is not null then
      raise exception 'revoked_by can only be assigned during the active -> revoked transition, or cleared to null';
    end if;
  end if;

  -- replaced_by: identical shape, keyed on active -> replaced. Gated on
  -- reissue_channel exactly as issued_by is gated on issuance_channel at
  -- INSERT (correction 1): qr_credentials_self_service_reissue_has_no_actor
  -- only covers reissue_channel = 'participant_self_service' — it does NOT
  -- cover 'system', which shares the same "no staff actor" semantics but is
  -- not itself excluded by that CHECK constraint's text. The trigger closes
  -- that gap explicitly rather than relying on the incomplete CHECK.
  if old.status = 'active' and new.status = 'replaced' then
    if new.reissue_channel in ('participant_self_service', 'system') then
      if new.replaced_by is not null then
        raise exception '% reissue_channel rows must have replaced_by null', new.reissue_channel;
      end if;
    else
      if new.replaced_by is null then
        raise exception '% reissue_channel rows must have a non-null replaced_by', new.reissue_channel;
      end if;
      select role into v_actor_role from public.profiles where id = new.replaced_by;
      if v_actor_role is null or v_actor_role not in ('super_admin', 'program_attendance_manager') then
        raise exception 'replaced_by must reference a profile with an authorized staff role';
      end if;
    end if;
  else
    if new.replaced_by is distinct from old.replaced_by and new.replaced_by is not null then
      raise exception 'replaced_by can only be assigned during the active -> replaced transition, or cleared to null';
    end if;
  end if;

  -- Terminal statuses (revoked/replaced) are write-once for their own
  -- lifecycle-ending metadata: once set on a specific row transition, those
  -- fields cannot be rewritten again on a later update to the same row —
  -- EXCEPT revoked_by/replaced_by, which are separately permitted (above)
  -- to transition to null via ON DELETE SET NULL even on an
  -- already-terminal row; this block only guards the NON-actor fields of
  -- each terminal shape.
  if old.status = 'revoked' and new.status = 'revoked' then
    if new.revoked_at is distinct from old.revoked_at
       or new.revocation_reason_code is distinct from old.revocation_reason_code
       or new.revocation_note is distinct from old.revocation_note then
      raise exception 'revocation metadata is immutable once set';
    end if;
  end if;
  if old.status = 'replaced' and new.status = 'replaced' then
    if new.replaced_at is distinct from old.replaced_at
       or new.replaced_by_credential_id is distinct from old.replaced_by_credential_id
       or new.reissue_channel is distinct from old.reissue_channel
       or new.reissue_reason_code is distinct from old.reissue_reason_code
       or new.reissue_note is distinct from old.reissue_note then
      raise exception 'replacement metadata is immutable once set';
    end if;
  end if;

  -- Cryptographic material: explicit rules per requirement, not merely
  -- "ciphertext can only go non-null -> null."
  if old.status = 'active' and new.status = 'active' then
    -- While a credential remains active, both fields must be BYTE-FOR-BYTE
    -- unchanged — not merely "still non-null."
    if new.token_ciphertext is distinct from old.token_ciphertext then
      raise exception 'token_ciphertext must not change while a credential remains active';
    end if;
    if new.encryption_key_version is distinct from old.encryption_key_version then
      raise exception 'encryption_key_version must not change while a credential remains active';
    end if;
  end if;
  if old.status = 'active' and new.status in ('revoked', 'replaced') then
    -- The one legal transition: both fields MUST go from non-null to null,
    -- together, in this exact transition — not independently, not partially.
    if new.token_ciphertext is not null or new.encryption_key_version is not null then
      raise exception 'token_ciphertext and encryption_key_version must both be cleared to null during active -> % transition', new.status;
    end if;
  end if;
  if old.status in ('revoked', 'replaced') then
    -- Terminal credentials must never regain either value, regardless of
    -- what new.status is being set to (which the whitelist above has
    -- already restricted to "unchanged," but this is stated independently
    -- as its own defense-in-depth rule per the requirement).
    if new.token_ciphertext is not null or new.encryption_key_version is not null then
      raise exception 'a terminal (revoked/replaced) credential can never regain ciphertext or a key version';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.qr_credentials_enforce_lifecycle_trigger() from public;

create trigger qr_credentials_lifecycle_guard
  before insert or update or delete on public.qr_credentials
  for each row execute function public.qr_credentials_enforce_lifecycle_trigger();
```
This trigger fires regardless of which Postgres role performs the write — including
`service_role` — so it protects even against a bug in this design's own RPCs, not just against
external/unauthorized access. It explicitly permits the one legitimate cross-cutting mutation
(`issued_by`/`revoked_by`/`replaced_by` transitioning to `null` via `on delete set null`, in
either direction of already-null or becoming-null-now) without treating that as an illegal
lifecycle rewrite, while closing the null-then-repopulated gap identified in this round's
review. All references are schema-qualified (`public.qr_credentials`,
`public.qr_credentials_enforce_lifecycle_trigger`) per the hardening requirement, and `EXECUTE`
on the trigger function itself is revoked from `PUBLIC` — it is invoked only by the trigger
mechanism, never called directly by any role, so no `grant` to any role is needed at all.

### 1.6 Encryption-key-version registry — three-state, singleton-active, per this round's correction

**Corrections from this round, applied together:** (1) key retirement must not race with an
in-flight finalizer holding a key version it read as `active`; (2) only `super_admin` — not
`program_attendance_manager` — manages key lifecycle; (3) at most one key version may be
`active` at a time, and rotation is one transactional operation; (4) the transition whitelist is
exactly two edges (`active → decrypt_only`, `decrypt_only → retired`), same-state requests are a
no-op with no duplicate audit row, and a defensive trigger backs the whitelist so a direct
owner/service-role `update` cannot bypass it; (5)/(11) `entity_id` on `audit_logs` is
**verified `uuid not null`** (`supabase/migrations/20260722200245_agenda_enums_and_reference_tables.sql:93`)
— `p_key_version::text` from the previous draft would have failed outright at insert time, since
a `smallint`-derived text is not a valid UUID cast target for a `uuid` column. Fixed by giving
the registry its own surrogate `id uuid` and logging that.

```sql
create table public.qr_encryption_key_registry (
  id             uuid primary key default gen_random_uuid(),  -- audit_logs.entity_id target (verified uuid not null)
  key_version    smallint not null unique check (key_version between 1 and 32767),
  status         text not null check (status in ('active', 'decrypt_only', 'retired')),
  activated_at   timestamptz not null default now(),
  retired_at     timestamptz,
  constraint qr_encryption_key_registry_active_has_no_retired_at check (
    status = 'retired' or retired_at is null
  ),
  constraint qr_encryption_key_registry_retired_requires_retired_at check (
    status <> 'retired' or retired_at is not null
  )
);

-- Point 3: at most one ACTIVE key version, ever, enforced structurally —
-- not merely by application-level discipline. Postgres has no direct
-- "unique where status='active'" syntax for a single-row singleton without
-- a natural key to index; the standard idiom is to index a constant
-- expression, so every 'active' row collides on the same index value.
create unique index qr_encryption_key_registry_one_active_idx
  on public.qr_encryption_key_registry ((true)) where status = 'active';

insert into public.qr_encryption_key_registry (key_version, status) values (1, 'active');

alter table public.qr_encryption_key_registry enable row level security;
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_encryption_key_registry from anon, authenticated;

-- CORRECTED this round: is_encryption_key_version_active was previously a
-- plain LANGUAGE SQL ... STABLE function performing an unlocked read. The
-- finalizers' own key-registry check (§5.1/§5.2 step 7) takes the row
-- FOR SHARE before re-checking status = 'active', which correctly excludes
-- a rotation from racing a finalizer that has already committed to a key
-- version — but that protection lives entirely inside the finalizer RPCs.
-- A direct service_role INSERT that bypasses both finalizers (exactly the
-- path qr_credentials_enforce_lifecycle_trigger() exists to defend, per
-- §1.5's own stated purpose) only ever went through this STABLE function,
-- which took no lock at all — an unlocked read here could observe
-- status = 'active' a moment before a concurrent rotation flips it to
-- decrypt_only, let the INSERT through, and never be caught by anything,
-- since the trigger's own check was the last line of defense and it
-- wasn't actually locking anything. Rewritten as LANGUAGE PLPGSQL
-- (STABLE removed — a function that takes a row lock has side effects on
-- lock state and must not be marked STABLE) that takes the SAME FOR SHARE
-- lock the finalizers already take, so the trigger's check has the
-- identical race-safety guarantee as the finalizers' own, regardless of
-- which code path reaches the INSERT.
-- CORRECTED this round: `return v_status = 'active';` returns NULL, not
-- false, when p_key_version matches no row at all (v_status stays NULL,
-- and `NULL = 'active'` is NULL under three-valued logic, not false). The
-- trigger calls this as `if not public.is_encryption_key_version_active(...)
-- then raise exception ... end if;` — `not NULL` is also NULL, and an
-- `if NULL then` branch is never entered, so an UNKNOWN key version
-- (one with no registry row at all, not merely a non-active one) silently
-- skipped the trigger's own controlled rejection entirely, falling through
-- to whatever unrelated error (or none) the rest of the INSERT produced.
-- Wrapping in coalesce(..., false) makes the function total: it returns a
-- definite boolean for every possible input, including an unregistered
-- key version, matching the trigger's `if not ...` contract exactly.
-- Reformatted this round into canonical CREATE FUNCTION option order
-- (LANGUAGE, then volatility, then SECURITY DEFINER, then SET) to avoid
-- any parser ambiguity and make the intended VOLATILE explicit rather
-- than merely implied by its absence from the STABLE/IMMUTABLE keywords.
create function public.is_encryption_key_version_active(
  p_key_version smallint
) returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status
  into v_status
  from public.qr_encryption_key_registry
  where key_version = p_key_version
  for share;

  return coalesce(v_status = 'active', false);
end;
$$;

create function public.is_encryption_key_version_decryptable(p_key_version smallint) returns boolean
language sql security definer set search_path = public, pg_temp stable as $$
  select coalesce(
    (select status in ('active', 'decrypt_only') from public.qr_encryption_key_registry where key_version = p_key_version),
    false
  );
$$;

revoke all on function public.is_encryption_key_version_active(smallint) from public, anon, authenticated;
revoke all on function public.is_encryption_key_version_decryptable(smallint) from public;
-- is_encryption_key_version_active is called from
-- qr_credentials_enforce_lifecycle_trigger() (§1.5), which is NOT security
-- definer and therefore runs as invoker — i.e. as whichever role actually
-- performs the raw DML against qr_credentials (service_role for every
-- finalizer in this document, since they are security definer functions
-- owned by a privileged role, and potentially service_role directly for a
-- raw bypass insert/update). Grant to BOTH service_role (the invoking role
-- for every real write path) and — implicitly, as the function owner —
-- whichever role owns this function in the deployed schema (typically
-- `postgres` under Supabase's default migration-apply role), since a
-- SECURITY DEFINER function's body executes with the OWNER's privileges
-- for its own internal reads/locks regardless of who calls it; the
-- EXECUTE grant below controls who may call it at all, not what privilege
-- level its body runs under once called. Without the service_role grant,
-- revoke all above leaves service_role with no path to EXECUTE this
-- function, and the trigger would fail with a permission error instead of
-- performing its intended race-safe active-key-version check.
grant execute on function public.is_encryption_key_version_active(smallint) to service_role;

-- Concurrency behavior of the FOR SHARE lock inside
-- is_encryption_key_version_active, documented explicitly since this same
-- lock is now taken from two independent call sites (the finalizers'
-- inline check, and this trigger-facing helper) against the same row:
--
-- 1. An INSERT into qr_credentials (via a finalizer, or a direct
--    service_role bypass) that reaches this function's FOR SHARE first
--    acquires a shared lock on the key-registry row. A concurrent
--    rotate_encryption_key_version_for_server call, which takes that same
--    row FOR UPDATE (§1.6, "lock the current active key row FIRST"), must
--    wait for every shared lock to release — so the INSERT's own
--    transaction is free to finish (commit or abort) without the rotation
--    ever observing an inconsistent status mid-check.
-- 2. Symmetrically, if rotation's FOR UPDATE is acquired first, a
--    concurrent INSERT's FOR SHARE here waits for the rotation's
--    transaction to finish. If the rotation commits before the INSERT's
--    lock is granted, the INSERT observes the ALREADY-ROTATED status
--    (decrypt_only) once it finally acquires its shared lock — and is
--    correctly rejected, exactly the scenario this correction exists to
--    close for a direct-bypass INSERT.
-- 3. After a rotation transaction commits, every subsequent INSERT
--    referencing the now-decrypt_only key version is rejected by this
--    function's own status = 'active' check — there is no window after
--    commit where a stale in-memory read could let one through, since
--    each call re-reads the row fresh under its own lock.
-- 4. The trigger and a finalizer may safely both acquire FOR SHARE on the
--    same key-registry row within the SAME transaction (e.g. a finalizer
--    takes its own FOR SHARE at step 7, then its INSERT fires this
--    trigger, which takes FOR SHARE again on the identical row) — FOR
--    SHARE locks are non-exclusive with respect to OTHER FOR SHARE
--    holders, including a second acquisition by the SAME transaction, so
--    this never self-deadlocks or blocks.

-- Point 9 (previous round) + Point 3 (this round): full defensive trigger.
-- CORRECTED per this round: the previous version returned immediately on
-- old.status = new.status, which meant retired_at (or any other column)
-- could be silently rewritten on an already-retired row, since only the
-- table CHECK constraint (retired_at is not null while retired) was
-- guarding it — that constraint permits retired_at to change to a
-- DIFFERENT non-null value, which is wrong. The trigger now separately
-- validates lifecycle-timestamp immutability even on a same-state update.
create function public.qr_encryption_key_registry_enforce_lifecycle_trigger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'qr_encryption_key_registry rows are never deleted, only transitioned';
  end if;

  -- INSERT guard (this round's addition): a newly inserted key version
  -- must always begin 'active' with retired_at null — direct insertion of
  -- a decrypt_only or retired row is rejected. Only the rotation
  -- (active -> decrypt_only, via a subsequent UPDATE) and retirement
  -- (decrypt_only -> retired) transitions may ever produce those
  -- statuses; a row can never be BORN into either. The migration seed
  -- (`insert into public.qr_encryption_key_registry (key_version, status)
  -- values (1, 'active')`) satisfies this by construction.
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'A newly inserted qr_encryption_key_registry row must have status = active';
    end if;
    if new.retired_at is not null then
      raise exception 'A newly inserted qr_encryption_key_registry row must have retired_at null';
    end if;
    return new; -- the table's own qr_encryption_key_registry_one_active_idx
                -- independently enforces the singleton-active invariant on
                -- this INSERT — no additional check needed here.
  end if;

  if new.id is distinct from old.id then raise exception 'id is immutable'; end if;
  if new.key_version is distinct from old.key_version then raise exception 'key_version is immutable'; end if;
  if new.activated_at is distinct from old.activated_at then raise exception 'activated_at is immutable'; end if;

  -- Corrected this round: the previous version keyed the "retired_at must
  -- be null" check off OLD.status, which made the one legal
  -- decrypt_only -> retired transition impossible (old.status was still
  -- 'decrypt_only' at evaluation time, even though new.status was
  -- 'retired' and new.retired_at was correctly non-null). retired_at
  -- rules must key off NEW.status instead:
  if new.status in ('active', 'decrypt_only') and new.retired_at is not null then
    raise exception 'retired_at must remain null while status is active or decrypt_only';
  end if;
  if old.status = 'decrypt_only' and new.status = 'retired' then
    if old.retired_at is not null or new.retired_at is null then
      raise exception 'retired_at must transition from null to a non-null value exactly when decrypt_only -> retired';
    end if;
  end if;
  if old.status = 'retired' and new.retired_at is distinct from old.retired_at then
    raise exception 'retired_at is immutable once a key version is retired';
  end if;

  if old.status = new.status then
    -- Same-state request: status itself didn't change, but the blocks
    -- above already caught any illegal retired_at rewrite. No OTHER
    -- lifecycle field is allowed to change here either — this table has
    -- no additional mutable fields beyond status/retired_at, so reaching
    -- this point with old.status = new.status and a legal retired_at
    -- means nothing of consequence changed; permit it.
    return new;
  end if;

  if old.status = 'active' and new.status = 'decrypt_only' then
    -- legal; retired_at already verified null above via the new.status check
  elsif old.status = 'decrypt_only' and new.status = 'retired' then
    -- legal; retired_at's null -> non-null transition already verified above
  else
    raise exception 'Illegal key version status transition: % -> %', old.status, new.status;
  end if;

  return new;
end;
$$;

revoke all on function public.qr_encryption_key_registry_enforce_lifecycle_trigger() from public;

create trigger qr_encryption_key_registry_lifecycle_guard
  before insert or update or delete on public.qr_encryption_key_registry
  for each row execute function public.qr_encryption_key_registry_enforce_lifecycle_trigger();

-- Point 1/2 (this round): serialized via a fixed advisory transaction
-- lock, idempotent, machine-readable result, and the audit_logs insert
-- column/value ordering FIXED (see the malformed statement identified
-- this round). Registering/activating a NEW key version is
-- service-role-only, called from trusted Node code only AFTER it has
-- independently verified the corresponding external key material exists,
-- decodes, and is exactly 32 bytes — this function trusts that
-- verification already happened; it never receives the key material or
-- any secret-variable name itself, only the version NUMBER.
create function public.rotate_encryption_key_version_for_server(
  p_new_key_version smallint
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_current public.qr_encryption_key_registry;
  v_existing_new public.qr_encryption_key_registry;
  v_now timestamptz;
begin
  if p_new_key_version is null or p_new_key_version not between 1 and 32767 then
    raise exception 'Invalid key version';
  end if;

  -- Point 2: fixed, well-known advisory lock — not derived from any row
  -- data — held for the transaction's duration, serializing ALL concurrent
  -- rotation attempts against EACH OTHER before either one so much as
  -- reads a row. This is deliberately a coarser mechanism than the
  -- finalizers' per-row FOR SHARE (rotation is rare and exclusive by
  -- nature; unlike finalization, there is no benefit to letting two
  -- rotations proceed concurrently).
  perform pg_advisory_xact_lock(hashtext('qr_encryption_key_rotation'));

  -- Idempotency: has this exact version already been registered?
  select * into v_existing_new from public.qr_encryption_key_registry where key_version = p_new_key_version;
  if v_existing_new.id is not null then
    if v_existing_new.status = 'active' then
      return 'already_rotated'; -- safe replay: this rotation already committed, no new audit rows
    end if;
    raise exception 'Key version % already exists with status %, cannot be reused for a new rotation', p_new_key_version, v_existing_new.status;
  end if;

  -- Lock the current active key row FIRST, THEN capture the transition
  -- timestamp — corrected this round: the previous draft captured v_now
  -- before acquiring this lock, so a session that waited on the lock would
  -- record a transition timestamp earlier than when it actually observed
  -- and mutated the row.
  select * into v_current from public.qr_encryption_key_registry where status = 'active' for update;

  v_now := clock_timestamp(); -- one captured timestamp, reused for both the row update and its audit metadata

  if v_current.id is not null then
    update public.qr_encryption_key_registry set status = 'decrypt_only' where id = v_current.id;
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, metadata, created_at)
    values (
      'qr_encryption_key', v_current.id, 'key_version_transitioned', 'system',
      jsonb_build_object('from_status', 'active', 'to_status', 'decrypt_only', 'key_version', v_current.key_version),
      v_now
    );
  end if;
  -- Zero active keys is acceptable temporarily (point 3, prior round) —
  -- if v_current was not found, this rotation activates the new version
  -- with no predecessor to demote; issuance fails closed in the interim.

  insert into public.qr_encryption_key_registry (key_version, status, activated_at)
  values (p_new_key_version, 'active', v_now);

  -- Point 1 fix: column list and value list now correctly correspond —
  -- entity_type gets the literal text, entity_id gets the new row's uuid.
  insert into public.audit_logs (entity_type, entity_id, action, actor_type, metadata, created_at)
  select 'qr_encryption_key', id, 'key_version_transitioned', 'system',
    jsonb_build_object('from_status', null, 'to_status', 'active', 'key_version', p_new_key_version),
    v_now
  from public.qr_encryption_key_registry where key_version = p_new_key_version;

  return 'rotated';
end;
$$;

revoke all on function public.rotate_encryption_key_version_for_server(smallint) from public;
grant execute on function public.rotate_encryption_key_version_for_server(smallint) to service_role;

-- Retirement (decrypt_only -> retired) is super_admin-only, NOT
-- program_attendance_manager — the one narrower role-gate in this entire
-- document, since key-material lifecycle is a strictly higher-privilege
-- operation than credential issuance/revocation.
create function public.retire_encryption_key_version(p_key_version smallint) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_current public.qr_encryption_key_registry;
  v_active_count integer;
  v_now timestamptz;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role <> 'super_admin' then
    raise exception 'Not authorized';
  end if;

  -- Same fixed advisory lock as rotation — retirement and rotation both
  -- mutate this table's singleton-active invariant space and should not
  -- interleave arbitrarily.
  perform pg_advisory_xact_lock(hashtext('qr_encryption_key_rotation'));

  select * into v_current from public.qr_encryption_key_registry where key_version = p_key_version for update;
  if v_current.id is null then raise exception 'Unknown key version'; end if;

  -- Same-state request is a no-op, no duplicate audit row.
  if v_current.status = 'retired' then
    return 'already_in_status';
  end if;
  if v_current.status <> 'decrypt_only' then
    raise exception 'Only a decrypt_only key version may be retired (current status: %)', v_current.status;
  end if;

  select count(*) into v_active_count
    from public.qr_credentials where status = 'active' and encryption_key_version = p_key_version;
  if v_active_count > 0 then
    raise exception 'Cannot retire key version %: % active credential(s) still reference it', p_key_version, v_active_count;
  end if;

  v_now := clock_timestamp();

  update public.qr_encryption_key_registry set status = 'retired', retired_at = v_now where id = v_current.id;

  insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
  values (
    'qr_encryption_key', v_current.id, 'key_version_transitioned', 'admin', v_caller.id,
    jsonb_build_object('from_status', 'decrypt_only', 'to_status', 'retired', 'key_version', p_key_version),
    v_now
  );
  return 'retired';
end;
$$;

revoke all on function public.retire_encryption_key_version(smallint) from public;
grant execute on function public.retire_encryption_key_version(smallint) to authenticated;
-- (super_admin-only, enforced inside)
```
`qr_credentials.encryption_key_version` gets a foreign key to the registry's `key_version`
column (which retains its own `unique` constraint, so this FK target is valid), `on delete
restrict`:
```sql
alter table public.qr_credentials
  add constraint qr_credentials_encryption_key_version_fkey
  foreign key (encryption_key_version) references public.qr_encryption_key_registry(key_version)
  on delete restrict;
```

**Point 1 — finalizer lock ordering, stated here since it governs how every finalizer in §5.1/§5.2
must read the registry.** Every issuance/reissue finalizer locks, in order: (1) the lifecycle
operation, (2) the application (only where the finalizer itself needs to re-verify eligibility),
(3) the current credential (reissue only), (4) the selected key-registry row via `for share`
(shared lock — multiple concurrent finalizers reading the *same still-active* key version do not
block each other, only a concurrent *retirement* attempt, which needs `for update`, blocks
against them). This ordering is written out explicitly in each finalizer's body in the next
message; stated here as the rule those bodies implement.

### 1.6a `qr_bulk_operation_batches` — closes the `staff_bulk` self-labeling gap

**Correction from this round:** an ordinary authenticated staff browser session must not be able
to label a single reservation call `staff_bulk` merely by passing that string as a parameter —
doing so grants no *additional* authorization, but it does let a manager's one-off action
misrepresent itself in the audit trail as part of a bulk operation, which is a real integrity
gap in reporting even if not in access control. Fixed with the server-issued batch-ID model: a
bulk *orchestration* decision (Node server action, itself gated by the same
`requireProgramAttendanceStaffCaller()`-style check used elsewhere in this codebase) creates one
batch row **before** looping reservation calls; each individual reservation call then proves it
belongs to that batch by passing the batch's id, which the reservation RPC independently
validates rather than trusting a bare string.

**Strengthened this round (point 7):** the previous draft's batch validation only checked that
*some* batch row existed and was recent — it did not verify the batch belongs to the *calling*
staff member, nor that its intended operation type (issue vs. reissue) matches the call, nor did
it carry any explicit lifecycle of its own. A batch is now a first-class lifecycle object: it
records both the auth-user id and profile id of its creator (mirroring `qr_lifecycle_operations`'
own actor-identity pattern), has its own `expires_at` and three-state `status`
(`active`/`completed`/`cancelled`), and declares up front which operation type it is for. The
reservation RPCs (§5.1/§5.2) require the resolved caller's profile id to match
`created_by_profile_id`, the batch's `status = 'active'`, `expires_at > now()`, and
`intended_operation_type` to match the call — a batch created for `issue` cannot be used to
authorize a `reissue` reservation, or vice versa.

```sql
create table public.qr_bulk_operation_batches (
  id                       uuid primary key default gen_random_uuid(),
  created_by_auth_user_id  uuid not null,
  created_by_profile_id    uuid references public.profiles(id) on delete set null,
  intended_operation_type  text not null check (intended_operation_type in ('issue', 'reissue')),
  status                   text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  created_at               timestamptz not null default now(),
  expires_at               timestamptz not null check (expires_at > created_at),
  closed_at                timestamptz,

  constraint qr_bulk_operation_batches_active_has_no_closed_at check (
    status <> 'active' or closed_at is null
  ),
  constraint qr_bulk_operation_batches_closed_requires_closed_at check (
    status = 'active' or closed_at is not null
  )
);

create index qr_bulk_operation_batches_active_expiry_idx on public.qr_bulk_operation_batches (expires_at)
  where status = 'active';

alter table public.qr_bulk_operation_batches enable row level security;
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_bulk_operation_batches from anon, authenticated;

-- Defensive trigger, same discipline as every other lifecycle table in
-- this document: identity fields immutable forever, status whitelist
-- enforced even against a direct service-role/owner write.
create function public.qr_bulk_operation_batches_enforce_lifecycle_trigger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'qr_bulk_operation_batches rows are never deleted, only transitioned';
  end if;

  -- INSERT guard (this round's addition): a newly inserted batch must
  -- always begin 'active' with closed_at null, must declare a valid
  -- operation type, must have matching auth-user/profile ownership (the
  -- same 1:1 identity check create_qr_bulk_operation_batch_for_server
  -- already performs — restated here as a table-level second layer, not
  -- merely trusted from the RPC), and must reference a profile that is
  -- CURRENTLY a valid staff role. Unlike qr_credentials' INSERT guard
  -- (where re-checking role at the trigger layer was judged unnecessary
  -- overhead on issuance's hot path), bulk-batch creation is rare and
  -- low-frequency, so the extra profiles lookup here is an acceptable
  -- cost for a second, independent authorization-shape check.
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'A newly inserted qr_bulk_operation_batches row must have status = active';
    end if;
    if new.closed_at is not null then
      raise exception 'A newly inserted qr_bulk_operation_batches row must have closed_at null';
    end if;
    if new.intended_operation_type not in ('issue', 'reissue') then
      raise exception 'A newly inserted qr_bulk_operation_batches row must have a valid intended_operation_type';
    end if;
    if new.created_by_auth_user_id is null then
      raise exception 'created_by_auth_user_id is required';
    end if;
    if new.created_by_profile_id is null or new.created_by_profile_id <> new.created_by_auth_user_id then
      raise exception 'created_by_profile_id must equal created_by_auth_user_id';
    end if;
    if not exists (
      select 1 from public.profiles
      where id = new.created_by_profile_id and role in ('super_admin', 'program_attendance_manager')
    ) then
      raise exception 'created_by_profile_id must reference a currently authorized staff profile';
    end if;
    if new.expires_at <= new.created_at then
      raise exception 'expires_at must be after created_at';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id then raise exception 'id is immutable'; end if;
  if new.created_by_auth_user_id is distinct from old.created_by_auth_user_id then
    raise exception 'created_by_auth_user_id is immutable';
  end if;
  if new.intended_operation_type is distinct from old.intended_operation_type then
    raise exception 'intended_operation_type is immutable';
  end if;
  if new.created_at is distinct from old.created_at then raise exception 'created_at is immutable'; end if;
  if new.expires_at is distinct from old.expires_at then raise exception 'expires_at is immutable'; end if;

  if new.created_by_profile_id is not null
     and new.created_by_profile_id is distinct from old.created_by_profile_id then
    raise exception 'created_by_profile_id can never be (re)assigned by update, only cleared to null';
  end if;

  if old.status is distinct from new.status then
    if old.status <> 'active' or new.status not in ('completed', 'cancelled') then
      raise exception 'Illegal bulk batch status transition: % -> %', old.status, new.status;
    end if;
  end if;
  if old.status in ('completed', 'cancelled') and new.closed_at is distinct from old.closed_at then
    raise exception 'closed_at is immutable once a batch is closed';
  end if;

  return new;
end;
$$;

revoke all on function public.qr_bulk_operation_batches_enforce_lifecycle_trigger() from public;

create trigger qr_bulk_operation_batches_lifecycle_guard
  before insert or update or delete on public.qr_bulk_operation_batches
  for each row execute function public.qr_bulk_operation_batches_enforce_lifecycle_trigger();

-- CORRECTED this round: p_staff_auth_user_id and p_staff_profile_id were
-- previously independent, untrusted parameters with no cross-check between
-- them — a caller could in principle supply a mismatched pair. Per this
-- repository's actual schema (supabase/migrations/20260721200747_roles_and_profiles.sql:11,
-- `profiles.id uuid primary key references auth.users(id)`), a profile's id
-- IS the owning auth user's id — a strict 1:1 relationship, not a separate
-- foreign key to a distinct auth-user column. The two parameters are kept
-- (mirroring qr_lifecycle_operations' own requested_by_auth_user_id /
-- requested_by_profile_id pair, for symmetry and so a future schema change
-- decoupling profiles from auth.users doesn't require an API change here),
-- but this function now explicitly verifies they are the same value before
-- trusting either.
create function public.create_qr_bulk_operation_batch_for_server(
  p_staff_auth_user_id uuid,
  p_staff_profile_id uuid,
  p_intended_operation_type text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch_id uuid;
  v_created_at timestamptz;
begin
  if p_staff_auth_user_id is null then raise exception 'Staff auth user id is required'; end if;
  if p_intended_operation_type not in ('issue', 'reissue') then
    raise exception 'Invalid intended operation type';
  end if;
  if p_staff_profile_id is null or p_staff_profile_id <> p_staff_auth_user_id then
    raise exception 'Staff auth user id and profile id must identify the same account';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_staff_profile_id and role in ('super_admin','program_attendance_manager')
  ) then
    raise exception 'Invalid staff profile for bulk batch creation';
  end if;

  -- CORRECTED this round: one captured timestamp for BOTH created_at and
  -- expires_at, explicitly inserted — was previously relying on
  -- created_at's column default (now(), i.e. transaction-start time)
  -- while expires_at used clock_timestamp() (call-time), which can be a
  -- different instant within the same transaction, producing a batch
  -- whose stated 1-hour lifetime doesn't actually measure from its own
  -- created_at.
  v_created_at := clock_timestamp();

  insert into public.qr_bulk_operation_batches (
    created_by_auth_user_id, created_by_profile_id, intended_operation_type, created_at, expires_at
  ) values (
    p_staff_auth_user_id, p_staff_profile_id, p_intended_operation_type,
    v_created_at, v_created_at + interval '1 hour'
  ) returning id into v_batch_id;

  insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
  values (
    'qr_bulk_operation_batch', v_batch_id, 'bulk_batch_created', 'admin', p_staff_profile_id,
    jsonb_build_object('intended_operation_type', p_intended_operation_type),
    v_created_at
  );

  return v_batch_id;
end;
$$;

revoke all on function public.create_qr_bulk_operation_batch_for_server(uuid, uuid, text) from public;
grant execute on function public.create_qr_bulk_operation_batch_for_server(uuid, uuid, text) to service_role;
-- service_role-only: the decision to START a bulk operation is an
-- application-orchestration action authorized once, up front, by the
-- calling Next.js server action's own staff-role gate — not re-derived
-- per-row inside this table. This is the entire point of a batch id: one
-- authorization decision covers the whole batch, and every individual
-- reservation call in the loop below merely PROVES membership in an
-- already-authorized batch, rather than independently asserting bulk
-- status itself.

-- Called once by the Node orchestration loop after all reservations in
-- the batch have been attempted (successfully or not) — marks the batch
-- closed so its id can never be reused for a later, unrelated call.
create function public.complete_qr_bulk_operation_batch_for_server(p_batch_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch public.qr_bulk_operation_batches;
  v_now timestamptz;
begin
  select * into v_batch from public.qr_bulk_operation_batches where id = p_batch_id for update;
  if v_batch.id is null then raise exception 'Batch not found'; end if;
  if v_batch.status <> 'active' then
    return 'already_closed';
  end if;
  v_now := clock_timestamp();
  update public.qr_bulk_operation_batches set status = 'completed', closed_at = v_now where id = p_batch_id;
  insert into public.audit_logs (entity_type, entity_id, action, actor_type, metadata, created_at)
  values (
    'qr_bulk_operation_batch', p_batch_id, 'bulk_batch_completed', 'system',
    jsonb_build_object('created_by_profile_id', v_batch.created_by_profile_id), v_now
  );
  return 'completed';
end;
$$;

revoke all on function public.complete_qr_bulk_operation_batch_for_server(uuid) from public;
grant execute on function public.complete_qr_bulk_operation_batch_for_server(uuid) to service_role;
```
Both staff reservation RPCs (§5.1, §5.2) accept `p_bulk_batch_id uuid` **instead of** a free-form
`p_channel` parameter: `null` → `channel = 'staff_individual'` (the only possible outcome for an
ordinary one-off browser action, since there is no way to supply a valid batch id without the
server-side orchestration flow having called `create_qr_bulk_operation_batch_for_server` first);
a non-null value is validated against `qr_bulk_operation_batches` — must exist, `status =
'active'`, `expires_at > now()`, `created_by_profile_id` matching the resolved caller's own
profile id, and `intended_operation_type` matching the call (`issue` for the issuance RPC,
`reissue` for the reissue RPC) — before `channel = 'staff_bulk'` is ever stored, and the batch id
itself is persisted onto the resulting `qr_lifecycle_operations` row (§1.7, `bulk_batch_id`).
**Full signatures shown in §6 below**, since PostgreSQL's default-parameter ordering rule (point
6) requires `p_bulk_batch_id` to move to the end of each signature, no longer immediately after
`p_application_id`.

### 1.7 `qr_lifecycle_operations` — the reservation/finalization bridge table

**This is the central structural fix for the trust-boundary issue identified this round.**
Neither issuance nor reissue RPC accepts `token_hash`/`token_ciphertext`/credential-crypto
material from an `authenticated` caller anymore. A client-authenticated **reservation** RPC
records intent and returns only an opaque `operation_id`; a **service-role-only finalizer**
consumes that operation and performs the actual write.

**Point 6 prerequisite** — already satisfied. `qr_credentials` needs a composite unique constraint
so a composite FK can enforce "this credential really belongs to this application" structurally,
not just by convention. **Corrected this round:** an earlier draft declared this constraint twice,
under two different names — once here via a separate `alter table`
(`qr_credentials_id_application_id_unique`), and again inline in §1.2's `create table
public.qr_credentials` (`qr_credentials_id_application_unique`, added there to back
`qr_credentials_replacement_same_application_fkey`). A Postgres foreign key only needs *some*
unique constraint/index covering its exact referenced column pair to exist — it does not reference
that constraint by name — so the duplicate `alter table` here is removed entirely. The single
canonical constraint is `qr_credentials_id_application_unique`, declared once, inline, in §1.2.
Both this section's `qr_lifecycle_operations_expected_credential_fkey`/
`qr_lifecycle_operations_resulting_credential_fkey` below and §1.2's
`qr_credentials_replacement_same_application_fkey` reference the same `(id, application_id)` pair
and are both satisfied by that one constraint.

**Sub-pass 2 addition — `request_key`, a durable caller-supplied idempotency token.** A
database-generated `operation_id` alone does not protect a full issuance/reissue request against a
*lost response*: if the finalizer's write succeeds but the HTTP response never reaches the browser
(a network drop, a client crash, a proxy timeout), the caller has no record of `operation_id` at all
and cannot use the existing intent-match/`already_pending`/`already_finalized` machinery to recover
— from the caller's perspective, the request simply "didn't happen," and retrying constructs a
brand-new intent from scratch, reserving (and potentially finalizing) a *second* reissue. The fix:
the browser/server generates one random UUID **before** the user confirms the issuance/reissue
action, reuses that exact same UUID on every retry of that specific action, and passes it to the
reservation RPC. Stored as `request_key` — immutable once set, and **not itself secret**: it is a
plain client-generated correlation id, never a token, hash, ciphertext, or cryptographic nonce, and
carries no authority on its own (the reservation RPC still independently re-derives and
re-authorizes everything about the request; `request_key` only proves "this is the same click," not
"this click is legitimate"). A retry presenting the same `(requester, operation_type, request_key)`
with matching immutable intent returns the original operation (pending or consumed, exactly like the
existing intent-match path); a retry with the same key but a genuinely different intent (a different
reason code, a different bulk batch, etc.) returns a distinct, explicit `intent_conflict` outcome —
never silently reuses, never silently overwrites.

```sql
create table public.qr_lifecycle_operations (
  id                              uuid primary key default gen_random_uuid(),
  operation_type                  text not null check (operation_type in ('issue', 'reissue')),
  application_id                  uuid not null references public.applications(id) on delete restrict,
  requested_by_auth_user_id       uuid not null,
  requested_by_profile_id         uuid references public.profiles(id) on delete set null,
  channel                         text not null check (channel in
                                     ('participant_self_service','staff_individual','staff_bulk')),
  bulk_batch_id                   uuid references public.qr_bulk_operation_batches(id) on delete restrict,
  -- Sub-pass 2: caller-supplied, client-generated BEFORE the user confirms
  -- the action, reused verbatim on every retry of that same action. Not
  -- secret, not derived from any cryptographic material, and never a
  -- credential id/token/hash/ciphertext/nonce itself — a correlation id
  -- only. NOT NULL: every reservation path (participant and staff,
  -- individual and bulk) must supply one; there is no legacy/optional path
  -- that skips idempotency protection.
  --
  -- Format validation: the `uuid` column type itself is the format check —
  -- Postgres (and PostgREST's own parameter-binding layer, before the
  -- value ever reaches this table) rejects any value that is not a
  -- syntactically valid UUID at the type level, with no separate CHECK
  -- constraint needed. No value-range or content validation applies beyond
  -- "is a UUID" — unlike token_hash/token_ciphertext (§1.2), which carry
  -- meaningful shape constraints, request_key is an opaque client-chosen
  -- correlation token with no further structure to validate.
  --
  -- Migration ordering: declared inline in this CREATE TABLE, not via a
  -- later ALTER TABLE — avoiding the exact duplicate-declaration mistake
  -- found and corrected earlier in this document (§1.2's
  -- qr_credentials_id_application_unique). qr_lifecycle_operations is a
  -- new table in this same migration (Phase 6 is a from-scratch addition,
  -- §1.1), so there is no pre-existing deployed table this column needs to
  -- be added to after the fact — it exists from this table's very first
  -- creation statement.
  request_key                     uuid not null,
  reason_code                     text,
  note                            text check (char_length(note) <= 500),
  expected_current_credential_id  uuid,   -- NULL for issue; the active credential's id at
                                           -- reservation time, for reissue (see composite FK below)
  status                          text not null default 'pending' check (status in
                                     ('pending', 'consumed', 'expired', 'cancelled')),
  terminal_reason_code            text check (terminal_reason_code in (
                                     'ttl_expired', 'application_ineligible',
                                     'active_credential_already_exists',
                                     'expected_credential_changed', 'cancelled_by_server',
                                     'bulk_batch_unavailable', 'requester_no_longer_authorized',
                                     -- Added for participant self-reissue reservation
                                     -- (request_my_qr_reissue_transactional, this round):
                                     -- three reissue-specific terminal conditions that have
                                     -- no existing equivalent among the seven codes above.
                                     -- 'expected_credential_changed' is deliberately REUSED
                                     -- (not duplicated) for the case where the active
                                     -- credential still exists but no longer matches
                                     -- expected_current_credential_id — it already means
                                     -- exactly that. These three are genuinely new
                                     -- conditions issuance never has: reissue requires an
                                     -- active credential to exist at all (issuance requires
                                     -- the opposite), and only reissue is rate-limited.
                                     'no_active_credential', 'reissue_cooldown_active',
                                     'reissue_rate_limit_exceeded'
                                   )),
  created_at                      timestamptz not null default now(),
  expires_at                      timestamptz not null check (expires_at > created_at),
  consumed_at                     timestamptz,
  finalized_at                    timestamptz,
  resulting_credential_id         uuid,   -- see composite FK below
  -- This round: a non-secret, deterministic 32-byte fingerprint of exactly
  -- what was finalized, computed by the finalizer from the resulting
  -- credential UUID, token hash, token version, encryption-key version (AT
  -- THE TIME OF FINALIZATION), and a SHA-256 digest of the ciphertext
  -- envelope — see the finalizers below for the exact canonical encoding.
  -- Stored on the OPERATION (not derived from the credential row at replay
  -- time) specifically so idempotent-replay correctness never depends on
  -- qr_credentials.encryption_key_version, which is CLEARED to null on
  -- replacement/revocation (§1.2's active-is-consistent/revoked-is-consistent/
  -- replaced-is-consistent constraints) — a naive "recompute from the
  -- current credential row" comparison would silently break the moment a
  -- credential is later reissued or revoked, making already_finalized
  -- unrecoverable for a legitimately-delayed retry.
  finalization_fingerprint        bytea check (finalization_fingerprint is null or octet_length(finalization_fingerprint) = 32),

  -- Sub-pass 2, third correction round: persists the EXACT credential a
  -- cancelled-because-already-active issuance observed at cancellation
  -- time. Previously, replaying an 'active_credential_already_exists'
  -- cancellation re-queried "whichever credential is active right now" —
  -- if that credential was later revoked or replaced, a retry under the
  -- same request_key would replay a DIFFERENT credential (or none at all)
  -- than what the original decision actually observed, breaking
  -- historical replay stability. Composite FK mirrors
  -- qr_credentials_replacement_same_application_fkey/the expected/
  -- resulting_credential FKs below: proves the referenced credential
  -- belongs to THIS operation's application_id, not merely "some
  -- credential row somewhere." ON DELETE RESTRICT: qr_credentials rows
  -- are never deleted in this design (§1.5's trigger forbids it
  -- unconditionally), so this is unreachable in practice but stated for
  -- the same defense-in-depth reason every other credential FK in this
  -- table states it.
  terminal_related_credential_id  uuid,

  -- This round's addition: durably preserves the exact retry-eligibility
  -- boundary a cooldown/rate-limit denial computed at cancellation time.
  -- Without this, a replayed cooldown/rate-limit denial (same request_key,
  -- reused after the original response was lost) would have to
  -- RE-DERIVE "how long until retry is allowed" from the CURRENT set of
  -- consumed operations — which may have changed (a new reissue may have
  -- since consumed, shifting the window) since the original decision was
  -- made, silently returning a DIFFERENT retry_after_seconds than the one
  -- originally computed and already possibly acted upon by the caller.
  -- Storing the boundary itself, once, at the moment of denial, makes a
  -- replay purely a matter of reading this column and subtracting the
  -- current clock — never re-evaluating historical policy.
  terminal_retry_after_at         timestamptz,

  -- Point 5 (prior round): complete state-consistency, three real shapes
  -- (pending vs. consumed vs. expired-or-cancelled), each fully specified
  -- in both directions rather than only checking what must be non-null.
  -- Sub-pass 2: terminal_related_credential_id folded into every one of
  -- these — required null on pending/consumed/expired, and split within
  -- 'cancelled' by terminal_reason_code (below).
  constraint qr_lifecycle_operations_pending_is_consistent check (
    status <> 'pending' or (
      finalized_at is null and consumed_at is null and resulting_credential_id is null
      and terminal_reason_code is null and finalization_fingerprint is null
      and terminal_related_credential_id is null and terminal_retry_after_at is null
    )
  ),
  constraint qr_lifecycle_operations_consumed_is_consistent check (
    status <> 'consumed' or (
      finalized_at is not null and consumed_at is not null and resulting_credential_id is not null
      and terminal_reason_code is null and finalization_fingerprint is not null
      and terminal_related_credential_id is null and terminal_retry_after_at is null
    )
  ),
  -- consumed_at and finalized_at must be the exact same instant on a
  -- consumed row — a single database-captured transition timestamp, never
  -- two independently-set values that could drift.
  constraint qr_lifecycle_operations_consumed_timestamps_match check (
    status <> 'consumed' or consumed_at = finalized_at
  ),
  -- This round (point 9): expired/cancelled rows must carry a
  -- machine-readable, non-secret terminal_reason_code — never exception
  -- text, never anything derived from cryptographic material.
  -- Sub-pass 2: split into two constraints — 'expired' NEVER carries
  -- terminal_related_credential_id (nothing was ever "the current
  -- credential" for an operation that just timed out); 'cancelled'
  -- carries it if AND ONLY IF terminal_reason_code is specifically
  -- 'active_credential_already_exists' — every other cancellation reason
  -- (application_ineligible, expected_credential_changed,
  -- cancelled_by_server, bulk_batch_unavailable,
  -- requester_no_longer_authorized) has no associated credential to
  -- persist. FOURTH correction round: the reason code is now bound to the
  -- status itself, not merely required to be non-null — 'expired' can
  -- ONLY ever mean 'ttl_expired' (this table has no other concept of
  -- "timed out"; every other terminal-for-cause reason is, by
  -- definition, a 'cancelled' row, never an 'expired' one), and
  -- 'cancelled' can NEVER carry 'ttl_expired' (that value is reserved
  -- exclusively for the 'expired' status, so a direct service-role write
  -- cannot mislabel a for-cause cancellation as a timeout or vice versa).
  constraint qr_lifecycle_operations_expired_is_consistent check (
    status <> 'expired' or (
      finalized_at is not null and consumed_at is null and resulting_credential_id is null
      and terminal_reason_code = 'ttl_expired' and finalization_fingerprint is null
      and terminal_related_credential_id is null and terminal_retry_after_at is null
    )
  ),
  -- This round: terminal_retry_after_at follows the identical
  -- if-and-only-if pattern already established for
  -- terminal_related_credential_id/active_credential_already_exists —
  -- required exactly when terminal_reason_code is one of the two
  -- policy-driven denials ('reissue_cooldown_active',
  -- 'reissue_rate_limit_exceeded'), forbidden for every other cancellation
  -- reason. CORRECTED this round: terminal_related_credential_id is
  -- permitted ONLY for 'active_credential_already_exists' — NOT for
  -- 'expected_credential_changed', which (like every other cancellation
  -- reason) must leave it null. The earlier version of this comment
  -- incorrectly claimed 'expected_credential_changed' also used
  -- terminal_related_credential_id; the CHECK constraint below was always
  -- the authoritative source and never actually permitted that. The two
  -- "extra terminal fields" are mutually exclusive by reason code, never
  -- both set on the same row.
  constraint qr_lifecycle_operations_cancelled_is_consistent check (
    status <> 'cancelled' or (
      finalized_at is not null and consumed_at is null and resulting_credential_id is null
      and terminal_reason_code is not null and terminal_reason_code <> 'ttl_expired'
      and finalization_fingerprint is null
      and (
        (terminal_reason_code = 'active_credential_already_exists' and terminal_related_credential_id is not null)
        or (terminal_reason_code <> 'active_credential_already_exists' and terminal_related_credential_id is null)
      )
      and (
        (terminal_reason_code in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded') and terminal_retry_after_at is not null)
        or (terminal_reason_code not in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded') and terminal_retry_after_at is null)
      )
    )
  ),
  constraint qr_lifecycle_operations_reissue_has_expected_credential check (
    operation_type <> 'reissue' or expected_current_credential_id is not null
  ),
  constraint qr_lifecycle_operations_issue_has_no_expected_credential check (
    operation_type <> 'issue' or expected_current_credential_id is null
  ),
  -- This round (point 7): bulk_batch_id is required exactly when
  -- channel = 'staff_bulk', and must be absent for every other channel —
  -- closes the gap where a batch id could be recorded on the operation
  -- without the channel actually reflecting bulk provenance, or vice versa.
  constraint qr_lifecycle_operations_bulk_batch_matches_channel check (
    (channel = 'staff_bulk' and bulk_batch_id is not null)
    or (channel <> 'staff_bulk' and bulk_batch_id is null)
  ),
  -- For a consumed reissue, the result must genuinely be a DIFFERENT
  -- credential than the one that was replaced — a reissue that somehow
  -- "resulted in" the same credential it expected to replace would
  -- indicate a logic error, not a legitimate outcome.
  constraint qr_lifecycle_operations_reissue_result_differs check (
    status <> 'consumed' or operation_type <> 'reissue'
    or resulting_credential_id is distinct from expected_current_credential_id
  ),

  -- Composite FKs proving both referenced credentials belong to THIS
  -- operation's application_id, not merely "some credential row."
  constraint qr_lifecycle_operations_expected_credential_fkey
    foreign key (expected_current_credential_id, application_id)
    references public.qr_credentials (id, application_id) on delete restrict,
  constraint qr_lifecycle_operations_resulting_credential_fkey
    foreign key (resulting_credential_id, application_id)
    references public.qr_credentials (id, application_id) on delete restrict,
  constraint qr_lifecycle_operations_terminal_related_credential_fkey
    foreign key (terminal_related_credential_id, application_id)
    references public.qr_credentials (id, application_id) on delete restrict
);

create index qr_lifecycle_operations_pending_expiry_idx on public.qr_lifecycle_operations (expires_at)
  where status = 'pending';

-- Point 7: a credential must never be recorded as the result of more than
-- one operation.
create unique index qr_lifecycle_operations_resulting_credential_unique_idx
  on public.qr_lifecycle_operations (resulting_credential_id) where resulting_credential_id is not null;

-- Sub-pass 2, third correction round: REPLACES the previous
-- requester-scoped qr_lifecycle_operations_one_pending_per_requester_idx
-- entirely (that index is REMOVED, not retained alongside this one — two
-- overlapping partial unique indexes on the same conceptual invariant
-- would be redundant and confusing to reason about together). The
-- previous requester-scoped version allowed two DIFFERENT accounts
-- (two different staff members, or a participant and a staff member) to
-- each hold their own concurrent pending operation for the SAME
-- application and operation_type — which is exactly the double-issuance/
-- double-reissue race this table exists to prevent; "requester" is not
-- part of the actual real-world invariant ("this application does not
-- need two people independently working the same lifecycle action at
-- once"). Domain-wide: (application_id, operation_type), no requester
-- column at all.
create unique index qr_lifecycle_operations_one_pending_per_domain_idx
  on public.qr_lifecycle_operations (application_id, operation_type)
  where status = 'pending';

-- Sub-pass 2: the actual request_key idempotency guarantee. Unscoped by
-- status (unlike the pending-only index above) — a request_key must
-- resolve to the SAME operation for that operation's entire lifetime,
-- including after it transitions to consumed/expired/cancelled, so a
-- lost-response retry arriving after finalization still finds the exact
-- row it needs for the already_finalized replay path. Scoped by
-- (requester, operation_type, request_key) rather than including
-- application_id: request_key is generated once per user ACTION, and the
-- application_id for a participant self-service call is itself derived
-- from the requester's own row, so including it would be redundant for
-- that channel and would incorrectly let the SAME staff-generated
-- request_key be reused across two different applications for the staff
-- channels, which must never happen — each confirmed action (one UUID,
-- generated once, before confirmation) targets exactly one application.
create unique index qr_lifecycle_operations_request_key_unique_idx
  on public.qr_lifecycle_operations (requested_by_auth_user_id, operation_type, request_key);

alter table public.qr_lifecycle_operations enable row level security;
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_lifecycle_operations from anon, authenticated;
```
`id` is `gen_random_uuid()` — cryptographically unguessable. Every reservation RPC (§5.1/§5.2,
next message) first checks for an existing unexpired pending operation matching
`qr_lifecycle_operations_one_pending_per_requester_idx`'s key and **returns that operation's id**
instead of attempting a second `insert` that the unique index would reject — this is a
pre-check, not error-handling: relying on catching the unique-violation exception would work
too, but an explicit `select ... where status='pending' and expires_at > now()` first is clearer
and avoids a round-trip through Postgres's exception machinery for what is an expected, common
case (a participant double-tapping "generate my QR").

**Point 9 — complete defensive trigger, in full, not merely described:**
```sql
create function public.qr_lifecycle_operations_enforce_lifecycle_trigger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'qr_lifecycle_operations rows are never deleted, only transitioned';
  end if;

  -- CORRECTED this round: the trigger previously fired only on UPDATE/
  -- DELETE, leaving INSERT completely unguarded — a service-role bug (or
  -- a future code path added carelessly) could insert a row directly in
  -- an already-'consumed'/'cancelled' shape, fabricating a finalized
  -- operation that never actually went through a finalizer. Every new
  -- row must begin in exactly the pending, all-terminal-fields-null
  -- shape; the table's own qr_lifecycle_operations_pending_is_consistent
  -- CHECK constraint independently enforces this too, but the trigger
  -- states it explicitly and self-documents the invariant at the point
  -- where a violation would first occur.
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'A newly inserted qr_lifecycle_operations row must have status = pending';
    end if;
    if new.finalized_at is not null or new.consumed_at is not null
       or new.resulting_credential_id is not null or new.terminal_reason_code is not null
       or new.finalization_fingerprint is not null or new.terminal_related_credential_id is not null
       or new.terminal_retry_after_at is not null
    then
      raise exception 'A newly inserted qr_lifecycle_operations row must have all terminal fields null';
    end if;
    return new;
  end if;

  -- Immutable identity/intent fields, forever, regardless of status:
  if new.id is distinct from old.id then raise exception 'id is immutable'; end if;
  if new.operation_type is distinct from old.operation_type then raise exception 'operation_type is immutable'; end if;
  if new.application_id is distinct from old.application_id then raise exception 'application_id is immutable'; end if;
  if new.requested_by_auth_user_id is distinct from old.requested_by_auth_user_id then
    raise exception 'requested_by_auth_user_id is immutable';
  end if;
  if new.channel is distinct from old.channel then raise exception 'channel is immutable'; end if;
  if new.bulk_batch_id is distinct from old.bulk_batch_id then raise exception 'bulk_batch_id is immutable'; end if;
  if new.request_key is distinct from old.request_key then raise exception 'request_key is immutable'; end if;
  if new.reason_code is distinct from old.reason_code then raise exception 'reason_code is immutable'; end if;
  if new.note is distinct from old.note then raise exception 'note is immutable'; end if;
  if new.expected_current_credential_id is distinct from old.expected_current_credential_id then
    raise exception 'expected_current_credential_id is immutable';
  end if;
  if new.created_at is distinct from old.created_at then raise exception 'created_at is immutable'; end if;
  if new.expires_at is distinct from old.expires_at then raise exception 'expires_at is immutable'; end if;

  -- requested_by_profile_id may only transition to null (ON DELETE SET
  -- NULL), same pattern as qr_credentials' actor columns (§1.5).
  if new.requested_by_profile_id is not null
     and new.requested_by_profile_id is distinct from old.requested_by_profile_id then
    raise exception 'requested_by_profile_id can never be (re)assigned by update, only cleared to null';
  end if;

  -- Status transition whitelist: pending -> {consumed, expired, cancelled} only.
  if old.status is distinct from new.status then
    if old.status <> 'pending' or new.status not in ('consumed', 'expired', 'cancelled') then
      raise exception 'Illegal operation status transition: % -> %', old.status, new.status;
    end if;
  end if;

  -- CORRECTED this round (strengthened): a single, unified, EXPLICIT
  -- immutability block covering every terminal state — 'consumed' AND
  -- 'expired'/'cancelled' alike — for all six terminal-shape fields
  -- (status, finalized_at, consumed_at, resulting_credential_id,
  -- terminal_reason_code, finalization_fingerprint,
  -- terminal_related_credential_id). The previous version checked these
  -- asymmetrically (consumed rows guarded all six; expired/cancelled rows
  -- only guarded finalized_at and terminal_reason_code, relying on the
  -- table's CHECK constraints alone for
  -- consumed_at/resulting_credential_id/finalization_fingerprint on those
  -- rows). The trigger is now the FIRST defensive layer, explicit and
  -- self-documenting; the table CHECK constraints (§1.7's
  -- qr_lifecycle_operations_consumed_is_consistent/expired_is_consistent/
  -- cancelled_is_consistent) remain the SECOND, independent layer —
  -- neither depends on the other alone.
  --
  -- CONTROL-FLOW NOTE (fourth correction round, requested for explicit
  -- review): this guard's condition is `old.status in ('consumed',
  -- 'expired', 'cancelled') AND new.status = old.status` — a conjunction,
  -- both halves required. On the legal `pending -> cancelled` transition
  -- itself (the transition that FIRST assigns
  -- terminal_related_credential_id, e.g. for
  -- 'active_credential_already_exists'), old.status is 'pending', which
  -- is NOT a member of ('consumed', 'expired', 'cancelled') — so the
  -- entire `if` is false and NONE of the raises inside this block
  -- (including the terminal_related_credential_id one) ever evaluate.
  -- This block only ever fires on a SAME-terminal-status update (e.g. a
  -- second UPDATE attempted against an already-'cancelled' row), which is
  -- exactly and only the case this immutability guard is meant to
  -- reject. The null-to-credential assignment during the initial
  -- pending -> cancelled(active_credential_already_exists) transition is
  -- therefore never blocked by this block — it is governed instead by the
  -- SEPARATE, transition-specific rules below (search
  -- "terminal_related_credential_id: NEVER set on expired"), which run
  -- unconditionally for every pending -> * transition regardless of this
  -- guard. The only field that additionally tolerates a null-to-non-null
  -- OR non-null-to-null change even on an already-terminal row is
  -- requested_by_profile_id (checked separately, above, for its own
  -- documented ON DELETE SET NULL reason) — terminal_related_credential_id
  -- has no equivalent exception once terminal, by design: a credential
  -- FK (§1.2's qr_credentials_enforce_lifecycle_trigger) never deletes
  -- rows, so there is no ON DELETE SET NULL path that could legitimately
  -- null it out after the fact, unlike requested_by_profile_id's FK to
  -- profiles (which does get deleted, e.g. account removal).
  if old.status in ('consumed', 'expired', 'cancelled') and new.status = old.status then
    if new.finalized_at is distinct from old.finalized_at then
      raise exception 'finalized_at is immutable once a terminal status is reached';
    end if;
    if new.consumed_at is distinct from old.consumed_at then
      raise exception 'consumed_at is immutable once a terminal status is reached';
    end if;
    if new.resulting_credential_id is distinct from old.resulting_credential_id then
      raise exception 'resulting_credential_id is immutable once a terminal status is reached';
    end if;
    if new.terminal_reason_code is distinct from old.terminal_reason_code then
      raise exception 'terminal_reason_code is immutable once a terminal status is reached';
    end if;
    if new.finalization_fingerprint is distinct from old.finalization_fingerprint then
      raise exception 'finalization_fingerprint is immutable once a terminal status is reached';
    end if;
    if new.terminal_related_credential_id is distinct from old.terminal_related_credential_id then
      raise exception 'terminal_related_credential_id is immutable once a terminal status is reached';
    end if;
    -- This round's addition: terminal_retry_after_at follows the exact
    -- same once-terminal-immutable discipline as every other terminal
    -- field above — assignable ONLY during the initial pending -> *
    -- transition (governed by the separate, transition-specific rules
    -- below), never mutable again once that transition has committed.
    if new.terminal_retry_after_at is distinct from old.terminal_retry_after_at then
      raise exception 'terminal_retry_after_at is immutable once a terminal status is reached';
    end if;
  end if;

  -- finalized_at: null while pending, non-null the instant status leaves
  -- pending. On pending -> consumed specifically, consumed_at and
  -- finalized_at must be set TOGETHER in the same update (checked here;
  -- the table's qr_lifecycle_operations_consumed_timestamps_match
  -- constraint additionally forces them to be the exact same value, not
  -- merely both non-null).
  if old.status = 'pending' and new.status <> 'pending' and new.finalized_at is null then
    raise exception 'finalized_at must be set in the same transition that leaves pending';
  end if;
  if old.status = 'pending' and new.status = 'consumed' and new.consumed_at is null then
    raise exception 'consumed_at must be set in the same transition from pending to consumed';
  end if;
  if old.status = 'pending' and new.status in ('expired', 'cancelled')
     and (new.consumed_at is not null or new.resulting_credential_id is not null) then
    raise exception 'consumed_at and resulting_credential_id must remain null when transitioning to expired or cancelled';
  end if;
  if old.status = 'pending' and new.status in ('expired', 'cancelled') and new.terminal_reason_code is null then
    raise exception 'terminal_reason_code must be set in the same transition to expired or cancelled';
  end if;
  -- Fourth correction round: mirrors qr_lifecycle_operations_expired_is_consistent/
  -- cancelled_is_consistent (§1.7) as a controlled TRIGGER error, not only
  -- a CHECK-constraint violation — 'expired' can only ever mean
  -- 'ttl_expired', and 'ttl_expired' can never label a 'cancelled' row.
  if old.status = 'pending' and new.status = 'expired' and new.terminal_reason_code is distinct from 'ttl_expired' then
    raise exception 'terminal_reason_code must be exactly ttl_expired when transitioning to expired';
  end if;
  if old.status = 'pending' and new.status = 'cancelled' and new.terminal_reason_code = 'ttl_expired' then
    raise exception 'terminal_reason_code must not be ttl_expired when transitioning to cancelled';
  end if;
  if old.status = 'pending' and new.status = 'consumed' and new.terminal_reason_code is not null then
    raise exception 'terminal_reason_code must remain null when transitioning to consumed';
  end if;
  if old.status = 'pending' and new.status = 'consumed' and new.finalization_fingerprint is null then
    raise exception 'finalization_fingerprint must be set in the same transition from pending to consumed';
  end if;
  if old.status = 'pending' and new.status in ('expired', 'cancelled') and new.finalization_fingerprint is not null then
    raise exception 'finalization_fingerprint must remain null when transitioning to expired or cancelled';
  end if;

  -- terminal_related_credential_id: NEVER set on expired (nothing was ever
  -- "the current credential" for a timed-out operation); on cancelled, set
  -- if AND ONLY IF the terminal_reason_code being recorded in this SAME
  -- transition is 'active_credential_already_exists' — every other
  -- cancellation reason has no associated credential.
  if old.status = 'pending' and new.status = 'expired' and new.terminal_related_credential_id is not null then
    raise exception 'terminal_related_credential_id must remain null when transitioning to expired';
  end if;
  if old.status = 'pending' and new.status = 'cancelled'
     and new.terminal_reason_code = 'active_credential_already_exists'
     and new.terminal_related_credential_id is null then
    raise exception 'terminal_related_credential_id must be set in the same transition to cancelled when terminal_reason_code is active_credential_already_exists';
  end if;
  if old.status = 'pending' and new.status = 'cancelled'
     and new.terminal_reason_code is distinct from 'active_credential_already_exists'
     and new.terminal_related_credential_id is not null then
    raise exception 'terminal_related_credential_id must remain null for any cancellation reason other than active_credential_already_exists';
  end if;

  -- terminal_retry_after_at: this round's addition, same if-and-only-if
  -- shape as terminal_related_credential_id immediately above, but keyed
  -- on the TWO policy-driven cancellation reasons instead of one. NEVER
  -- set on expired (a timed-out operation was never denied by a
  -- retry-boundary policy — its own TTL is the only "when can I retry"
  -- signal, already exposed via expires_at/finalized_at); on cancelled,
  -- set if AND ONLY IF terminal_reason_code being recorded in this SAME
  -- transition is 'reissue_cooldown_active' or 'reissue_rate_limit_exceeded'.
  if old.status = 'pending' and new.status = 'expired' and new.terminal_retry_after_at is not null then
    raise exception 'terminal_retry_after_at must remain null when transitioning to expired';
  end if;
  if old.status = 'pending' and new.status = 'cancelled'
     and new.terminal_reason_code in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded')
     and new.terminal_retry_after_at is null then
    raise exception 'terminal_retry_after_at must be set in the same transition to cancelled when terminal_reason_code is reissue_cooldown_active or reissue_rate_limit_exceeded';
  end if;
  if old.status = 'pending' and new.status = 'cancelled'
     and new.terminal_reason_code not in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded')
     and new.terminal_retry_after_at is not null then
    raise exception 'terminal_retry_after_at must remain null for any cancellation reason other than reissue_cooldown_active or reissue_rate_limit_exceeded';
  end if;

  return new;
end;
$$;

revoke all on function public.qr_lifecycle_operations_enforce_lifecycle_trigger() from public;

create trigger qr_lifecycle_operations_lifecycle_guard
  before insert or update or delete on public.qr_lifecycle_operations
  for each row execute function public.qr_lifecycle_operations_enforce_lifecycle_trigger();
```
Expiry and cancellation (the scheduled `expire_stale_qr_lifecycle_operations()` job, and any
future explicit-cancel path) must set `status`, `finalized_at`, and `terminal_reason_code` in the
same `update` statement — exactly the same discipline already established for
`scan_attempts.expires_at`-clearing in §1.3, applied here to the analogous new table.

### 1.7a Global lock order — deadlock avoidance (this round's correction, point 3)

**Bug identified this round:** the reservation RPCs locked `application` (via `for update`) and
then `credential` *before* calling `reserve_or_reuse_qr_lifecycle_operation`, which locks the
`qr_lifecycle_operations` row — i.e. reservation locked in the order **application → operation**.
The finalizers lock in the order **operation → application → credential → key-registry**. Two
sessions taking locks in opposite orders on overlapping rows is the textbook Postgres deadlock
setup: a reservation call holding the application-row lock and waiting on the operation-row lock,
while a finalizer call (for a *different*, already-consumed-and-retried operation on the *same*
application) holds the operation-row lock and waits on the application-row lock, deadlocks both;
Postgres's deadlock detector kills one of the two transactions with a `40P01` error after its
`deadlock_timeout`, which is a real, user-visible failure mode under concurrent staff bulk
issuance/reissue against the same small set of applications.

**Fix — one global lock order, used identically by every RPC in §5.1/§5.2, no exceptions:**
1. **Lifecycle operation** — locked/reused/expired via `reserve_or_reuse_qr_lifecycle_operation`
   (reservation) or `select ... for update` on `p_operation_id` (finalization). This is always
   first, because it is the cheapest, most contended, most short-lived lock, and because it is
   the row every other statement's authorization decision is ultimately anchored to.
2. **Application** — `select ... for update`. For reservation, the application id is first
   *derived* without a lock (participant: `select applicant_id ... ` no `for update`; staff: the
   caller supplies `p_application_id` directly), the operation lock is taken, and only then is
   the application row itself locked — so no session ever holds the application lock while
   waiting on the operation lock.
3. **Current active credential** — locked only where relevant (reissue reservation, reissue
   finalization); never locked before the application lock is held.
4. **Key-registry row**, `for share` — finalization only, always last, since it is the least
   contended (many concurrent finalizers can share-lock the same active key version) and has no
   downstream lock of its own to further order against.

This ordering is now identical on both the reservation and finalization side, closing the
deadlock window entirely: no two sessions following this document's RPCs can ever hold a lock at
position *N* while waiting on a lock at position *N-1* held by another session.

**Deadlock-sensitive concurrency case to cover in the Testing Strategy section:** two concurrent
staff `reissue` calls against the *same* application — one finalizing an already-reserved
operation, one reserving a brand-new operation after the first's `expected_current_credential_id`
has gone stale — must never deadlock regardless of interleaving, and the loser of the
application-row lock must observe a clean, ordinary wait (blocked until the winner commits/rolls
back), never a `40P01` deadlock error, under this document's lock order.

---

## 2. Function inventory — PostgREST-exposed vs. service-role-only

**Correction from the previous round, part 1:** `get_my_active_qr_credential` and
`get_qr_credential_for_badge_generation`, as originally specified, returned `token_ciphertext`
directly from a function granted `EXECUTE` to `authenticated` — meaning any authorized
participant or staff member could call it **directly from the browser via PostgREST**,
bypassing the intended server-only ciphertext boundary entirely. Fixed by splitting each into a
client-callable **safe authorization RPC** (locator/status only, no secrets) and a
**service-role-only secret-retrieval RPC**.

**Correction from the previous round, part 2 — a concrete mechanism, not two abstract
options.** The previous draft proposed the secret-retrieval function live in a `private` schema
"called by server-side Node using `service_role`," without confirming that combination is
actually reachable — it is not, as stated. A normal `@supabase/supabase-js` client — confirmed,
by inspecting `package.json` and every existing server action/RPC call site in this repo, to be
**the only way this codebase talks to its database anywhere** — always goes over PostgREST via
HTTP, regardless of which API key it authenticates with. PostgREST only routes requests into
schemas explicitly listed in its exposed-schema configuration (Supabase's `db-schemas` setting,
default `public`); a `service_role`-authenticated PostgREST request to a function in an unlisted
`private` schema still 404s, because PostgREST never builds a route for it at all — the
service-role key changes *authorization*, not *routing*. Reaching a truly unexposed schema would
require **Option A**: a dedicated direct-Postgres connection bypassing PostgREST entirely. This
codebase has no such dependency today (no `pg`, `postgres`, or similar driver in `package.json`)
— adding one would be a first-of-its-kind piece of infrastructure here, with its own new secret
(a raw connection string, separate from the existing Supabase URL/keys) and its own new
operational surface to secure.

**Decision: Option B.** The secret-retrieval function stays in the `public` schema — visible in
PostgREST's schema introspection, exactly as Option B's stated tradeoff describes — but
`EXECUTE` is revoked from `PUBLIC`, `anon`, and `authenticated`, and granted *exclusively* to
`service_role`. This matches how every other service-role-gated operation in this codebase
already works (`createServiceRoleClient()`, used throughout `src/lib/*/server-helpers.ts`),
requires no new infrastructure, and "discoverable but not executable by any browser-reachable
role" is an explicitly accepted tradeoff: a browser session — even one holding a valid
participant or staff JWT — authenticates to PostgREST as `authenticated`, never as
`service_role`; the service-role key itself is never sent to a browser anywhere in this
codebase's architecture.

**The same mechanism decision applies to the scheduled expiry job.** This codebase has no
existing `pg_cron` usage and no `supabase/functions/` (Edge Functions) directory today.
**Decision: `pg_cron`**, invoking the expiry function directly as a scheduled database job —
zero new Node deployment artifact, and its execution context is the Postgres
extension/superuser role, not any PostgREST-facing role, so it needs no
`authenticated`/`anon` grant either. Confirming `pg_cron` is actually available on the target
Supabase project tier is a verification step for the Migration Strategy section, not assumed
silently here.

| Function | Exposure | Callable by |
|---|---|---|
| `issue_qr_credential_transactional` | PostgREST RPC (`public` schema) | `authenticated` (self-service path re-checks ownership; staff path re-checks role) |
| `reissue_qr_credential_transactional` | PostgREST RPC (`public` schema) | `authenticated` (same dual-path pattern) |
| `revoke_qr_credential_transactional` | PostgREST RPC (`public` schema) | `authenticated` (staff-only, enforced inside) |
| `resolve_qr_token_for_scan` | PostgREST RPC (`public` schema) | `authenticated` (scanner-only, enforced inside) |
| `confirm_scan_attempt_transactional` | PostgREST RPC (`public` schema) | `authenticated` (scanner-only) |
| `cancel_scan_attempt_transactional` | PostgREST RPC (`public` schema) | `authenticated` (scanner-only) |
| `record_malformed_scan_attempt` | PostgREST RPC (`public` schema) | `authenticated` (scanner-only) |
| `get_my_active_qr_descriptor` | PostgREST RPC (`public` schema) — **safe, no secrets** | `authenticated` (participant-only, self-resolving, no parameters). Returns `credential_id`, `application_id`, `issued_at`, `status` only. |
| `authorize_qr_badge_generation` | PostgREST RPC (`public` schema) — **safe, no secrets** | `authenticated` (staff-only, enforced inside). Returns the same safe locator shape for the given application. |
| `get_active_qr_ciphertext_for_server` | PostgREST RPC (`public` schema), **`EXECUTE` granted only to `service_role`** — discoverable in schema introspection, not executable by any browser-reachable role | `service_role` only — server-side Node using `createServiceRoleClient()`, never a browser session |
| `expire_stale_pending_scan_attempts` | PostgREST-registered function (`public` schema), invoked exclusively via `pg_cron`'s own scheduling mechanism, not via any HTTP/PostgREST role | `pg_cron` scheduled job only |
| `is_application_eligible_for_admission` | **Internal helper**, `security definer`, `EXECUTE` revoked from `PUBLIC` and never granted to `authenticated`/`anon` | Called only from inside other `security definer` functions in this list |
| `perform_admission_decision` | **Internal helper** (refactor of `scan_attempt_transactional`'s existing body), same grant restriction as above | Called only from `scan_attempt_transactional` (existing, unchanged signature) and `confirm_scan_attempt_transactional` (new) |

Every client-callable, PostgREST-exposed function in this list gets:
```sql
revoke all on function <name>(<signature>) from public;
grant execute on function <name>(<signature>) to authenticated;
```
except the two service-role/cron-only functions, which instead get:
```sql
revoke all on function get_active_qr_ciphertext_for_server(uuid, uuid) from public;
grant execute on function get_active_qr_ciphertext_for_server(uuid, uuid) to service_role;

revoke all on function expire_stale_pending_scan_attempts() from public;
-- No grant to authenticated/anon/service_role at all — invoked solely
-- through pg_cron's scheduling mechanism, which does not authenticate as
-- any PostgREST-facing role.
```
`anon` never receives `EXECUTE` on anything in this document. Internal helpers get no grant to
`authenticated` or `anon` at all — only the `security definer` owner role can invoke them, and
only from within another `security definer` function's body in the same schema.

### 2.1 Explicit direct table-privilege revocation on `qr_credentials`

**Addition per this round's review:** RLS with zero policies (§1.2) makes `qr_credentials`
default-deny for `authenticated`/`anon` under RLS evaluation, but RLS and table-level `GRANT`s
are two independent layers — a role could in principle still hold a raw table grant that RLS
then filters to zero rows, which is a weaker, more confusing security posture than having no
grant at all. Explicit revocation closes that gap and makes the intended access model
unambiguous from the grants alone, without depending on RLS being correctly configured to do
all the work:

```sql
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_credentials from anon, authenticated;
```
`scan_attempts` is deliberately **not** included in this revocation — see the important
pre-existing-schema note in §2.2 below, since that table already has its own RLS policies
granting real direct access to `scanner_device`/`program_attendance_manager`/`super_admin`
today, predating this design.

**This does not mean `service_role`/table-owner access is "safe" by default — it means
lifecycle access is RPC-only for `authenticated`/`anon`, full stop.** `service_role` and the
table owner still bypass RLS entirely by Postgres's own design (RLS has no effect on a table's
owner or a role with the `BYPASSRLS` attribute, which `service_role` has in a standard Supabase
project) — no `REVOKE` statement changes that. What actually constrains `service_role`-level
access in this design is the combination of:
- **narrowly scoped server code** — every server-side call site in this codebase that could use
  `service_role` is itself gated by an explicit role/ownership check before it touches the
  database (the `requireXCaller()` pattern throughout `src/lib/*/server-helpers.ts`), so a
  `service_role` client is never handed to unauthenticated or unauthorized request handling in
  the first place;
- **the defensive trigger** (§1.5), which fires regardless of the executing role, including
  `service_role`/the table owner;
- **database constraints** (§1.2's `check` constraints, the unique indexes, the deferred FK),
  which likewise apply regardless of role;
- **audit logging** (§7), which records every legitimate lifecycle event so an anomalous write
  that somehow bypassed all of the above would still be visible as a gap in the audit trail
  relative to what the RPCs would have produced.

This is stated explicitly here because RLS alone — the previous round's implicit framing —
is not, and cannot be, a defense against `service_role`-level access; it was never claimed to
be, but the distinction is worth making unambiguous rather than leaving it implied.

### 2.2 Pre-existing `scan_attempts` RLS — a real gap this design does not close

**New finding from this round's repository-wide `scan_attempts` search (see §1.3's
finalization-compatibility sweep, done for point 5 below):** `scan_attempts` already has its
own RLS policies, predating this design, defined in
`supabase/migrations/20260804150000_attendance_rls_policies.sql`:
```sql
create policy scan_attempts_manager_all on scan_attempts
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

create policy scan_attempts_scanner_select on scan_attempts
  for select using (current_user_role() = 'scanner_device' and session_id in (...scanner_assignments...));

create policy scan_attempts_scanner_insert on scan_attempts
  for insert with check (
    current_user_role() = 'scanner_device' and scanned_by = auth.uid()
    and session_id in (...scanner_assignments...)
  );
```
This means, **unlike `qr_credentials`**, `scan_attempts` is not currently default-deny for
`authenticated` roles — a `scanner_device`-role user, or a `program_attendance_manager`/
`super_admin`, already has genuine direct table-level insert/select access today, independent
of any RPC in this document. Concretely: nothing in this design's RLS/grant model prevents a
`scanner_device` session from bypassing `resolve_qr_token_for_scan`/`confirm_scan_attempt_transactional`
entirely and inserting a hand-crafted `scan_attempts` row directly (subject to passing the
existing `scan_attempts_scanner_insert` policy's `session_id`/`scanned_by` checks, and — once
this design's migrations land — the new `scan_attempts_finalization_state_check` constraint).

This is a **real, pre-existing architectural property of this codebase**, not something
introduced by this design, and not something silently glossed over here. It is flagged as an
open item for the Migration Strategy / Permission-RLS-matrix sections to resolve explicitly —
options include tightening `scan_attempts_scanner_insert` to require going through the new
RPCs (e.g. by removing direct scanner insert capability once the RPC path exists, mirroring the
`qr_credentials` revocation in §2.1), or deliberately leaving it as a documented,
accepted-for-now gap if there's an existing reason `scanner_device` needs direct insert access
that this investigation hasn't surfaced. This draft does not assume an answer.

---

## 3. Actor derivation — the one rule applied everywhere

**No function in this document accepts a caller-supplied UUID and treats it as an
authenticated actor.** Every function independently derives identity from `auth.uid()` at the
top of its body, before any lock is taken or any row is read for authorization purposes:

```sql
-- Pattern A: participant ownership (issuance/reissue self-service paths)
if auth.uid() is null then raise exception 'Not authenticated'; end if;
if not exists (
  select 1 from applications where id = p_application_id and applicant_id = auth.uid()
) then
  raise exception 'Not authorized';
end if;
-- auth.uid() itself is the only trustworthy participant identity from here on.
```

```sql
-- Pattern B: staff role (issue/reissue-force/revoke/badge-generation paths)
declare v_caller profiles;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null then raise exception 'Not authorized'; end if;
  if v_caller.role not in ('super_admin', 'program_attendance_manager') then
    raise exception 'Not authorized';
  end if;
  -- v_caller.id (== auth.uid(), independently re-derived, never a parameter)
  -- is the only trustworthy staff actor identity from here on.
```

**Pattern C — corrected per this round.** The previous draft verified `scanner_assignments`
membership but never explicitly confirmed the caller's `profiles.role` is actually
`scanner_device` — a `program_attendance_manager` or `super_admin` who happened to also have a
row in `scanner_assignments` (not something this codebase's schema prevents) could otherwise
satisfy the old check. The corrected pattern adds the missing role assertion, resolves the
authoritative `scanner_assignment_id` from the database (not trusted from any parameter), and
demotes `p_device_identifier` to untrusted, non-identity display text:

```sql
-- Pattern C (corrected): scanner identity + role + assignment
declare
  v_caller profiles;
  v_session record;
  v_assignment scanner_assignments;
begin
  -- 1. Resolve the profile internally from auth.uid() — never trust a parameter.
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null then raise exception 'Not authorized'; end if;

  -- 2. Require role = 'scanner_device' explicitly — closes the gap where a
  --    staff role with an incidental scanner_assignments row could
  --    otherwise pass the assignment check below.
  if v_caller.role <> 'scanner_device' then
    raise exception 'Not authorized';
  end if;

  -- 3. Resolve the active scanner assignment internally (not supplied by
  --    the caller in any form) and 4. validate the requested session/room
  --    against it in the same query — one lookup does both.
  select id, room_id into v_session from sessions where id = p_session_id;
  if v_session.id is null then raise exception 'Session not found'; end if;

  select * into v_assignment from scanner_assignments
    where scanner_user_id = v_caller.id and is_active = true
      and (session_id = p_session_id or room_id = v_session.room_id)
    limit 1;
  if v_assignment.id is null then
    raise exception 'Not authorized for this session';
  end if;

  -- 5. v_caller.id and v_assignment.id are now the authoritative scanner
  --    identity and assignment for the rest of this function body — every
  --    downstream read/write/audit-actor-id uses these, never a parameter.
```

No function signature in this document includes `p_issued_by`, `p_staff_actor_id`,
`p_actor_kind`, or `p_scanned_by`. **`p_device_identifier` is removed entirely from every
scanner-facing RPC signature in this document** (`resolve_qr_token_for_scan`,
`confirm_scan_attempt_transactional`, `cancel_scan_attempt_transactional`,
`record_malformed_scan_attempt`, and the new `get_scan_attempt_status_for_caller` in §4.1) —
per the preference to remove it rather than retain it as untrusted text. If a future phase
needs a client-supplied display label (e.g. "Gate 3 iPad" shown on a staff dashboard), it must
be sourced from a trusted, database-resolved value — a `label` column on `scanner_assignments`
or a future dedicated scanner-device-registry table — never a bare client-supplied string, and
never used for authorization, assignment resolution, audit actor identity, or device uniqueness
under any circumstance.

---

## 4. Authorization matrix

| Role | `issue` | `reissue` (self) | `reissue` (force) | `revoke` | `resolve_qr_token_for_scan` | `confirm`/`cancel`/`malformed`/`get_scan_attempt_status_for_caller` | `get_my_active_qr_descriptor` | `authorize_qr_badge_generation` | `get_active_qr_ciphertext_for_server` |
|---|---|---|---|---|---|---|---|---|---|
| `participant` | ✅ own application only, no active credential exists, application `accepted` | ✅ own application, rate-limited (10 min cooldown, 3/24h) | ❌ | ❌ | ❌ | ❌ | ✅ own application only | ❌ | ❌ (never — see §4.4) |
| `super_admin` | ✅ any application, individual or bulk | ❌ (uses force path) | ✅ any application, bypasses rate limit | ✅ any application | ❌ | ❌ | ❌ (not their own credential to view) | ✅ any application | ❌ (never — see §4.4) |
| `program_attendance_manager` | ✅ any application, individual or bulk | ❌ | ✅ any application, bypasses rate limit | ✅ any application | ❌ | ❌ | ❌ | ✅ any application | ❌ (never — see §4.4) |
| `participants_communications_manager` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ (readiness/status view only — see §4.3, no ciphertext/hash ever reachable) | ❌ |
| `scanner_device` | ❌ | ❌ | ❌ | ❌ | ✅ within active assignment only | ✅ within active assignment only | ❌ | ❌ | ❌ |
| `service_role` (server-side only, never a browser session) | n/a — not a client role | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ✅ the only caller of this function at all |

Every ❌ for `participant`/`super_admin`/`program_attendance_manager`/
`participants_communications_manager`/`scanner_device` is enforced by the function body itself
(Pattern A/B/C, rejecting the caller's resolved role/ownership) for the `authenticated`-granted
RPCs. The **`get_active_qr_ciphertext_for_server`** column is different in kind: its ❌ for every
client role is enforced at the **grant level**, not the function body — per §2's decision,
`EXECUTE` on that function is never granted to `authenticated` at all. This double enforcement
(grant-level exclusion *and* the function's own internal data-integrity logic, detailed in
§4.4) is intentional defense in depth, not redundant.

### 4.1 Resolving `scan_attempts` — blocking item, corrected per this round

The prior draft's resolution had a real bug, identified in this round: **column-level
`GRANT`s apply to the Postgres role, not to a specific application role layered on top of it
by RLS.** `super_admin`, `program_attendance_manager`, `scanner_device`, and `participant` all
authenticate to PostgREST as the *same* Postgres role, `authenticated` — RLS policies filter
which *rows* each application role can see, but a table-level column grant restricts which
*columns* the entire `authenticated` Postgres role can ever select, regardless of which RLS
policy would otherwise apply to a given session. The previous draft's
`grant select (8 columns) on scan_attempts to authenticated` would therefore have **also**
blocked `program_attendance_manager`/`super_admin` from ever selecting `scanned_by`,
`resulting_attendance_id`, or `metadata` — even though `scan_attempts_manager_all`'s RLS
intends to give them full-row access. This is corrected below: **no column-level grant is used
anywhere in this design.** Scanner reads move entirely to a new RPC; manager reads stay a
full-row table policy (row-scoped only, not column-scoped).

**`scan_attempts_scanner_insert` — dropped, unchanged from the prior round's correction (still
correct):**
```sql
drop policy scan_attempts_scanner_insert on scan_attempts;
```
A `scanner_device` session has zero direct insert path — every write for that role goes through
`resolve_qr_token_for_scan`, `confirm_scan_attempt_transactional`,
`cancel_scan_attempt_transactional`, or `record_malformed_scan_attempt`.

**`scan_attempts_scanner_select` — dropped entirely, replaced by a new RPC, not narrowed via
column grant.**
```sql
drop policy scan_attempts_scanner_select on scan_attempts;
```
A `scanner_device` session has **no direct `select`** on `scan_attempts` at all after this
drop — not even a row-scoped one. Its only access to scan-attempt state is:
```sql
create function get_scan_attempt_status_for_caller(
  p_scan_attempt_id uuid
) returns table (
  scan_attempt_id uuid, application_id uuid, result text,
  finalized_at timestamptz, expires_at timestamptz, created_at timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller profiles;
  v_attempt scan_attempts;
  v_session record;
begin
  -- Pattern C in full: role-checked scanner identity, never a parameter.
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role <> 'scanner_device' then
    raise exception 'Not authorized';
  end if;

  select * into v_attempt from scan_attempts where id = p_scan_attempt_id;
  if v_attempt.id is null then raise exception 'Scan attempt not found'; end if;

  -- Verify the attempt belongs to the caller's own active assignment —
  -- both the session-direct and room-based assignment shapes, matching
  -- Pattern C exactly, so a scanner cannot query an attempt from a
  -- session/room outside their own assignment even if they happen to know
  -- its id.
  select id, room_id into v_session from sessions where id = v_attempt.session_id;
  if not exists (
    select 1 from scanner_assignments
    where scanner_user_id = v_caller.id and is_active = true
      and (session_id = v_attempt.session_id or room_id = v_session.room_id)
  ) then
    raise exception 'Not authorized for this scan attempt';
  end if;

  -- Safe fields only — no scanned_by (redundant with the caller's own
  -- identity anyway), no resulting_attendance_id (internal linkage), no
  -- metadata (may carry diagnostic detail not meant for on-screen display).
  return query select
    v_attempt.id, v_attempt.application_id, v_attempt.result,
    v_attempt.finalized_at, v_attempt.expires_at, v_attempt.created_at;
end;
$$;

revoke all on function get_scan_attempt_status_for_caller(uuid) from public;
grant execute on function get_scan_attempt_status_for_caller(uuid) to authenticated;
```
This is the scanner UI's sole read path — used, for example, to poll a pending attempt's status
or re-display a recent result — scoped to exactly one attempt at a time, verified against the
caller's own assignment on every call, never a table-wide read of any kind.

**`scan_attempts_manager_all` — replaced with a SELECT-only policy, per this round's
correction.** The prior draft retained the existing `for all` policy unmodified, reasoning that
narrowing it was future work. This round corrects that: the stated read/correction/audit
separation (§4.6) is not actually true while a `for all` policy exists, since it would let a
manager `insert`/`update`/`delete` directly, bypassing every audited RPC. This is now fixed
within Phase 6, not deferred:
```sql
drop policy scan_attempts_manager_all on scan_attempts;

create policy scan_attempts_manager_select on scan_attempts
  for select using (current_user_role() in ('program_attendance_manager', 'super_admin'));

revoke insert, update, delete, truncate, references, trigger on scan_attempts from authenticated;
```
After this change, `super_admin`/`program_attendance_manager` retain full-row **read** access
(needed for live operational dashboards/reporting), but **no direct table mutation of any
kind** — every correction, override, or QR-lifecycle change must go through
`correct_attendance_transactional`, `transfer_attendance_transactional`,
`scan_attempt_transactional` (override path, §4.5), or this design's `revoke`/`reissue(force)`
RPCs, all of which are transactional and audited. No exceptional maintenance operation
requiring direct `service_role`-level `scan_attempts` mutation outside these RPCs has been
identified for this phase; if one is discovered during implementation, it must be documented
explicitly as its own reviewed exception, not silently assumed to fall back to `service_role`
convenience access.

### 4.2 Participants — no direct `scan_attempts` access, confirmed

No RLS policy in this codebase, before or after this design's changes, grants `participant`
role any access to `scan_attempts` at all — confirmed by inspecting every policy in
`20260804150000_attendance_rls_policies.sql`. `tests/attendance/admission-management-live.test.ts:686-701`
already asserts this via a negative test.

### 4.3 `participants_communications_manager` — aggregate readiness only

This role has zero grants on `qr_credentials` (§2.1) and zero grants on `scan_attempts`
(absent from `scan_attempts_manager_select`'s role list, and
`get_scan_attempt_status_for_caller` is `scanner_device`-only). Its **only** access path is a
new, narrowly-scoped read RPC (full body deferred to Group 3), tentatively named
`get_qr_readiness_summary()`, returning only aggregate/per-application status
(`has_active_credential: boolean`, `issued_at: timestamptz | null`) — never `token_hash`,
`token_ciphertext`, `encryption_key_version`, raw scan results, or any `scan_attempts` row.

### 4.4 `get_active_qr_ciphertext_for_server` — verification against this round's five requirements

1. **`EXECUTE` revoked from `PUBLIC`, `anon`, and `authenticated`.** ✅ Per §2's grant block:
   `revoke all on function get_active_qr_ciphertext_for_server(uuid, uuid) from public;` then
   `grant execute ... to service_role` — `revoke all from public` in Postgres revokes from
   every role that inherits from `PUBLIC` (which includes `anon` and `authenticated` by
   default, since neither has `NOINHERIT` set on the implicit `PUBLIC` pseudo-role
   relationship), and no subsequent `grant` to either is ever issued.
2. **Performs no authorization based on browser-supplied actor identity.** ✅ This function's
   authorization is entirely grant-level (point 1) — it performs no `auth.uid()` check at all,
   because `service_role` requests to PostgREST do not carry a participant/staff JWT's
   `auth.uid()` claim in the way `authenticated`-role requests do (a service-role request
   authenticates as the service key itself, not as any individual user). The function instead
   takes `p_credential_id`/`p_application_id` and independently verifies (inside its own body,
   detailed in Group 3) that they refer to the same, currently-`active` row — this is a
   **data-integrity check**, not an actor-authorization check; actor authorization for *who
   gets to ask* for a given credential's ciphertext already happened one layer up, in
   `get_my_active_qr_descriptor`/`authorize_qr_badge_generation`, before the Node server ever
   calls this function.
3. **Returns only the minimum encrypted fields.** ✅ Per §5.9-equivalent (to be finalized in
   Group 3): `credential_id, application_id, token_version, encryption_key_version,
   token_ciphertext, issued_at` — exactly the fields Node's AAD-reconstruction and AES-GCM
   decryption need, nothing else (no `token_hash`, no lifecycle/audit metadata).
4. **Called only from server-side code.** ✅ By construction (point 1's grant restriction) —
   there is no code path by which a browser session could call it, since doing so would require
   authenticating to PostgREST as `service_role`, which requires the service-role key, which
   this codebase's architecture never transmits to a browser (confirmed in §2).
5. **Covered by a negative authenticated-role test.** New test requirement for this feature's
   test suite (specified fully in the eventual Testing Strategy section, flagged here so it
   isn't lost): a live-DB test asserting that an `authenticated`-role session (both a
   participant's own session and a staff session) calling
   `get_active_qr_ciphertext_for_server` via `.rpc(...)` receives a PostgREST-level
   authorization error (HTTP 401/403, surfaced as a Supabase client `error`, not a successful
   response) — mirroring the existing negative-test pattern already used in
   `tests/attendance/admission-management-live.test.ts:686-701` for the analogous
   `scan_attempts` insert-rejection case.

### 4.5 Legacy `scan_attempt_transactional` compatibility — corrected disposition

**Correction from the previous round: a grant restricting `EXECUTE` to `authenticated` is not
sufficient authorization on its own.** `authenticated` is shared by every application role —
participant, `participants_communications_manager`, `scanner_device`, and staff alike — so
granting to `authenticated` and stopping there would let a `scanner_device` session (or a
participant, or a communications manager) call this function directly, submitting an
`application_id` and completely bypassing revoked/replaced-credential detection, malformed/
unknown-token classification, eligibility, and the whole QR-resolution lifecycle. Routing the
*UI* differently, as the previous draft proposed, is not a security boundary — the database
must enforce it. This round adds an **internal role check inside the function body itself**,
identical in spirit to Pattern B, restricting it to `super_admin`/`program_attendance_manager`
only:

```sql
create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false
) returns scan_attempts as $$
declare
  v_caller profiles;
  -- ... existing declarations (v_lock_key, v_lock_acquired, v_retry_count, etc.) unchanged ...
begin
  -- NEW: role check added at the top of the function body, before any of
  -- the existing advisory-lock/admission logic runs. p_scanned_by and
  -- p_device_identifier are REMOVED from the signature (see below) —
  -- scanned_by is now always the internally-resolved v_caller.id, never a
  -- parameter, consistent with every other function in this document.
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin', 'program_attendance_manager') then
    raise exception 'Not authorized';
  end if;

  -- ... existing advisory-lock/admission logic, UNCHANGED, using
  -- v_caller.id everywhere the old p_scanned_by parameter was previously
  -- used (the insert into scan_attempts, the attendance_records.scanned_by
  -- column) ...
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke all on function scan_attempt_transactional(uuid, uuid, text, boolean) from public;
grant execute on function scan_attempt_transactional(uuid, uuid, text, boolean) to authenticated;
```
**This changes the function's signature** (removing `p_scanned_by uuid` and
`p_device_identifier text`, which drops the parameter count from 6 to 4) — a genuine, deliberate
break from "the existing RPC's signature is never touched" stated in the prior round's Group 1,
made necessary by this round's requirement that this function derive its own caller rather than
trust a parameter. `p_device_identifier` is dropped per §3's corrected Pattern C reasoning
(untrusted display text has no place as an authorization-adjacent parameter); if a display label
is needed for this function's callers in the future, it follows the same rule as §3: sourced
from a trusted database value, never a bare parameter. **`resolveAdmissionDecision`'s TS mirror
and the internal `perform_admission_decision` core (§5.8) are unaffected by this signature
change** — the role check and parameter removal are wrapper-level, entirely above the shared
decision core, so the actual admission logic never diverges.

**Disposition, addressing every required sub-question directly:**
- **May `super_admin`/`program_attendance_manager` use the legacy manual/override path?** Yes —
  this remains their tool for identifying a participant by some means other than a QR scan
  (e.g. manual staff lookup by name), using the existing `p_is_override_caller` parameter.
- **May `scanner_device` call it?** **No — explicitly rejected by the new role check above.** A
  `scanner_device` session attempting to call `scan_attempt_transactional` directly now receives
  `'Not authorized'` from inside the function body, not merely a UI that happens not to expose
  the call.
- **May `participant`/`participants_communications_manager` call it?** No — same rejection, same
  role check.
- **Do camera scans and manually typed QR payloads always use the new resolution lifecycle?**
  Yes, unconditionally: `resolve_qr_token_for_scan` → `confirm_scan_attempt_transactional`,
  for both camera-scanned and manually-typed-token input (per the approved token-format
  decision's manual-entry fallback) — `scan_attempt_transactional` is now structurally
  unreachable by the `scanner_device` role for *any* input method, QR or otherwise.
- **What if scanner operators need a no-QR recovery workflow in the future?** Explicitly **not**
  designed in Phase 6. If RCOY MENA later wants scanner operators to identify participants
  without a QR (e.g. a lost-phone-and-no-printed-copy edge case at the door), that must be a
  **separate, newly-designed, separately-permissioned recovery workflow** — with its own
  explicit operational-reason capture, its own manager-approval-or-dedicated-capability gate,
  its own full audit trail, and an explicit guarantee that it cannot silently admit a holder of
  a revoked/replaced credential. This is not a variant of `scan_attempt_transactional` with a
  loosened role check — it is out of scope for this phase entirely, flagged here so it is not
  mistaken for something this design already provides.

Both functions continue to share `perform_admission_decision` (§5.8) as their one decision core.

### 4.6 `program_attendance_manager`/`super_admin` — read/correction/audit separation, corrected

Corrected per this round — the read/correction/audit separation below is now **actually true**,
since §4.1 replaced the `for all` policy with a `select`-only one and revoked direct mutation.

**Also corrected this round:** the "Correction/override actions" row previously named
`revoke_qr_credential_transactional`/`reissue_qr_credential_transactional` with a
`p_is_staff_force = true` parameter — a single-RPC-with-a-force-flag shape from an early design
round that the reservation/finalizer split (§5.1/§5.2) has since superseded entirely. No function
with that name or that parameter exists anywhere in this document. The row below is updated to
name the actual current functions:

| Access category | Mechanism | Scope |
|---|---|---|
| **Operational read access** | `scan_attempts_manager_select` (new, `select`-only RLS) | Full-row **read only** of every `scan_attempts` row — used for live operational dashboards/reporting |
| **Correction/override actions** | `correct_attendance_transactional`, `transfer_attendance_transactional` (existing, unchanged) + `scan_attempt_transactional` with the new internal role check (§4.5) + this design's staff issuance/reissue path: `request_staff_qr_issuance_transactional`/`request_staff_qr_reissue_transactional` (reservation, `authenticated`, staff-role-gated) followed by `finalize_qr_issuance_for_server`/`finalize_qr_reissue_for_server` (finalization, `service_role`-only) — see §5.1/§5.2 for the full two-step shape | All transactional, all audited — **direct table mutation is no longer possible for this role at all**, per §4.1's `revoke insert, update, delete, truncate, references, trigger on scan_attempts from authenticated`, and per §2.1's identical revocation on `qr_credentials`/`qr_lifecycle_operations`/`qr_bulk_operation_batches` |
| **Audit visibility** | `audit_logs` table (existing staff-only `select` policy, unchanged) + the new `qr_credential`/`qr_encryption_key`/`qr_bulk_operation_batch`-`entity_type` rows this design adds (§7) | Read-only historical record of actions taken, distinct from "operational read access" (live state) |

### 4.6a Obsolete-overload migration — discover, revoke, drop, and prove unreachable

**Corrected this round:** the previous draft's `DROP FUNCTION` statements guessed at a small,
fixed set of signatures — a real risk, since this design has iterated through several rounds
before arriving at the reservation/finalizer split, and any migration environment where an
earlier draft's functions were actually applied could have signatures this document never
enumerated (different parameter counts/types/order across drafts). Guessed `DROP FUNCTION`
statements silently leave any signature they didn't guess correctly still present and reachable.
Fixed with a `DO` block that discovers every actual overload from `pg_proc` by name — not by
assumed signature — and revokes + drops all of them, for every obsolete name across issuance,
reissue, revocation, token-lifecycle, and the legacy manual-scan surface:

```sql
do $$
declare
  v_obsolete_names text[] := array[
    -- Obsolete credential-lifecycle names from earlier drafts of this design:
    'issue_qr_credential_transactional',
    'reissue_qr_credential_transactional',
    'revoke_qr_credential_transactional',
    'get_my_active_qr_credential',              -- pre-split descriptor RPC, superseded by
                                                  -- get_my_active_qr_descriptor (§5.9)
    'get_qr_credential_for_badge_generation',    -- pre-split RPC, superseded by
                                                  -- authorize_qr_badge_generation (§5.10)
    -- Legacy manual-scan-lookup names, if any earlier draft introduced a
    -- bespoke "look up by typed application id" path before the
    -- resolve_qr_token_for_scan design was finalized (§5.4/§4.5):
    'lookup_application_for_manual_scan',
    'manual_scan_lookup_transactional'
  ];
  v_name text;
  v_sig record;
begin
  foreach v_name in array v_obsolete_names loop
    for v_sig in
      select p.oid, pg_get_function_identity_arguments(p.oid) as identity_args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
    loop
      execute format(
        'revoke all on function public.%I(%s) from public, authenticated, anon, service_role',
        v_name, v_sig.identity_args
      );
      execute format('drop function public.%I(%s)', v_name, v_sig.identity_args);
    end loop;
  end loop;
end;
$$;
```
This discovers and removes **every** overload of every listed name, regardless of how many
distinct signatures a given name accumulated across drafts — it does not depend on this document
correctly guessing parameter lists. The `revoke` immediately before each `drop` is a defensive
no-op in the common case (`drop function` already implies the grants disappear with the function)
but makes the ordering explicit and self-documenting in case any of this codebase's tooling
inspects grant state independently of function existence.

**Verification, required before this migration is considered complete (Migration Strategy
section, cross-referenced here since it is a direct consequence of this round's correction):**
1. Re-run the discovery query (the `select ... from pg_proc ... where p.proname = v_name` inner
   loop above, standalone) for every name in `v_obsolete_names` — must return zero rows for every
   name after this migration runs.
2. As an `authenticated`-role test session (participant and staff fixtures both), attempt to call
   each obsolete name via PostgREST — every call must fail with PostgREST's "function not found"
   error (404/`PGRST202`), never a permission error (which would imply the function still exists
   but is merely ungranted) and never a successful call.
3. As a `scanner_device`-role test session, attempt the same calls — identical expectation:
   function-not-found, not a permission denial.
4. Confirm via `\df public.*qr*` (or the equivalent `information_schema.routines` query) that the
   only remaining functions matching a `qr`-related naming pattern are the ones actually defined
   in this document: the eleven functions in §5.1/§5.2
   (`compute_qr_finalization_fingerprint`, `reserve_or_reuse_qr_lifecycle_operation`,
   `request_my_qr_issuance_transactional`, `request_staff_qr_issuance_transactional`,
   `finalize_qr_issuance_for_server`, `request_my_qr_reissue_transactional`,
   `request_staff_qr_reissue_transactional`, `finalize_qr_reissue_for_server`), the four
   `qr_bulk_operation_batches` functions (§1.6a), the two `qr_encryption_key_registry` functions
   (§1.6), and the remaining functions defined in §5.3 onward once those sections are approved.

Unlike the previous round, this separation is now enforced by the database's grants, not merely
described in prose: a `program_attendance_manager`/`super_admin` session attempting a direct
`insert`/`update`/`delete` on `scan_attempts` fails at the privilege level before RLS is even
evaluated, regardless of what the (now-nonexistent) `for all` policy might once have allowed.

### 4.7 Migration sequencing and regression-test requirements — expanded per this round

**Correction:** the previous round's claim that the new RPCs carry "no regression risk by
construction" is withdrawn — new RPCs that are supposed to be unreachable by certain roles
*are* a regression risk if that unreachability isn't actually tested, not merely asserted in
prose. The sequence below is expanded with the eleven required tests, each mapped to the
migration step it belongs with:

1. **Add `finalized_at`/`expires_at` columns and backfill** (§1.3 Steps 1–2) — additive, no
   policy change, existing tests pass unmodified.
2. **Update `scan_attempt_transactional`'s insert to set `finalized_at`** (§1.3 Step 3) — run
   the full existing `tests/attendance/*.test.ts` suite unmodified.
3. **Add `scan_attempts_finalization_state_check` and the new `result` values** (§1.3 Step 4) —
   the required test-fixture fix lands in the same commit/PR.
4. **Add the internal role check + signature change to `scan_attempt_transactional`, and its
   explicit grant/revoke** (§4.5) — run `scan-attempt-live.test.ts` and
   `scan-attempt-concurrency-live.test.ts` in full (these exercise this RPC end-to-end via the
   `scanAttemptConfirm` wrapper, which already only ever calls it as `super_admin`/
   `program_attendance_manager` in today's non-QR flows, so no behavior change is expected for
   the app's actual callers — the tests confirm this). **New required tests, added at this
   step:**
   - `scanner_device` cannot invoke `scan_attempt_transactional` (asserts the new role check).
   - Manual QR text entry (the approved manual-fallback path) uses token resolution
     (`resolve_qr_token_for_scan`), never direct `application_id` admission via
     `scan_attempt_transactional` — an integration-level assertion that the manual-entry UI
     path is wired to the correct RPC.
5. **Drop `scan_attempts_scanner_insert`** (§4.1) — **new required tests:**
   - `scanner_device` cannot directly `insert` into `scan_attempts` (row rejected).
   - Scanner assignment mismatch is rejected — a `scanner_device` session with a *different,
     unrelated* active assignment cannot insert/select/act on a session/room outside that
     assignment (exercises Pattern C's assignment-validation branch specifically, not just "no
     assignment at all").
   - A non-`scanner_device` profile that happens to hold a `scanner_assignments` row is still
     rejected by every scanner-facing RPC (exercises Pattern C's new explicit role check, §3 —
     the exact gap this round's correction closed).
6. **Drop `scan_attempts_scanner_select`, add `get_scan_attempt_status_for_caller`** (§4.1) —
   **new required tests:**
   - `scanner_device` cannot directly `select` from `scan_attempts` at all (table-level
     rejection, not merely a narrowed column set).
   - `scanner_device` *can* retrieve its own attempt's safe status via
     `get_scan_attempt_status_for_caller`, scoped to its own assignment.
   - `scanner_device` cannot invoke `get_scan_attempt_status_for_caller` for an attempt
     belonging to a session/room outside its assignment.
7. **Replace `scan_attempts_manager_all` with `scan_attempts_manager_select` + revoke direct
   mutation** (§4.1) — **new required tests:**
   - `program_attendance_manager`/`super_admin` retain full-row `select` (operational read
     access unaffected).
   - `program_attendance_manager`/`super_admin` **cannot** directly `insert`/`update`/`delete`
     on `scan_attempts` (the actual behavior change this step introduces — must be proven, not
     assumed).
8. **Add `qr_credentials`, its trigger, indexes, and table-privilege revocation** (§1.2, 1.5,
   2.1) — new table; additive tests only.
9. **Add the full RPC set** (§5, finalized in Group 3), **with the following explicitly required
   tests, not assumed safe by construction:**
   - `participant` cannot invoke any scanner-facing RPC (`resolve_qr_token_for_scan`,
     `confirm_scan_attempt_transactional`, `cancel_scan_attempt_transactional`,
     `record_malformed_scan_attempt`, `get_scan_attempt_status_for_caller`).
   - `participants_communications_manager` cannot invoke any scanner-facing RPC **or** any
     credential-lifecycle RPC (`issue`/`reissue`/`revoke`/the two ciphertext-adjacent safe RPCs).
   - `authenticated` users (both a participant's own session and a staff session) cannot invoke
     `get_active_qr_ciphertext_for_server` (§4.4's negative test, restated here as part of the
     complete required list, not a separate untracked item).
   - The `service_role` server-side path retrieves **only** the allow-listed encrypted fields
     from `get_active_qr_ciphertext_for_server` (`credential_id, application_id, token_version,
     encryption_key_version, token_ciphertext, issued_at`) — a positive test asserting the
     response shape contains exactly these fields and nothing else (e.g. no `token_hash` leaks
     through an accidental `select *`).

Steps 1–3 are low-risk and additive. Steps 4–7 each introduce a genuine behavior change to
existing, currently-working access and each carry a hard-required regression test before that
step is mergeable — none of the four are optional hardening for a later phase. Step 9's eleven
listed tests are the minimum bar for the new RPC surface; the full Testing Strategy section
(later in this design) will organize them into concrete test files/suites.

### 4.8 Final direct table-privilege summary, by role

Explicit final state, per this round's requirement 5 — every row below is what actually holds
after all migrations in §4.7 land, not an intermediate or aspirational state:

| Role | `qr_credentials` direct access | `scan_attempts` direct access |
|---|---|---|
| `scanner_device` | None — no `select`/`insert`/`update`/`delete` (§2.1's blanket revocation covers `authenticated`, which includes this role) | **None at all** — no `select` (dropped, §4.1), no `insert` (dropped, §4.1), no `update`/`delete` (never granted). Workflow entirely through `resolve_qr_token_for_scan`, `confirm_scan_attempt_transactional`, `cancel_scan_attempt_transactional`, `record_malformed_scan_attempt`, `get_scan_attempt_status_for_caller` — all narrowly scoped `security definer` RPCs |
| `participant` | None (§2.1) | None — no policy has ever granted this role any access (§4.2) |
| `participants_communications_manager` | None (§2.1) | None — absent from `scan_attempts_manager_select`'s role list. Readiness only via `get_qr_readiness_summary()` (§4.3), an aggregate-only RPC |
| `super_admin` / `program_attendance_manager` | None direct on `qr_credentials` — same blanket revocation as every other `authenticated` role (§2.1); all interaction via the reservation RPCs (`request_staff_qr_issuance_transactional`/`request_staff_qr_reissue_transactional`, §5.1/§5.2), `revoke_qr_credential_transactional` (§5.3), and `authorize_qr_badge_generation` (§5.10) | **Direct `select` only**, via `scan_attempts_manager_select` (§4.1) — full-row read access retained for operational dashboards/reporting. **No direct `insert`/`update`/`delete`** (revoked, §4.1) — every mutation goes through `correct_attendance_transactional`, `transfer_attendance_transactional`, `scan_attempt_transactional` (role-checked, §4.5), or this design's staff reservation RPCs |
| `service_role` (server-side Node only) | Bypasses RLS/grants by Postgres design (table owner/`BYPASSRLS`); constrained instead by narrowly-scoped server code, the defensive trigger, constraints, and audit logging (§2.1) — never by table privileges alone | Same |

Because every application role shares the single Postgres `authenticated` role via PostgREST
(the reason column-level grants were rejected in §4.1), **every row-and-column-specific
distinction in this table is implemented through RLS policies (row scope) and `security
definer` RPCs (both row scope and field selection) — never through table-level column grants**,
which cannot differentiate between application roles sharing one Postgres role.

---

## 5. Public RPC signatures, bodies, and transaction/lock ordering — final, consolidated

Every function below reflects every correction from Groups 1–2: reason-code conditional
validation (§1.4), no caller-supplied actor parameters anywhere (§3), `p_device_identifier`
removed from every scanner-facing signature (§3), the corrected credential-descriptor/
ciphertext-retrieval split (§2, §4.4), `get_scan_attempt_status_for_caller` (§4.1), the
finalizing `expires_at = null` requirement (§1.3), and the retired/replaced legacy
`scan_attempt_transactional` (§4.5, §5.11 below).

### 5.0a `compute_qr_finalization_fingerprint` — canonical binary fingerprint, shared helper

**Correction, this round (second pass):** three fixes to the previous version of this helper.
(1) `uuid_send` is a `pg_catalog` builtin (part of core Postgres's uuid type support), not a
`pgcrypto` function — it was incorrectly schema-qualified as `extensions.uuid_send`, which would
fail to resolve since no such function exists in the `extensions` schema. Corrected to
`pg_catalog.uuid_send`. `digest` genuinely is a `pgcrypto` function and correctly remains
`extensions.digest`. (2) `token_version`/`encryption_key_version` were being packed into 2 bytes
by truncating an `int4send(...)` result via `substring`, and validated against an incorrect range
(`0–65535`, the `uint16` range) — but both parameters are declared `smallint` (Postgres's signed
16-bit integer type), and `qr_credentials`'s own check constraints (§1.2) already restrict both
to `1–32767`. Corrected to use `pg_catalog.int2send(...)` directly (the native, no-truncation
2-byte big-endian encoding for a `smallint`) and to validate against `1–32767`, consistent with
the actual Postgres type and the table's own constraints. (3) the domain separator is now also
explicitly length-prefixed, for the same reason `operation_type` is — the canonical encoding
should not depend on any field having an implicitly-fixed width by convention alone; every field
whose width is not intrinsically fixed by its Postgres type is prefixed.

```sql
create function public.compute_qr_finalization_fingerprint(
  p_operation_type text,
  p_credential_id uuid,
  p_token_hash bytea,
  p_token_version smallint,
  p_encryption_key_version smallint,
  p_token_ciphertext bytea
) returns bytea
language plpgsql as $$
declare
  v_domain bytea := pg_catalog.convert_to('rcoy:qr-finalization:v1', 'UTF8');
  v_op_type bytea := pg_catalog.convert_to(p_operation_type, 'UTF8');
  v_canonical bytea;
begin
  if p_operation_type not in ('issue', 'reissue') then
    raise exception 'Invalid operation type for fingerprint computation';
  end if;
  if p_credential_id is null then raise exception 'Credential id is required for fingerprint computation'; end if;
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'Token hash must be exactly 32 bytes for fingerprint computation';
  end if;
  if p_token_version is null or p_token_version not between 1 and 32767 then
    raise exception 'Invalid token version for fingerprint computation';
  end if;
  if p_encryption_key_version is null or p_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid encryption key version for fingerprint computation';
  end if;
  if p_token_ciphertext is null then raise exception 'Ciphertext envelope is required for fingerprint computation'; end if;

  -- Canonical binary layout, concatenated in this exact fixed order. Every
  -- field is either intrinsically fixed-width by its Postgres type
  -- (uuid_send: always 16 bytes; a 32-byte hash/digest; int2send: always
  -- 2 bytes for a smallint) or explicitly length-prefixed (domain
  -- separator, operation_type) — no field's width is assumed by
  -- convention alone:
  --   [4-byte big-endian length prefix][domain separator UTF-8 bytes, "rcoy:qr-finalization:v1"]
  --   [4-byte big-endian length prefix][operation_type UTF-8 bytes, "issue" | "reissue"]
  --   [16 bytes: credential UUID, RFC 4122 binary form via pg_catalog.uuid_send]
  --   [32 bytes: raw token hash, fixed-width by construction, no prefix needed]
  --   [2 bytes: token_version, native smallint big-endian encoding via pg_catalog.int2send]
  --   [2 bytes: encryption_key_version, same]
  --   [32 bytes: SHA-256 digest of the ciphertext envelope — the envelope
  --    itself is variable-length (61 bytes for v1, per the token format,
  --    but not assumed fixed here), so its DIGEST (always exactly 32
  --    bytes) is embedded directly rather than the envelope itself,
  --    avoiding a second length prefix while still binding the
  --    fingerprint to the ciphertext's exact content]
  v_canonical :=
    pg_catalog.int4send(octet_length(v_domain)) || v_domain
    || pg_catalog.int4send(octet_length(v_op_type)) || v_op_type
    || pg_catalog.uuid_send(p_credential_id)
    || p_token_hash
    || pg_catalog.int2send(p_token_version)
    || pg_catalog.int2send(p_encryption_key_version)
    || extensions.digest(p_token_ciphertext, 'sha256');

  return extensions.digest(v_canonical, 'sha256');
end;
$$;

revoke all on function public.compute_qr_finalization_fingerprint(
  text, uuid, bytea, smallint, smallint, bytea
) from public;
-- No grant to authenticated/anon/service_role directly — called only from
-- within the two finalizers' own security-definer bodies. Deliberately
-- NOT security definer itself (plain plpgsql, no elevated privilege
-- needed — it touches no table, only computes a value from its inputs),
-- so it inherits the CALLING function's search_path rather than needing
-- its own; still schema-qualifies extensions.digest and every built-in
-- binary-encoding call (pg_catalog.convert_to, pg_catalog.int4send,
-- pg_catalog.uuid_send, pg_catalog.int2send) explicitly regardless, since
-- the caller's search_path is not assumed. pg_catalog is always
-- implicitly first in every session's effective search_path regardless
-- of the explicit search_path setting (Postgres always consults
-- pg_catalog first, documented behavior, not a repo-specific convention)
-- — the pg_catalog.-qualification here is for self-documentation/
-- consistency with this function's explicit-qualification policy, not
-- because an unqualified pg_catalog call could actually fail to resolve.

### 5.1 Issuance — `request_my_qr_issuance_transactional` / `request_staff_qr_issuance_transactional` / `finalize_qr_issuance_for_server`

**Full redesign per this round's critical correction.** No `authenticated`-granted function
anywhere in this document accepts `token_hash`, `token_ciphertext`, `token_version`, or
`encryption_key_version` from a client session, full stop. A participant or staff browser
session can never submit cryptographic credential material — the reason this matters concretely:
without the external AES-256-GCM key (which deliberately never enters the database trust
boundary, per the earlier encryption-approach decision), **PostgreSQL cannot verify that a
supplied ciphertext is genuine** — it can check length and a format byte, but not the GCM
authentication tag, which requires the key. A client-supplied `token_hash`/`token_ciphertext`
pair could therefore be arbitrary bytes that happen to satisfy length/version checks, creating an
`active` credential that resolves during scanning but can never be decrypted for redisplay —
a participant-controlled credential masquerading as a server-issued one. The fix is structural,
not a stronger validation check: **split the operation into a client-authenticated reservation
step (records intent, no crypto material) and a service-role-only finalization step (performs
the actual write, using crypto material Node generates only after the reservation succeeds)**.

```sql
create type public.qr_credential_lifecycle_result as (
  outcome                text,     -- see §8 for the full vocabulary
  credential_id           uuid,
  status                  text,
  issued_at                timestamptz,
  replaced_at              timestamptz,
  revoked_at               timestamptz,
  retry_after_seconds      integer,
  operation_id             uuid
);

-- Shared helper (called from all four reservation RPCs, §5.1 and §5.2).
--
-- SUB-PASS 2, THIRD CORRECTION ROUND — three further defects fixed on top
-- of the second round's five:
--
-- (A) Domain scope was still requester-scoped. The advisory lock and the
-- "another pending operation" lookup both included
-- requested_by_auth_user_id — which meant two DIFFERENT accounts (two
-- staff members, or a participant and a staff member) each got their OWN
-- serialization domain and could each hold a concurrent pending operation
-- for the SAME application/operation_type — exactly the double-issuance
-- race this table exists to prevent. The advisory lock is now keyed on
-- (application_id, operation_type) ONLY — no requester component at all —
-- and qr_lifecycle_operations_one_pending_per_domain_idx (§1.7, replacing
-- the old per-requester index) enforces the same domain-wide scope as a
-- durable constraint, not merely an advisory convention. request_key
-- uniqueness remains SEPARATELY scoped by requester
-- (qr_lifecycle_operations_request_key_unique_idx), since two different
-- accounts coincidentally generating the same UUID must never collide
-- with each other's rows.
--
-- (B) The "other pending" candidate was found but never locked, never
-- TTL-checked, and the function decided its final effect immediately —
-- an unlocked read could race a concurrent finalizer, and an expired
-- "other" candidate would have wrongly blocked a legitimate new request
-- forever. This function now takes FOR UPDATE on whichever candidate row
-- it finds (by request_key OR the domain-wide other-pending lookup) and
-- returns it to the caller UNRESOLVED as to final TTL disposition for the
-- pending case — 'matching_pending_candidate' or
-- 'other_pending_candidate' — so the CALLER can perform the authoritative
-- TTL recheck only after acquiring every remaining required lock (bulk
-- batch, application, current credential), per correction (C). The lock
-- taken here is held for the remainder of the caller's own transaction.
--
-- (C) TTL is no longer resolved to finality inside this function for the
-- pending case (the second round's claim that "TTL is fully resolved
-- inside reserve_or_reuse before the application lock" was WRONG and is
-- retracted) — it is only checked here far enough to decide whether the
-- candidate is even a plausible match (still needed to route
-- consumed/expired/cancelled replay immediately, since those never
-- depend on any lock this function doesn't already hold). For a PENDING
-- candidate specifically, this function returns it locked and unresolved;
-- the caller RPC re-derives clock_timestamp() and makes the authoritative
-- expiry decision only after the application (and, for reissue, current
-- credential) locks are held — see §5.0b's restated lock order and each
-- caller RPC's own final TTL recheck.
-- SUB-PASS 2, FIFTH CORRECTION ROUND:
--
-- (F) A SECOND advisory lock is now taken FIRST, before the domain lock —
-- keyed on (requester_auth_user_id, operation_type, request_key). Without
-- it, the SAME staff account submitting the SAME request_key for TWO
-- DIFFERENT applications concurrently (application A in one call,
-- application B in another, both in flight at once) acquires two
-- DIFFERENT domain locks (one per application) — neither call serializes
-- against the other at all, both reach the by-key lookup, both find no
-- row, and one of them fails downstream with a raw
-- qr_lifecycle_operations_request_key_unique_idx violation instead of the
-- controlled request_key_intent_conflict outcome. The request-key
-- advisory lock closes this: the second call blocks until the first
-- commits, then finds the first's row under that SAME key, compares full
-- intent (application_id included), and correctly reports
-- request_key_intent_conflict (the application_id differs, so intent
-- cannot match) rather than ever reaching the unique index.
--
-- Fixed global lock order, every reservation RPC, no exceptions: (1)
-- request-key advisory lock (requester, type, request_key) (2)
-- reservation-domain advisory lock (application_id, type) (3) lifecycle
-- operation row (4) bulk batch, where applicable (5) application (6)
-- current credential, where applicable.
create function public.reserve_or_reuse_qr_lifecycle_operation(
  p_operation_type text,
  p_application_id uuid,
  p_requester_auth_user_id uuid,
  p_request_key uuid,
  p_channel text,
  p_bulk_batch_id uuid,
  p_reason_code text,
  p_note text,
  p_expected_current_credential_id uuid,
  out op public.qr_lifecycle_operations,
  out state text
  -- 'no_existing_operation' | 'matching_pending_candidate'
  -- | 'other_pending_candidate' | 'already_consumed' | 'replay_expired'
  -- | 'replay_cancelled' | 'request_key_intent_conflict'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_by_key public.qr_lifecycle_operations;
  v_other_pending public.qr_lifecycle_operations;
  v_intent_matches boolean;
begin
  if p_request_key is null then
    raise exception 'request_key is required';
  end if;

  -- Position 1: request-key advisory lock — serializes concurrent reuse
  -- of the SAME request_key by the SAME requester, regardless of which
  -- application_id each concurrent call is targeting (correction F).
  perform pg_advisory_xact_lock(
    hashtextextended(p_requester_auth_user_id::text || ':' || p_operation_type || ':' || p_request_key::text, 0)
  );

  -- Position 2: reservation-domain advisory lock — (application_id,
  -- operation_type) ONLY, no requester component. Serializes EVERY
  -- concurrent reservation attempt for this exact application/action
  -- against every other, regardless of WHO is requesting it or which
  -- request_key they present.
  perform pg_advisory_xact_lock(
    hashtextextended(p_application_id::text || ':' || p_operation_type, 0)
  );

  -- Position 3: the lifecycle operation row, by (requester, type,
  -- request_key) — request_key uniqueness remains requester-scoped even
  -- though the advisory lock above is not, per correction (A)'s note that
  -- these are two independent scopes for two independent invariants.
  select * into v_by_key from public.qr_lifecycle_operations
    where requested_by_auth_user_id = p_requester_auth_user_id
      and operation_type = p_operation_type
      and request_key = p_request_key
    for update;

  if v_by_key.id is not null then
    v_intent_matches :=
      v_by_key.application_id = p_application_id
      and v_by_key.operation_type = p_operation_type
      and v_by_key.channel = p_channel
      and v_by_key.bulk_batch_id is not distinct from p_bulk_batch_id
      and v_by_key.reason_code is not distinct from p_reason_code
      and v_by_key.note is not distinct from p_note
      and v_by_key.expected_current_credential_id is not distinct from p_expected_current_credential_id
      and v_by_key.requested_by_auth_user_id = p_requester_auth_user_id
      and v_by_key.request_key = p_request_key;

    if not v_intent_matches then
      op := v_by_key;
      state := 'request_key_intent_conflict';
      return;
    end if;

    if v_by_key.status = 'consumed' then
      op := v_by_key;
      state := 'already_consumed';
      return;
    end if;

    if v_by_key.status = 'expired' then
      op := v_by_key;
      state := 'replay_expired';
      return;
    end if;

    if v_by_key.status = 'cancelled' then
      op := v_by_key;
      state := 'replay_cancelled';
      return;
    end if;

    -- status = 'pending': returned LOCKED and UNRESOLVED (correction B/C)
    -- — the caller performs the authoritative TTL recheck after every
    -- remaining required lock is held.
    op := v_by_key;
    state := 'matching_pending_candidate';
    return;
  end if;

  -- No row under THIS request_key. Correction (A): the domain-wide lookup
  -- below has NO requester filter at all — any pending operation for this
  -- (application_id, operation_type), regardless of who requested it, is
  -- a blocking candidate. Correction (B): FOR UPDATE, held for the rest
  -- of the caller's transaction — not merely read.
  select * into v_other_pending from public.qr_lifecycle_operations
    where application_id = p_application_id
      and operation_type = p_operation_type
      and status = 'pending'
      and request_key is distinct from p_request_key
    for update;

  if v_other_pending.id is not null then
    op := v_other_pending;
    state := 'other_pending_candidate';
    return;
  end if;

  state := 'no_existing_operation';
  return; -- caller proceeds to insert a new pending row under p_request_key
end;
$$;

revoke all on function public.reserve_or_reuse_qr_lifecycle_operation(
  text, uuid, uuid, uuid, text, uuid, text, text, uuid
) from public;
-- No grant to authenticated/anon — called only from within the four
-- reservation RPCs' own security-definer bodies.

-- SUB-PASS 2, FIFTH CORRECTION ROUND (item 3): shared blocker-resolution
-- logic, extracted so the normal other_pending_candidate path and the
-- named-index-violation recovery path never maintain two independently
-- drifting copies of the same sequence. Takes an ALREADY-LOCKED candidate
-- operation row (FOR UPDATE already held by the caller, either via
-- reserve_or_reuse's own domain-wide lookup or via the exception
-- handler's own recovery query) and the ALREADY-LOCKED application row,
-- and resolves the candidate to EXACTLY one of two dispositions:
--   'still_blocking'   — the candidate survived every check; caller
--                         returns another_operation_pending (with the
--                         leak-avoidance id rule applied by the CALLER,
--                         since only the caller knows the current
--                         requester's auth.uid()).
--   'terminalized'      — the candidate was cancelled or expired by this
--                         call; caller proceeds to insert/retry its own
--                         request.
-- Correction order enforced here (item 1, restated precisely): ineligible
-- application decided FIRST (no credential lock needed); otherwise the
-- credential lock is acquired BEFORE the TTL decision; TTL is checked
-- immediately after that lock, and an expired candidate is terminalized
-- as 'expired'/'ttl_expired' even if an active credential ALSO exists —
-- expiry wins. Only when the candidate is confirmed unexpired does an
-- existing active credential terminalize it as
-- 'cancelled'/'active_credential_already_exists'.
create function public.resolve_blocking_qr_lifecycle_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- Credential lock BEFORE the TTL decision (position 6), per this
  -- round's corrected precedence.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- TTL checked immediately after the credential lock — expiry wins over
  -- an active-credential conflict observed only after waiting for that
  -- lock.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  if v_existing_credential.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_existing_credential.id
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

revoke all on function public.resolve_blocking_qr_lifecycle_operation(
  public.qr_lifecycle_operations, public.applications
) from public;
-- No grant to authenticated/anon — called only from within reservation
-- RPCs' own security-definer bodies, which already hold every lock this
-- function itself requires (application row; the candidate row's own
-- lock was acquired by the caller before invoking this function).

-- ================= RESERVATION (participant self-service) =================
-- Lock order (§1.7a, refined this round): advisory reservation lock (inside
-- reserve_or_reuse) -> lifecycle operation -> application -> current
-- credential (not applicable to issuance).
--
-- CORRECTED this round: a matched pending operation is no longer trusted
-- and returned as 'already_pending' immediately — the application is
-- ALWAYS locked and re-validated afterward, for every reserve_or_reuse
-- `state`. If the application is no longer accepted, OR an active
-- credential now exists, and there WAS a matched pending operation, that
-- operation is explicitly cancelled (terminal_reason_code set, one
-- captured timestamp) rather than left dangling until its own TTL — a
-- stale pending operation must never simply be abandoned. No RAISE
-- follows any of these state-changing UPDATEs; every terminal transition
-- is followed by a plain RETURN so the transition commits.
-- SUB-PASS 2: p_request_key is now required — the browser/server must
-- generate one random UUID before the user confirms this action and pass
-- the SAME value on every retry of that confirmed action.
-- SUB-PASS 2, SECOND CORRECTION ROUND:
--
-- (5) First-request business outcomes are now DURABLE. The previous
-- version validated application eligibility and credential state BEFORE
-- ever inserting a row, and RAISED for the "no existing operation, but
-- application is not accepted" case rather than persisting anything — a
-- caller retrying that exact request_key after a lost response would
-- re-run the SAME validation against whatever the CURRENT (possibly
-- different) state is, rather than replaying the original outcome. Now:
-- for a brand-new request_key, the pending row is inserted FIRST (the
-- lifecycle trigger requires every INSERT to begin 'pending' — §1.7's own
-- trigger), then application eligibility and active-credential state are
-- checked under lock and the SAME row is transitioned to 'cancelled' with
-- the appropriate terminal_reason_code if either fails — never a bare
-- RAISE for these two expected business outcomes. A retry under the same
-- request_key later finds this now-cancelled row via
-- reserve_or_reuse_qr_lifecycle_operation's 'replay_cancelled' state and
-- replays the identical outcome, rather than re-evaluating against
-- possibly-changed future state.
--
-- (6) Ownership re-verified after the application lock. The initial
-- unlocked `select id from applications where applicant_id = auth.uid()`
-- is used ONLY to locate a candidate row for the advisory-lock domain —
-- it is explicitly re-verified (v_app.applicant_id = auth.uid()) after
-- FOR UPDATE, not trusted on its own.
--
-- SUB-PASS 2, FOURTH CORRECTION ROUND (supersedes the third round's
-- (B)/(C) — that round moved the TTL recheck to after the APPLICATION
-- lock, but left it BEFORE the CREDENTIAL lock, which is itself a lock
-- the outcome can wait on; this round moves it one step further, to
-- after EVERY lock the eventual outcome depends on):
--
-- Global lock order: 1) reservation-domain advisory lock (inside
-- reserve_or_reuse) 2) lifecycle operation row candidate, locked (inside
-- reserve_or_reuse) 3) bulk batch — not applicable, participant channel
-- 4) application row, FOR UPDATE 5) current active credential, FOR
-- UPDATE (issuance has none to "hold as current," but the existence
-- check itself is lock-guarded so its result is stable for the rest of
-- this transaction) THEN, and only then, a fresh clock_timestamp() and
-- the authoritative TTL decision.
--
-- (D) matching_pending_candidate: an ineligible application is decided
-- and persisted immediately after the application lock alone (no
-- credential lock is needed to prove application ineligibility). If the
-- application IS eligible, the credential lock is acquired, THEN
-- clock_timestamp() is captured, THEN the TTL decision is made — a
-- pending operation that expires while this RPC was waiting on the
-- credential lock is correctly caught here, rather than being missed by
-- an earlier, now-stale TTL check.
--
-- (E) other_pending_candidate is now FULLY resolved, not merely
-- TTL-checked: after the application lock, an ineligible application
-- immediately cancels the BLOCKING operation (application_ineligible) —
-- no credential lock needed for that determination either. Otherwise the
-- credential lock is acquired; if an active credential exists, the
-- blocking operation is cancelled (active_credential_already_exists,
-- terminal_related_credential_id set); THEN clock_timestamp() is
-- captured and the blocking operation's TTL is checked, expiring it if
-- lapsed. Only if the blocking operation survives ALL of these checks
-- (still pending, unexpired, application eligible, no active credential)
-- does this RPC return another_operation_pending — a stale blocker can
-- never indefinitely block the domain. Whenever the blocking operation IS
-- terminalized by any of these checks, THIS request continues processing
-- immediately (falls through to insert its own row and persist its own
-- outcome), in the SAME transaction, under the SAME advisory-lock hold —
-- no second round-trip required.
--
-- (D, restated for the freshly-inserted row) The identical discipline
-- applies to a row THIS call itself just inserted: ineligibility is
-- decided immediately after the application lock (no credential lock
-- needed); otherwise the credential lock is acquired, THEN
-- clock_timestamp() is captured, THEN this NEW row's own TTL is checked
-- — if this RPC's own insert-to-credential-lock window somehow exceeded
-- the 5-minute TTL (pathological, but not assumed impossible), the row
-- it just created is correctly expired rather than incorrectly returned
-- as reserved or cancelled for a since-observed active credential.
--
-- (6, leak avoidance) other_pending_candidate never returns the blocking
-- operation's id when it belongs to a DIFFERENT requester.
-- SUB-PASS 2, FIFTH CORRECTION ROUND: split into a private internal
-- implementation (accepts p_pending_ttl, never exposed to
-- authenticated/anon) and two thin callers — the real public RPC (fixed
-- at 5 minutes) and a test-only wrapper (test-only-setup.sql, short TTL,
-- service_role only, removed at teardown). The public authenticated
-- surface never accepts a caller-supplied TTL.
--
-- Also in this round: the matching_pending_candidate path's ordering is
-- corrected — a prior version acquired the credential lock before the
-- TTL decision (correct precedence) but then applied an
-- active_credential_already_exists conflict IMMEDIATELY upon finding a
-- credential, without checking TTL first — meaning an operation that had
-- ALREADY expired while waiting for the credential lock could still be
-- reported as active_credential_already_exists instead of
-- operation_expired. TTL must be checked immediately after the credential
-- lock and win if expired, exactly mirroring
-- resolve_blocking_qr_lifecycle_operation's own ordering (both paths now
-- share that exact sequence, though matching_pending_candidate cannot
-- literally call the shared resolver, since its RETURN outcomes differ
-- from a blocker's: operation_expired/already_pending/
-- active_credential_already_exists for the CALLER'S OWN operation, not
-- terminalized/still_blocking for someone else's).
create function public.request_my_qr_issuance_transactional_internal(
  p_request_key uuid,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_application_id_candidate uuid;
  v_app public.applications;
  v_existing_credential public.qr_credentials;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  select id into v_application_id_candidate from public.applications where applicant_id = auth.uid();
  if v_application_id_candidate is null then raise exception 'No application found for this account'; end if;

  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'issue', v_application_id_candidate, auth.uid(), p_request_key, 'participant_self_service', null, null, null, null
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_existing_credential from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_existing_credential.id;
    v_result.status := 'active';
    v_result.issued_at := v_existing_credential.issued_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'active_credential_already_exists' then
      select * into v_existing_credential from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_existing_credential.id;
      v_result.status := 'active';
      v_result.issued_at := v_existing_credential.issued_at;
    end if;
    return v_result;
  end if;

  -- Position 5: lock the application, THEN re-verify ownership and
  -- eligibility.
  select * into v_app from public.applications where id = v_application_id_candidate for update;
  if v_app.id is null or v_app.applicant_id is distinct from auth.uid() then
    raise exception 'No application found for this account';
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Fifth correction round (item 3): delegates to the SAME shared
    -- resolver the exception-recovery path below also uses — one copy of
    -- the ineligible -> credential-lock -> TTL -> credential-conflict
    -- sequence, never two independently drifting versions.
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' — falls through to the shared insert-and-resolve
    -- path below, identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    if v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    -- Position 6: credential lock BEFORE the TTL decision.
    select * into v_existing_credential from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    -- TTL checked IMMEDIATELY after the credential lock, and BEFORE
    -- applying any credential conflict — expiry wins (fifth correction
    -- round, item 1).
    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_existing_credential.id is not null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
          terminal_related_credential_id = v_existing_credential.id
      where id = (v_reservation.op).id;
      v_result.outcome := 'active_credential_already_exists';
      v_result.operation_id := (v_reservation.op).id;
      v_result.credential_id := v_existing_credential.id;
      v_result.status := v_existing_credential.status;
      v_result.issued_at := v_existing_credential.issued_at;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- Shared insert-and-resolve path: reached for 'no_existing_operation',
  -- and for an 'other_pending_candidate' just terminalized above.
  v_created_at := clock_timestamp();
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, request_key, created_at, expires_at
    ) values (
      'issue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
      p_request_key, v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        -- Fifth correction round (item 3): the recovery path now runs the
        -- conflicting row through the SAME shared resolver, rather than
        -- unconditionally reporting another_operation_pending for a row
        -- that may itself already be expired/ineligible/superseded by an
        -- active credential.
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = v_app.id and operation_type = 'issue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          -- Terminalized by someone else between the violation and this
          -- recovery query — retry the insert once, still under this
          -- function's own advisory-lock hold.
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, request_key, created_at, expires_at
          ) values (
            'issue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
            p_request_key, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          -- 'terminalized' — retry the insert once, still under this
          -- function's own advisory-lock hold, then continue below.
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, request_key, created_at, expires_at
          ) values (
            'issue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
            p_request_key, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  if v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Position 6: credential lock BEFORE the TTL decision (restated for a
  -- row this call itself just inserted).
  select * into v_existing_credential from public.qr_credentials
    where application_id = v_app.id and status = 'active' for update;

  v_check_now := clock_timestamp();
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  if v_existing_credential.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_existing_credential.id
    where id = v_operation_id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.operation_id := v_operation_id;
    v_result.credential_id := v_existing_credential.id;
    v_result.status := v_existing_credential.status;
    v_result.issued_at := v_existing_credential.issued_at;
    return v_result;
  end if;

  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_my_qr_issuance_transactional_internal(uuid, interval) from public;
-- No grant to authenticated/anon — reachable only through the two
-- wrappers below, both of which fix or otherwise control p_pending_ttl.

-- Public, authenticated-facing wrapper — the ONLY entry point exposed to
-- real users. TTL is hardcoded; no caller, however privileged, can pass a
-- different value through this signature.
create function public.request_my_qr_issuance_transactional(
  p_request_key uuid
) returns public.qr_credential_lifecycle_result
language sql security definer set search_path = public, pg_temp as $$
  select public.request_my_qr_issuance_transactional_internal(p_request_key, interval '5 minutes');
$$;

revoke all on function public.request_my_qr_issuance_transactional(uuid) from public;
grant execute on function public.request_my_qr_issuance_transactional(uuid) to authenticated;

-- TEST-ONLY short-TTL wrapper — belongs in the future reservation-RPC
-- test file's own test-only-setup.sql (parallel to
-- tests/attendance/qr-credentials-lifecycle-trigger.test-only-setup.sql's
-- existing pattern: outside supabase/migrations/, local-only, torn down
-- after the suite), NOT in this production migration surface. Documented
-- here as the exact shape to use once that test file is written (deferred
-- — the reservation RPCs and finalizers are not yet complete). Calls the
-- SAME internal implementation the real 5-minute-fixed RPC calls, with a
-- short interval, so TTL-expiry-under-lock tests can run in seconds
-- rather than needing a real 5-minute wait.
--
--   create function public.test_only_request_my_qr_issuance_short_ttl(
--     p_request_key uuid,
--     p_pending_ttl interval
--   ) returns public.qr_credential_lifecycle_result
--   language sql security definer set search_path = public, pg_temp as $$
--     select public.request_my_qr_issuance_transactional_internal(p_request_key, p_pending_ttl);
--   $$;
--
--   revoke all on function public.test_only_request_my_qr_issuance_short_ttl(uuid, interval) from public, anon, authenticated;
--   grant execute on function public.test_only_request_my_qr_issuance_short_ttl(uuid, interval) to service_role;
--
-- Teardown: drop function if exists public.test_only_request_my_qr_issuance_short_ttl(uuid, interval);

-- ================= RESERVATION (staff individual/bulk) — APPROVED =================
-- SUB-PASS 2, this round's addition. Extends the approved participant
-- issuance/reissue foundation exactly — same request_key/dual-advisory-
-- lock protocol via reserve_or_reuse_qr_lifecycle_operation, same split
-- into a private internal implementation (accepts p_pending_ttl, never
-- exposed to authenticated/anon) and a thin public wrapper fixed at 5
-- minutes, same insert-first-then-validate durability discipline, same
-- UPDATE-then-RETURN (never UPDATE-then-RAISE) pattern.
--
-- Supersedes the older sketch immediately following this section (kept
-- only for historical reference — see the "SUPERSEDED" marker below); the
-- old sketch predates request_key entirely, calls
-- reserve_or_reuse_qr_lifecycle_operation with only 8 positional
-- arguments (the approved signature takes 9 — p_request_key is
-- positional argument 4), uses the outcome name 'pending_operation_conflict'
-- (never approved into the schema/vocabulary — the approved name is
-- 'request_key_intent_conflict'), pre-reads authoritative batch/
-- application/credential state with NO row lock before making
-- authorization/eligibility decisions (an unlocked `select ... from
-- qr_bulk_operation_batches ... for share` performed only AFTER an
-- earlier unlocked existence check, and an entirely UNLOCKED
-- `select ... from qr_credentials where status = 'active'` with no FOR
-- UPDATE at all), and never re-derives staff authorization or batch
-- availability for an already-existing pending operation at all.
--
-- A staff-issuance-specific blocker resolver
-- (resolve_blocking_qr_lifecycle_staff_issuance_operation) is introduced
-- alongside it — parameterized separately from both
-- resolve_blocking_qr_lifecycle_operation (participant issuance) and
-- resolve_blocking_qr_lifecycle_reissue_operation (participant reissue)
-- because staff issuance's decision tree includes two conditions neither
-- participant path has any equivalent for: the requester's staff role can
-- itself lapse between reservation and resolution (a participant's
-- identity has no analogous "role" to lose), and a staff_bulk operation's
-- authorizing batch can itself become unavailable (closed, expired,
-- wrong type, or reassigned) independently of the application/credential
-- state the participant resolvers already cover.
create function public.resolve_blocking_qr_lifecycle_staff_issuance_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  -- 1. Requester authorization, re-verified against the CANDIDATE's own
  -- recorded requester (not the CURRENT caller of this resolver, who may
  -- be a different concurrent staff member entirely resolving someone
  -- else's stale blocker) — a candidate whose original requester has
  -- since lost the required role can never legitimately resolve to
  -- 'reserved', regardless of who is asking about it now.
  select role into v_caller_role from public.profiles where id = p_candidate.requested_by_auth_user_id;
  if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 2. Bulk-batch availability, only when this candidate is staff_bulk
  -- (bulk_batch_id is null for staff_individual, per
  -- qr_lifecycle_operations_bulk_batch_matches_channel — nothing to
  -- validate in that case).
  if p_candidate.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches
      where id = p_candidate.bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from p_candidate.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from p_candidate.requested_by_profile_id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 3. Application eligibility (no credential lock needed for this
  -- determination — mirrors both participant resolvers' identical
  -- precedence).
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 4. Credential lock BEFORE the TTL decision, matching every other
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- 5. TTL checked immediately after the credential lock — expiry wins
  -- over every finding below, including a credential conflict.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 6. Active-credential conflict.
  if v_existing_credential.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_existing_credential.id
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

revoke all on function public.resolve_blocking_qr_lifecycle_staff_issuance_operation(
  public.qr_lifecycle_operations, public.applications
) from public;
-- No grant to authenticated/anon — called only from within
-- request_staff_qr_issuance_transactional_internal's own security-definer
-- body, which already holds every lock this function itself requires
-- (application row; the candidate row's own lock was acquired by the
-- caller before invoking this function; the batch row's FOR SHARE lock is
-- acquired inside this function itself, at its correct position in the
-- global lock order — batch, position 4, BEFORE application, position 5).

-- Global lock order (unchanged from the participant RPCs, restated for
-- staff issuance, now genuinely including the batch step no participant
-- path has):
--   1. request-key advisory lock (requester, operation_type, request_key)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   2. reservation-domain advisory lock (application_id, operation_type)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   3. lifecycle-operation row, by request_key or the domain's other
--      pending issue operation — inside reserve_or_reuse_qr_lifecycle_operation.
--   4. bulk batch, FOR SHARE, only for channel = 'staff_bulk' — locked
--      and fully revalidated (existence, status, expiry, type, ownership)
--      AFTER the operation lock and BEFORE the application lock.
--   5. application row, FOR UPDATE.
--   6. current active credential row, FOR UPDATE.
--   7. fresh clock_timestamp() and every authoritative TTL/authorization/
--      batch/eligibility decision, only after every lock above is held.
-- No authoritative application, batch, or credential state is ever read
-- before its corresponding lock in this order — every pre-lock read in
-- this function is used ONLY to shape the advisory-lock domain
-- (application id) or the reservation's immutable-intent channel
-- derivation (bulk batch id being null or not), never to make an
-- eligibility/authorization decision.
--
-- Immutable reservation intent (compared field-for-field by
-- reserve_or_reuse_qr_lifecycle_operation's existing intent-match logic —
-- no changes needed there): operation_type ('issue'), application_id,
-- requested_by_auth_user_id (auth.uid()), requested_by_profile_id
-- (== auth.uid(), the resolved staff profile), channel
-- ('staff_individual' or 'staff_bulk', derived deterministically from
-- whether p_bulk_batch_id is null), request_key, reason_code (the
-- normalized staff issuance reason), note (normalized), bulk_batch_id
-- (non-null only for staff_bulk), expected_current_credential_id (always
-- null — qr_lifecycle_operations_issue_has_no_expected_credential).
create function public.request_staff_qr_issuance_transactional_internal(
  p_request_key uuid,
  p_application_id uuid,
  p_issuance_reason_code text,
  p_issuance_note text,
  p_bulk_batch_id uuid,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_normalized_note text;
  v_channel text;
  v_batch public.qr_bulk_operation_batches;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_application_id is null then raise exception 'application_id is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  -- Authorization: derived from auth.uid() alone, never a parameter.
  -- Re-verified again under lock, against the CANDIDATE row's own
  -- recorded requester, inside the resolver above, for every already-
  -- existing pending operation this call might find — this initial check
  -- governs only whether THIS call itself may proceed to create/replay
  -- anything at all.
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin', 'program_attendance_manager') then
    raise exception 'Not authorized';
  end if;

  -- Reason-code/note validation, per §1.4's conditional rules for
  -- staff_individual/staff_bulk issuance: the code must be one of the
  -- four staff codes, never a participant or reissue code.
  -- 'staff_other' requires a non-empty trimmed note. Note normalization —
  -- identical rule applied once, reused for validation, the immutable-
  -- intent comparison, and persistence: null stays null; trimmed-empty
  -- text becomes null; non-empty text is stored trimmed.
  if p_issuance_reason_code is null or p_issuance_reason_code not in (
    'advance_badge_printing', 'participant_not_logged_in', 'bulk_event_preparation', 'staff_other'
  ) then
    raise exception 'A valid staff issuance reason code is required';
  end if;
  v_normalized_note := nullif(trim(p_issuance_note), '');
  if p_issuance_reason_code = 'staff_other' and v_normalized_note is null then
    raise exception 'A note is required when issuance reason is staff_other';
  end if;

  -- Channel is a deterministic function of p_bulk_batch_id alone — no
  -- lock or authoritative batch state is needed to compute it; this is
  -- purely a null-check, used ONLY to shape the reservation's immutable
  -- intent, never to authorize or validate anything about the batch
  -- itself (that happens under lock, at position 4, below).
  v_channel := case when p_bulk_batch_id is null then 'staff_individual' else 'staff_bulk' end;

  -- Positions 1-3: advisory-locked reservation lookup, unchanged shared
  -- helper — operation_type = 'issue', expected_current_credential_id
  -- always null for issuance.
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'issue', p_application_id, auth.uid(), p_request_key, v_channel, p_bulk_batch_id,
    p_issuance_reason_code, v_normalized_note, null
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_current_active from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    -- Identical replay of ANY previously-cancelled staff issuance
    -- reservation — including requester_no_longer_authorized and
    -- bulk_batch_unavailable — replays the STORED terminal reason,
    -- never re-evaluating current authorization, application, batch, or
    -- credential state for an already-terminal same-key operation.
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'active_credential_already_exists' then
      select * into v_current_active from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
    end if;
    return v_result;
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Delegates to the staff-issuance-specific shared resolver — one copy
    -- of the authorization -> batch -> ineligible -> credential-lock ->
    -- TTL -> credential-conflict sequence, never duplicated between this
    -- path and the exception-recovery path below.
    select * into v_app from public.applications where id = p_application_id;
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_staff_issuance_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' — falls through to the shared insert-and-resolve
    -- path below, identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    -- Re-evaluate the SAME authoritative conditions the resolver checks,
    -- inline, returning THIS caller's own outcomes
    -- (already_pending/operation_expired/requester_no_longer_authorized/
    -- bulk_batch_unavailable/application_ineligible/
    -- active_credential_already_exists) rather than the resolver's
    -- generic still_blocking/terminalized pair — exactly mirroring both
    -- participant RPCs' identical matching_pending_candidate vs.
    -- other_pending_candidate distinction.
    declare
      v_caller_role text;
    begin
      select role into v_caller_role from public.profiles where id = (v_reservation.op).requested_by_auth_user_id;
      if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
        where id = (v_reservation.op).id;
        v_result.outcome := 'requester_no_longer_authorized';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end;

    if (v_reservation.op).channel = 'staff_bulk' then
      select * into v_batch from public.qr_bulk_operation_batches
        where id = (v_reservation.op).bulk_batch_id for share;
      if v_batch.id is null
         or v_batch.status <> 'active'
         or v_batch.expires_at <= clock_timestamp()
         or v_batch.intended_operation_type <> 'issue'
         or v_batch.created_by_auth_user_id is distinct from (v_reservation.op).requested_by_auth_user_id
         or v_batch.created_by_profile_id is distinct from (v_reservation.op).requested_by_profile_id
      then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
        where id = (v_reservation.op).id;
        v_result.outcome := 'bulk_batch_unavailable';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end if;

    select * into v_app from public.applications where id = p_application_id for update;
    if v_app.id is null or v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    select * into v_current_active from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id is not null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
          terminal_related_credential_id = v_current_active.id
      where id = (v_reservation.op).id;
      v_result.outcome := 'active_credential_already_exists';
      v_result.operation_id := (v_reservation.op).id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- ===================== 'no_existing_operation' path =====================
  -- (also reached for an 'other_pending_candidate' just terminalized
  -- above, which falls through here identically.)
  --
  -- Authoritative processing order, restated exactly as specified and
  -- implemented step-for-step below:
  --   1. create or reuse the durable lifecycle operation through the
  --      approved request-key protocol (already done above, at positions
  --      1-3 — shared by every state).
  --   2. lock and validate the bulk batch when applicable.
  --   3. lock the target application.
  --   4. lock/query the current active credential.
  --   5. capture a fresh timestamp.
  --   6. if the operation TTL elapsed while waiting, transition to
  --      expired/ttl_expired.
  --   7. if the requester is no longer authorized, cancel with
  --      requester_no_longer_authorized.
  --   8. if the bulk batch is unavailable, cancel with
  --      bulk_batch_unavailable.
  --   9. if the application is missing or no longer accepted, cancel with
  --      application_ineligible.
  --  10. if an active credential exists, cancel with
  --      active_credential_already_exists and persist
  --      terminal_related_credential_id.
  --  11. otherwise return reserved.
  --
  -- No operation row exists yet for THIS request on this path's early
  -- steps — an insert-first-then-validate discipline is used exactly like
  -- both participant RPCs, so every one of the above denials still leaves
  -- its own durable, queryable row rather than a no-row business outcome.
  v_created_at := clock_timestamp();
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
    ) values (
      'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
      p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = p_application_id and operation_type = 'issue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
          ) values (
            'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_app from public.applications where id = p_application_id;
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_staff_issuance_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
          ) values (
            'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  -- Step 2: lock and validate the bulk batch, only for staff_bulk —
  -- position 4, BEFORE the application lock (position 5), per the global
  -- order.
  if v_channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = p_bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from auth.uid()
       or v_batch.created_by_profile_id is distinct from v_caller.id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_operation_id;
      v_result.outcome := 'bulk_batch_unavailable';
      v_result.operation_id := v_operation_id;
      return v_result;
    end if;
  end if;

  -- Step 3: lock the target application — position 5.
  select * into v_app from public.applications where id = p_application_id for update;

  -- Step 4: credential lock — position 6.
  select * into v_current_active from public.qr_credentials
    where application_id = p_application_id and status = 'active' for update;

  -- Step 5: fresh timestamp, captured only after every lock above.
  v_check_now := clock_timestamp();

  -- Step 6: TTL, checked first — expiry wins over every finding below.
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 7: requester authorization, re-verified under the full lock set
  -- (this call's own auth.uid() cannot itself have changed mid-call, but
  -- this mirrors the identical re-check performed for
  -- matching_pending_candidate/the blocker resolver, so the SAME
  -- authoritative condition is checked at the SAME logical point on every
  -- code path — no path is exempt from re-verifying it here).
  if v_caller.role not in ('super_admin', 'program_attendance_manager') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = v_operation_id;
    v_result.outcome := 'requester_no_longer_authorized';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 8: bulk-batch availability was already fully validated at Step 2,
  -- above, BEFORE the application lock, per the global order — restated
  -- here only as the corresponding numbered step, no further action.

  -- Step 9: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 10: active-credential conflict.
  if v_current_active.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_current_active.id
    where id = v_operation_id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.operation_id := v_operation_id;
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    return v_result;
  end if;

  -- Step 11: every check has passed — the pending row remains genuinely
  -- reserved. Credential creation/revocation/replacement/encryption/
  -- display belongs only to the future issuance finalizer, never this
  -- reservation RPC.
  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_staff_qr_issuance_transactional_internal(uuid, uuid, text, text, uuid, interval) from public;
-- No grant to authenticated/anon — reachable only through the public
-- wrapper below and a future test-only short-TTL wrapper, both of which
-- fix or otherwise control p_pending_ttl.

-- Public, authenticated-facing wrapper — the ONLY entry point exposed to
-- real staff users. TTL is hardcoded at 5 minutes, identical to both
-- participant RPCs; no caller, however privileged, can pass a different
-- value through this signature.
create function public.request_staff_qr_issuance_transactional(
  p_request_key uuid,
  p_application_id uuid,
  p_issuance_reason_code text,
  p_issuance_note text,
  p_bulk_batch_id uuid default null
) returns public.qr_credential_lifecycle_result
language sql security definer set search_path = public, pg_temp as $$
  select public.request_staff_qr_issuance_transactional_internal(
    p_request_key, p_application_id, p_issuance_reason_code, p_issuance_note, p_bulk_batch_id,
    interval '5 minutes'
  );
$$;

revoke all on function public.request_staff_qr_issuance_transactional(uuid, uuid, text, text, uuid) from public;
grant execute on function public.request_staff_qr_issuance_transactional(uuid, uuid, text, text, uuid) to authenticated;

-- TEST-ONLY short-TTL wrapper — belongs in this suite's own test-only
-- setup SQL (parallel to the participant issuance/reissue test-only
-- wrappers already established), NOT in this production migration
-- surface. Documented here as the exact shape used once written.
--
--   create function public.test_only_request_staff_qr_issuance_short_ttl(
--     p_request_key uuid,
--     p_application_id uuid,
--     p_issuance_reason_code text,
--     p_issuance_note text,
--     p_bulk_batch_id uuid,
--     p_pending_ttl interval,
--     p_waiter_tag text
--   ) returns public.qr_credential_lifecycle_result
--   language plpgsql security definer set search_path = public, pg_temp as $$
--   declare
--     v_result public.qr_credential_lifecycle_result;
--   begin
--     if p_waiter_tag is null or trim(p_waiter_tag) = '' then
--       raise exception 'test_only_request_staff_qr_issuance_short_ttl: p_waiter_tag is required';
--     end if;
--     perform set_config('application_name', p_waiter_tag, true);
--     select * into v_result from public.request_staff_qr_issuance_transactional_internal(
--       p_request_key, p_application_id, p_issuance_reason_code, p_issuance_note, p_bulk_batch_id, p_pending_ttl
--     );
--     return v_result;
--   end;
--   $$;
--
--   revoke all on function public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text)
--     from public, anon, service_role;
--   grant execute on function public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text)
--     to authenticated;
--
-- Teardown: drop function if exists public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text);

-- ================= RESERVATION (staff force-reissue, individual/bulk) — APPROVED =================
-- SUB-PASS 2, this round's addition. Extends the approved reservation
-- foundation exactly — same request_key/dual-advisory-lock protocol via
-- reserve_or_reuse_qr_lifecycle_operation (unmodified, unchanged, no new
-- signature), same split into a private internal implementation (accepts
-- p_pending_ttl, never exposed to authenticated/anon) and a thin public
-- wrapper fixed at 5 minutes, same insert-first-then-validate durability
-- discipline, same UPDATE-then-RETURN (never UPDATE-then-RAISE) pattern.
--
-- A staff-reissue-specific blocker resolver
-- (resolve_blocking_qr_lifecycle_staff_reissue_operation) is introduced
-- alongside it — a NEW function, not a modification of either
-- resolve_blocking_qr_lifecycle_staff_issuance_operation (participant/
-- staff issuance's resolver, frozen, unchanged) or
-- resolve_blocking_qr_lifecycle_reissue_operation (participant reissue's
-- resolver, frozen, unchanged). It mirrors
-- resolve_blocking_qr_lifecycle_staff_issuance_operation's exact
-- authorization -> batch -> application -> credential-lock -> TTL
-- sequence and terminal-update/historical-replay discipline, but replaces
-- that resolver's final "active credential is itself the conflict" step
-- with resolve_blocking_qr_lifecycle_reissue_operation's own reissue-
-- specific credential semantics: an active credential is REQUIRED (its
-- ABSENCE is the terminal condition, 'no_active_credential'), and an
-- active credential that does not match the operation's own durable
-- expected_current_credential_id is ALSO terminal
-- ('expected_credential_changed') — mirroring the two independent
-- credential-state findings the participant reissue resolver already
-- established, now combined with staff issuance's authorization/batch
-- findings neither participant resolver has any equivalent for. Staff
-- reissue has no participant cooldown or rolling-rate-limit concept at
-- all (those are participant-self-service-only policies scoped by
-- channel = 'participant_self_service' in the cooldown/rate-limit
-- query itself — a staff_individual/staff_bulk row can never match that
-- filter, so no staff-specific carve-out is even needed there).
create function public.resolve_blocking_qr_lifecycle_staff_reissue_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  -- 1. Requester authorization, re-verified against the CANDIDATE's own
  -- recorded requester — identical precedence and rationale to
  -- resolve_blocking_qr_lifecycle_staff_issuance_operation's own first
  -- step.
  select role into v_caller_role from public.profiles where id = p_candidate.requested_by_auth_user_id;
  if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 2. Bulk-batch availability, only when this candidate is staff_bulk.
  -- Identical shape to staff issuance's own batch check, EXCEPT
  -- intended_operation_type must be 'reissue', not 'issue' — an
  -- issue-typed batch can never authorize a reissue reservation.
  if p_candidate.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches
      where id = p_candidate.bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from p_candidate.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from p_candidate.requested_by_profile_id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 3. Application eligibility (no credential lock needed for this
  -- determination — mirrors every other resolver's identical
  -- precedence).
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 4. Credential lock BEFORE the TTL decision, matching every other
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- 5. TTL checked immediately after the credential lock — expiry wins
  -- over every credential-state finding below.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 6. Reissue-specific credential semantics (replaces staff issuance's
  -- "active credential is itself the conflict" step): a MISSING active
  -- credential is terminal.
  if v_existing_credential.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 7. An active credential exists but does not match the candidate's
  -- own durable expected_current_credential_id — also terminal.
  -- CORRECTED this round: terminal_related_credential_id is permitted
  -- ONLY for 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null for 'expected_credential_changed'. The
  -- same narrow correction was applied to every occurrence of this exact
  -- pattern this same round, including finalize_qr_reissue_for_server.
  if v_existing_credential.id <> p_candidate.expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

revoke all on function public.resolve_blocking_qr_lifecycle_staff_reissue_operation(
  public.qr_lifecycle_operations, public.applications
) from public;
-- No grant to authenticated/anon — called only from within
-- request_staff_qr_reissue_transactional_internal's own security-definer
-- body, which already holds every lock this function itself requires.

-- Global lock order (unchanged from staff issuance, restated for staff
-- reissue):
--   1. request-key advisory lock (requester, operation_type, request_key)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   2. reservation-domain advisory lock (application_id, operation_type)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   3. lifecycle-operation row, by request_key or the domain's other
--      pending reissue operation — inside reserve_or_reuse_qr_lifecycle_operation.
--   4. bulk batch, FOR SHARE, only for channel = 'staff_bulk' — locked
--      and fully revalidated AFTER the operation lock and BEFORE the
--      application lock.
--   5. application row, FOR UPDATE.
--   6. current active credential row, FOR UPDATE. No authoritative
--      current-credential pre-read occurs anywhere before this lock —
--      p_expected_current_credential_id is caller-supplied and compared
--      against the credential actually found active only AFTER this
--      lock is held, exactly like the participant reissue RPC.
--   7. fresh clock_timestamp() and every authoritative TTL/authorization/
--      batch/eligibility/credential decision, only after every lock
--      above is held.
--
-- Immutable reservation intent (compared field-for-field by
-- reserve_or_reuse_qr_lifecycle_operation's existing intent-match logic —
-- no changes needed there): operation_type ('reissue'), application_id,
-- requested_by_auth_user_id (auth.uid()), requested_by_profile_id
-- (== auth.uid(), the resolved staff profile), channel
-- ('staff_individual' or 'staff_bulk', derived deterministically from
-- whether p_bulk_batch_id is null), request_key, reason_code (the
-- normalized staff reissue reason), note (normalized), bulk_batch_id
-- (non-null only for staff_bulk), expected_current_credential_id
-- (caller-supplied, required non-null —
-- qr_lifecycle_operations_reissue_has_expected_credential).
create function public.request_staff_qr_reissue_transactional_internal(
  p_request_key uuid,
  p_application_id uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_bulk_batch_id uuid,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_normalized_note text;
  v_channel text;
  v_batch public.qr_bulk_operation_batches;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_application_id is null then raise exception 'application_id is required'; end if;
  if p_expected_current_credential_id is null then raise exception 'expected_current_credential_id is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  -- Authorization: derived from auth.uid() alone, never a parameter.
  -- Re-verified again under lock, against the CANDIDATE row's own
  -- recorded requester, inside the resolver above, for every already-
  -- existing pending operation this call might find.
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin', 'program_attendance_manager') then
    raise exception 'Not authorized';
  end if;

  -- Reason-code/note validation, per §1.4's conditional rules for staff
  -- force-reissue: the code must be one of the four staff reissue codes,
  -- never a participant code. 'staff_other' requires a non-empty trimmed
  -- note. Note normalization — identical rule applied once, reused for
  -- validation, the immutable-intent comparison, and persistence: null
  -- stays null; trimmed-empty text becomes null; non-empty text is
  -- stored trimmed.
  if p_reissue_reason_code is null or p_reissue_reason_code not in (
    'staff_assisted_recovery', 'suspected_compromise', 'administrative_correction', 'staff_other'
  ) then
    raise exception 'A valid staff reissue reason code is required';
  end if;
  v_normalized_note := nullif(trim(p_reissue_note), '');
  if p_reissue_reason_code = 'staff_other' and v_normalized_note is null then
    raise exception 'A note is required when reissue reason is staff_other';
  end if;

  -- If p_expected_current_credential_id cannot possibly satisfy
  -- qr_lifecycle_operations_expected_credential_fkey's composite
  -- (id, application_id) target — i.e. it does not identify ANY
  -- qr_credentials row belonging to THIS application, active or not —
  -- this is invalid input, rejected before any operation is ever
  -- created, exactly mirroring the participant reissue RPC's identical
  -- check. A credential that belongs to this application but is no
  -- longer active remains legal immutable intent and must produce the
  -- durable expected_credential_changed outcome via a real operation
  -- row, never an input-validation exception.
  if not exists (
    select 1 from public.qr_credentials
    where id = p_expected_current_credential_id and application_id = p_application_id
  ) then
    raise exception 'expected_current_credential_id does not identify a credential belonging to this application';
  end if;

  -- Channel is a deterministic function of p_bulk_batch_id alone — no
  -- lock or authoritative batch state is needed to compute it.
  v_channel := case when p_bulk_batch_id is null then 'staff_individual' else 'staff_bulk' end;

  -- Positions 1-3: advisory-locked reservation lookup, unchanged shared
  -- helper — operation_type = 'reissue'.
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'reissue', p_application_id, auth.uid(), p_request_key, v_channel, p_bulk_batch_id,
    p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_current_active from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    v_result.replaced_at := v_current_active.replaced_at;
    v_result.revoked_at := v_current_active.revoked_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    -- Identical replay of ANY previously-cancelled staff reissue
    -- reservation — including requester_no_longer_authorized,
    -- bulk_batch_unavailable, no_active_credential, and
    -- expected_credential_changed — replays the STORED terminal reason,
    -- never re-evaluating current role, batch, application, or
    -- credential state for an already-terminal same-key operation.
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'expected_credential_changed' then
      select * into v_current_active from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
    end if;
    return v_result;
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Delegates to the staff-reissue-specific shared resolver.
    select * into v_app from public.applications where id = p_application_id;
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_staff_reissue_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' — falls through to the shared insert-and-resolve
    -- path below, identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    -- Re-evaluate the SAME authoritative conditions the resolver checks,
    -- inline, returning THIS caller's own outcomes. No participant
    -- cooldown or rolling-rate-limit check applies anywhere on this
    -- path.
    declare
      v_caller_role text;
    begin
      select role into v_caller_role from public.profiles where id = (v_reservation.op).requested_by_auth_user_id;
      if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
        where id = (v_reservation.op).id;
        v_result.outcome := 'requester_no_longer_authorized';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end;

    if (v_reservation.op).channel = 'staff_bulk' then
      select * into v_batch from public.qr_bulk_operation_batches
        where id = (v_reservation.op).bulk_batch_id for share;
      if v_batch.id is null
         or v_batch.status <> 'active'
         or v_batch.expires_at <= clock_timestamp()
         or v_batch.intended_operation_type <> 'reissue'
         or v_batch.created_by_auth_user_id is distinct from (v_reservation.op).requested_by_auth_user_id
         or v_batch.created_by_profile_id is distinct from (v_reservation.op).requested_by_profile_id
      then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
        where id = (v_reservation.op).id;
        v_result.outcome := 'bulk_batch_unavailable';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end if;

    select * into v_app from public.applications where id = p_application_id for update;
    if v_app.id is null or v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    select * into v_current_active from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id is null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
      where id = (v_reservation.op).id;
      v_result.outcome := 'no_active_credential';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id <> (v_reservation.op).expected_current_credential_id then
      v_transition_now := clock_timestamp();
      -- CORRECTED this round: terminal_related_credential_id is permitted
      -- ONLY for 'active_credential_already_exists' by the approved
      -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
      -- (§1.7) — it must remain null for 'expected_credential_changed',
      -- and the returned result carries only the stable outcome name, no
      -- credential_id/status/issued_at. The same narrow correction was
      -- applied to finalize_qr_reissue_for_server and every other
      -- occurrence of this exact pattern this same round.
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
          terminal_related_credential_id = null
      where id = (v_reservation.op).id;
      v_result.outcome := 'expected_credential_changed';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- ===================== 'no_existing_operation' path =====================
  -- (also reached for an 'other_pending_candidate' just terminalized
  -- above, which falls through here identically.)
  --
  -- Authoritative processing order:
  --   1. create or reuse the durable lifecycle operation through the
  --      approved request-key protocol (already done above).
  --   2. lock and validate the bulk batch when applicable.
  --   3. lock the target application.
  --   4. lock/query the current active credential.
  --   5. capture a fresh timestamp.
  --   6. TTL precedence after every required lock.
  --   7. if the requester is no longer authorized, cancel with
  --      requester_no_longer_authorized.
  --   8. if the bulk batch is unavailable, cancel with
  --      bulk_batch_unavailable.
  --   9. if the application is missing or no longer accepted, cancel with
  --      application_ineligible.
  --  10. if no active credential exists, cancel with no_active_credential.
  --  11. if the active credential differs from expected, cancel with
  --      expected_credential_changed.
  --  12. otherwise return reserved.
  v_created_at := clock_timestamp();
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
    ) values (
      'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
      p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
      v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = p_application_id and operation_type = 'reissue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_app from public.applications where id = p_application_id;
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_staff_reissue_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  -- Step 2: lock and validate the bulk batch, only for staff_bulk —
  -- position 4, BEFORE the application lock (position 5).
  if v_channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = p_bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from auth.uid()
       or v_batch.created_by_profile_id is distinct from v_caller.id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_operation_id;
      v_result.outcome := 'bulk_batch_unavailable';
      v_result.operation_id := v_operation_id;
      return v_result;
    end if;
  end if;

  -- Step 3: lock the target application — position 5.
  select * into v_app from public.applications where id = p_application_id for update;

  -- Step 4: credential lock — position 6. No authoritative pre-read of
  -- the current credential occurs anywhere above this line.
  select * into v_current_active from public.qr_credentials
    where application_id = p_application_id and status = 'active' for update;

  -- Step 5: fresh timestamp, captured only after every lock above.
  v_check_now := clock_timestamp();

  -- Step 6: TTL, checked first — expiry wins over every finding below.
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 7: requester authorization, re-verified under the full lock
  -- set.
  if v_caller.role not in ('super_admin', 'program_attendance_manager') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = v_operation_id;
    v_result.outcome := 'requester_no_longer_authorized';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 8: bulk-batch availability was already fully validated at Step
  -- 2, above, BEFORE the application lock — restated here only as the
  -- corresponding numbered step, no further action.

  -- Step 9: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 10: active-credential existence.
  if v_current_active.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = v_operation_id;
    v_result.outcome := 'no_active_credential';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 11: expected-credential match. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here, and the returned result carries
  -- only the stable outcome name, no credential_id/status/issued_at.
  if v_current_active.id <> p_expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_operation_id;
    v_result.outcome := 'expected_credential_changed';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 12: every check has passed — the pending row remains genuinely
  -- reserved. The currently active credential remains completely
  -- unchanged. Credential creation/revocation/replacement/encryption/
  -- display belongs only to the future reissue finalizer, never this
  -- reservation RPC — including replaced_by, which the finalizer alone
  -- writes on the OLD credential, set to the staff profile that
  -- ultimately finalizes the reissue (not necessarily this reservation's
  -- own requester, since reservation and finalization are two separate
  -- steps, matching every other RPC pair in this design).
  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_staff_qr_reissue_transactional_internal(uuid, uuid, uuid, text, text, uuid, interval) from public;
-- No grant to authenticated/anon — reachable only through the public
-- wrapper below and a future test-only short-TTL wrapper, both of which
-- fix or otherwise control p_pending_ttl.

-- Public, authenticated-facing wrapper — the ONLY entry point exposed to
-- real staff users for force-reissue. TTL is hardcoded at 5 minutes,
-- identical to every other approved reservation RPC; no caller, however
-- privileged, can pass a different value through this signature.
create function public.request_staff_qr_reissue_transactional(
  p_request_key uuid,
  p_application_id uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_bulk_batch_id uuid default null
) returns public.qr_credential_lifecycle_result
language sql security definer set search_path = public, pg_temp as $$
  select public.request_staff_qr_reissue_transactional_internal(
    p_request_key, p_application_id, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note, p_bulk_batch_id,
    interval '5 minutes'
  );
$$;

revoke all on function public.request_staff_qr_reissue_transactional(uuid, uuid, uuid, text, text, uuid) from public;
grant execute on function public.request_staff_qr_reissue_transactional(uuid, uuid, uuid, text, text, uuid) to authenticated;

-- TEST-ONLY short-TTL wrapper — belongs in this suite's own test-only
-- setup SQL, NOT in this production migration surface. Documented here
-- as the exact shape used once written.
--
--   create function public.test_only_request_staff_qr_reissue_short_ttl(
--     p_request_key uuid,
--     p_application_id uuid,
--     p_expected_current_credential_id uuid,
--     p_reissue_reason_code text,
--     p_reissue_note text,
--     p_bulk_batch_id uuid,
--     p_pending_ttl interval,
--     p_waiter_tag text
--   ) returns public.qr_credential_lifecycle_result
--   language plpgsql security definer set search_path = public, pg_temp as $$
--   declare
--     v_result public.qr_credential_lifecycle_result;
--   begin
--     if p_waiter_tag is null or trim(p_waiter_tag) = '' then
--       raise exception 'test_only_request_staff_qr_reissue_short_ttl: p_waiter_tag is required';
--     end if;
--     perform set_config('application_name', p_waiter_tag, true);
--     select * into v_result from public.request_staff_qr_reissue_transactional_internal(
--       p_request_key, p_application_id, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note, p_bulk_batch_id, p_pending_ttl
--     );
--     return v_result;
--   end;
--   $$;
--
--   revoke all on function public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text)
--     from public, anon, service_role;
--   grant execute on function public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text)
--     to authenticated;
--
-- Teardown: drop function if exists public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text);

-- ================= FINALIZATION — issuance (service-role only) — APPROVED =================
-- SUB-PASS 2, this round's addition. Consumes a 'pending' issuance
-- operation (participant self-service, staff individual, or staff bulk —
-- all three approved reservation RPCs share this ONE finalizer, since
-- nothing about finalization differs by channel except which
-- issuance_channel/issuance_reason_code/issuance_note values the
-- operation itself already carries, durably, from reservation time) and
-- performs the actual `qr_credentials` write — the step no reservation
-- RPC is permitted to perform. `service_role`-only: no `authenticated`,
-- `anon`, participant, or staff browser session can ever call this
-- directly; Node's server-side code is the only caller, using the
-- `service_role` client, only after a reservation RPC has already
-- returned `outcome = 'reserved'` and only after Node has itself
-- generated the credential UUID and encrypted the token client-side of
-- the database trust boundary (§5.1's own opening rationale — the
-- database can never verify a client-supplied ciphertext's GCM
-- authentication tag, so cryptographic material is generated ONLY here,
-- server-side, after reservation succeeds, never accepted from any
-- browser session at any point in this whole design).
--
-- ONE approved signature — no overload. Every input is either an opaque
-- identifier (operation id, credential id) or already-encrypted/hashed
-- material (token hash, ciphertext) — never plaintext, never a key,
-- never a nonce, never a fingerprint. The function computes its own
-- fingerprint internally and never returns it.
--
-- Lock order (CORRECTED this round — five positions, was incorrectly four):
--   1. lifecycle operation row, FOR UPDATE — locked and inspected FIRST,
--      before any other row; the operation is the authoritative
--      idempotency record, not qr_credentials. An EARLY TTL check runs
--      immediately after this lock (see the two-stage TTL note below) —
--      an already-expired operation returns before any further lock is
--      ever taken.
--   2. durable bulk-batch row, FOR SHARE, ONLY when channel = 'staff_bulk'
--      — locked immediately after the operation lock (and the early TTL
--      check), BEFORE the application lock. CORRECTED this round: the
--      previous version of this function took this FOR SHARE lock much
--      later (after BOTH the application FOR UPDATE and the credential
--      FOR UPDATE locks were already held, and after the authoritative
--      v_now timestamp had already been captured) — a plain, late batch
--      read does not protect the finalization decision from a real race:
--      (1) finalizer reads the batch as active late in its own flow;
--      (2) a concurrent transaction cancels or completes that SAME batch
--      in between the read and this function's own commit; (3) this
--      finalizer proceeds to issue a credential authorized by a batch
--      that is no longer valid by the time the transaction actually
--      commits. Taking FOR SHARE on the batch row EARLY — immediately
--      after the operation lock, in this exact position — and holding it
--      for the REMAINDER of the transaction closes this: any concurrent
--      transaction attempting to transition the batch to 'completed'/
--      'cancelled' (both of which require locking the row for their own
--      UPDATE) now blocks behind this finalizer's FOR SHARE hold until
--      this transaction commits or rolls back, so the batch is
--      GUARANTEED to remain in the exact state this finalizer observed
--      for the entire remaining duration of the finalization — never
--      merely "was valid at the moment of an early, unprotected read."
--      Locking the batch here does NOT mean its business outcome
--      (bulk_batch_unavailable) is decided here — the DECISION precedence
--      (TTL -> application -> requester-authorization -> batch ->
--      credential-conflict, restated in the function body below) is
--      independent of lock order and remains exactly as previously
--      approved; only the LOCK itself moves earlier, to close the race.
--   3. application row, FOR UPDATE — reached for every genuinely
--      'pending' operation still unexpired after the early TTL check
--      (for staff_bulk, the batch is already locked by this point, but
--      not yet evaluated for validity).
--   4. current active credential row, FOR UPDATE — same application-
--      scoped active-credential lock every reservation RPC already uses.
--   5. selected encryption-key registry row, FOR SHARE — via
--      is_encryption_key_version_active(), which itself takes this exact
--      lock (§1.6, corrected in an earlier round to close the unlocked-
--      read race); not re-implemented here, reused as the single source
--      of truth for "is this key version currently active" everywhere in
--      this design.
-- No row is ever locked before the lifecycle operation; no authoritative
-- batch/application/credential/key state is ever read before its own
-- corresponding lock in this exact order. This preserves the already-
-- approved RELATIVE lock order used by every reservation RPC: operation
-- before batch, and batch before application and credential.
--
-- TWO-STAGE TTL CHECK: an EARLY check runs immediately after the
-- operation lock (position 1), before any further lock is taken — an
-- already-expired operation never touches the batch/application/
-- credential locks at all. A SECOND, authoritative recheck runs again
-- after every required lock (through position 4) is held, since this
-- call's own wait on those locks can itself consume enough time for the
-- operation to expire in between the two checks. The second check is the
-- one that actually governs decision precedence — it remains decision 1
-- of 5, still winning over every other business outcome, exactly as
-- previously approved.
create function public.finalize_qr_issuance_for_server(
  p_operation_id uuid,
  p_credential_id uuid,
  p_token_hash bytea,
  p_token_ciphertext bytea,
  p_token_version smallint,
  p_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_key_is_active boolean;
  v_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_existing_credential public.qr_credentials;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Input-shape validation BEFORE any lock is taken — malformed input is
  -- rejected as an exception, never represented as a lifecycle-result
  -- outcome, exactly mirroring every reservation RPC's own discipline.
  if p_operation_id is null then raise exception 'operation_id is required'; end if;
  if p_credential_id is null then raise exception 'credential_id is required'; end if;
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'token_hash must be exactly 32 bytes';
  end if;
  if p_token_ciphertext is null or octet_length(p_token_ciphertext) <> 61 then
    raise exception 'token_ciphertext must be exactly 61 bytes';
  end if;
  if get_byte(p_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  if p_token_version is null or p_token_version not between 1 and 32767 then
    raise exception 'Invalid token_version';
  end if;
  if p_encryption_key_version is null or p_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid encryption_key_version';
  end if;

  -- Position 1: lifecycle operation row, FOR UPDATE, locked and
  -- inspected FIRST, before any other row.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Lifecycle operation not found'; end if;

  -- Historical states handled FIRST, before any further lock —
  -- 'consumed'/'expired'/'cancelled' are all fully resolved by the
  -- operation row alone.
  if v_op.status = 'consumed' then
    -- Idempotent replay: recompute the SAME canonical fingerprint from
    -- THIS call's supplied inputs and compare against the durably stored
    -- one — never re-derived from the current qr_credentials row.
    -- CORRECTED this round: the replayed result itself must ALSO never be
    -- derived from the current qr_credentials row — a resulting credential
    -- may later become revoked or replaced, and exact finalizer replay
    -- must not change because of that later lifecycle transition. Every
    -- field returned here comes exclusively from the durable
    -- qr_lifecycle_operations row: credential_id from
    -- resulting_credential_id, status hardcoded to 'active' (the state at
    -- the successful finalization transition, never re-queried), and
    -- issued_at from finalized_at (guaranteed equal to the credential's
    -- own issued_at at the moment of that same transition). This branch
    -- no longer depends on the resulting credential row still being
    -- queryable, its current status, its ciphertext, its current
    -- encryption-key version, or any later revocation/replacement field.
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
    );
    if v_fingerprint = v_op.finalization_fingerprint and p_credential_id = v_op.resulting_credential_id then
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_op.resulting_credential_id;
      v_result.status := 'active';
      v_result.issued_at := v_op.finalized_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  if v_op.status = 'expired' then
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if v_op.status = 'cancelled' then
    -- Replay the durable terminal outcome without re-evaluating current
    -- state — identical discipline to every reservation RPC's own
    -- replay_cancelled path.
    v_result.outcome := v_op.terminal_reason_code;
    if v_op.terminal_reason_code = 'active_credential_already_exists' then
      select * into v_existing_credential from public.qr_credentials where id = v_op.terminal_related_credential_id;
      v_result.credential_id := v_existing_credential.id;
      v_result.status := v_existing_credential.status;
      v_result.issued_at := v_existing_credential.issued_at;
    end if;
    return v_result;
  end if;

  if v_op.status <> 'pending' then
    -- Unsupported/unknown status — never guess. Same safe conflict
    -- outcome finalizers already use for an unrecognized state.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Pending-operation shape checks: this finalizer handles ISSUANCE
  -- only. A reissue operation reaching this function would be a caller
  -- bug (Node calling the wrong finalizer for the operation's own
  -- recorded type) — rejected as an exception, not a lifecycle outcome,
  -- since it can never legitimately happen through the approved
  -- Node-side flow.
  if v_op.operation_type <> 'issue' then
    raise exception 'finalize_qr_issuance_for_server called for a non-issue operation';
  end if;
  if v_op.expected_current_credential_id is not null then
    raise exception 'issuance operation unexpectedly carries a non-null expected_current_credential_id';
  end if;
  if v_op.channel not in ('participant_self_service', 'staff_individual', 'staff_bulk') then
    raise exception 'issuance operation carries an unrecognized channel';
  end if;
  if v_op.application_id is null or v_op.requested_by_auth_user_id is null then
    raise exception 'issuance operation is missing required durable requester/application information';
  end if;
  -- Channel/batch-binding consistency: never silently ignore an
  -- unexpected combination. staff_bulk MUST carry a non-null
  -- bulk_batch_id; every other channel MUST carry a null one — exactly
  -- mirroring qr_lifecycle_operations_bulk_batch_matches_channel's own
  -- invariant, restated here as a controlled internal-invariant check
  -- rather than trusted blindly (a row reaching this function that
  -- somehow violates its own table constraint would indicate a real bug
  -- elsewhere, not a business outcome to guess about).
  if v_op.channel = 'staff_bulk' and v_op.bulk_batch_id is null then
    raise exception 'staff_bulk issuance operation is missing its required bulk_batch_id';
  end if;
  if v_op.channel <> 'staff_bulk' and v_op.bulk_batch_id is not null then
    raise exception 'non-staff_bulk issuance operation unexpectedly carries a bulk_batch_id';
  end if;

  -- TWO-STAGE TTL CHECK (this round's correction, alongside the batch-
  -- lock reordering below): an EARLY check, immediately after the
  -- operation lock, avoids taking any further lock (batch, application,
  -- credential) for an operation that is already expired — no reason to
  -- lock rows this call will never touch. This does NOT replace the
  -- authoritative recheck after every required lock is held (below) —
  -- clock_timestamp() can advance arbitrarily far while THIS call itself
  -- waits on the batch/application/credential locks, so the operation
  -- could still expire during that wait even though this early check
  -- passed.
  if v_op.expires_at <= clock_timestamp() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_transition_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Position 2: durable bulk-batch row, FOR SHARE, ONLY for staff_bulk —
  -- locked immediately after the operation lock (and the early TTL
  -- check, which takes no lock of its own), BEFORE the application lock,
  -- and held for the remainder of this transaction (never released
  -- early) so a concurrent batch completion/cancellation is blocked
  -- until this finalization commits or rolls back. No pre-lock read of
  -- authoritative batch state occurs anywhere above this line. The batch
  -- row is selected and locked here, but NO business outcome
  -- (bulk_batch_unavailable or otherwise) is returned yet — every
  -- pending-path business decision, including this one, is evaluated
  -- together, in the approved TTL-first order, only after every required
  -- lock (batch, application, credential) is held.
  if v_op.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = v_op.bulk_batch_id for share;
  end if;

  -- Position 3: application row, FOR UPDATE.
  select * into v_app from public.applications where id = v_op.application_id for update;

  -- Position 4: current active credential row, FOR UPDATE.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;

  -- Position 5: encryption-key registry row, FOR SHARE, via the shared
  -- helper (which itself takes this exact lock). CORRECTED this round:
  -- the authoritative timestamp used for the TTL recheck and every
  -- pending-path decision was previously captured immediately after
  -- position 4 — BEFORE this lock — leaving a gap where the operation
  -- could expire while THIS call itself waited to acquire the
  -- key-registry row, and still be finalized/rejected using a stale
  -- pre-wait timestamp. The key-active result is stored here in
  -- v_key_is_active WITHOUT yet deciding anything; the authoritative
  -- v_now below is captured only AFTER this lock, and every decision —
  -- including the key-version-active outcome, now evaluated last in the
  -- approved precedence rather than the moment its lock is acquired — is
  -- made from that single, final timestamp. Identical narrow correction
  -- to the one applied to finalize_qr_reissue_for_server this same
  -- round; this genuine defect was discovered only after this
  -- function's own earlier static approval, and no other logic in this
  -- function is touched.
  v_key_is_active := public.is_encryption_key_version_active(p_encryption_key_version);

  -- ONE authoritative timestamp, captured only after every required lock
  -- (through position 5) is held — reused for every timestamp field this
  -- finalizer writes from here on, AND for the authoritative TTL
  -- recheck below, which must win over every other business decision
  -- (requester authorization, batch availability, application
  -- eligibility, credential conflict, key-version-active) exactly as the
  -- early check's own comment states: this call's own wait on every lock
  -- above may itself have taken long enough for the operation to expire
  -- since the early check passed.
  v_now := clock_timestamp();

  -- Decision 1: TTL, rechecked authoritatively now that every required
  -- lock is held.
  if v_op.expires_at <= v_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Decision 2: application eligibility. The batch row (for staff_bulk)
  -- was already locked at position 2 above, but its OWN business
  -- decision is evaluated later, at decision 4 below, preserving the
  -- exact approved precedence order (TTL -> application ->
  -- requester-authorization -> batch -> credential-conflict) — locking
  -- early (to close the race the batch could otherwise be mutated
  -- through) is independent of, and does not change, WHEN each decision
  -- is allowed to return a result.
  if v_app.id is null or v_app.status <> 'accepted' then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'application_ineligible'
    where id = v_op.id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Decision 3: staff-channel requester authorization, re-verified at
  -- finalization time — a staff member's role can lapse in the window
  -- between reservation and finalization, and the operation must not be
  -- finalized on their behalf once that has happened.
  if v_op.channel in ('staff_individual', 'staff_bulk') then
    select role into v_caller_role from public.profiles where id = v_op.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = v_op.id;
      v_result.outcome := 'requester_no_longer_authorized';
      return v_result;
    end if;
  end if;

  -- Decision 4: staff_bulk batch availability — the row was already
  -- locked at position 2, above (immediately after the operation lock,
  -- before the application/credential locks); this is simply the first
  -- point in the approved DECISION precedence at which a business
  -- outcome based on that already-held lock may be returned.
  if v_op.channel = 'staff_bulk' then
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= v_now
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from v_op.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from v_op.requested_by_profile_id
    then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_op.id;
      v_result.outcome := 'bulk_batch_unavailable';
      return v_result;
    end if;
  end if;

  -- Decision 5: active-credential conflict — never create a second
  -- active credential for the same application.
  if v_current_active.id is not null then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_current_active.id
    where id = v_op.id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    return v_result;
  end if;

  -- Decision 6: encryption-key version active state — the lock was
  -- already acquired at position 5, above; the result computed there
  -- (v_key_is_active) is evaluated LAST among all pending-path
  -- validations, per the approved order — a missing, decrypt_only, or
  -- retired key is the one RETRYABLE outcome: the operation remains
  -- pending, never cancelled/expired/consumed, since Node can simply
  -- re-fetch the current active key version and retry with fresh crypto
  -- material against this SAME operation before its TTL elapses.
  if not v_key_is_active then
    v_result.outcome := 'key_version_not_active';
    return v_result; -- operation remains pending, untouched
  end if;

  -- Canonical fingerprint, computed ONLY through the shared helper — no
  -- ad-hoc format. Domain-separated for issuance
  -- ('rcoy:qr-finalization:v1' + 'issue'), binding credential id, token
  -- hash, token version, encryption-key version, and a digest of the
  -- ciphertext envelope.
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
  );

  -- The credential insert, lifecycle consumed-transition, and success
  -- audit insert are atomic: all three happen inside this one inner
  -- exception block, and either all commit together or (on any
  -- exception, including a caught unique_violation re-raised as a
  -- controlled outcome) all roll back together, leaving the operation's
  -- OUTER row lock (acquired at position 1, still held across this whole
  -- function) available so the function can still return a controlled,
  -- safe result even when the insert itself fails. The lifecycle
  -- operation is never marked consumed before the credential row, its
  -- fingerprint, and every success invariant have already been
  -- persisted.
  begin
    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, token_version, encryption_key_version,
      status, issuance_channel, issuance_reason_code, issuance_note,
      issued_at, created_at, issued_by
    ) values (
      p_credential_id, v_op.application_id, p_token_hash, p_token_ciphertext, p_token_version, p_encryption_key_version,
      'active', v_op.channel, v_op.reason_code, v_op.note,
      v_now, v_now,
      -- Actor semantics: participant_self_service -> null; staff_individual/
      -- staff_bulk -> the operation's own durable requested_by_profile_id
      -- (never the service-role identity, never re-resolved from
      -- auth.uid() — there is no authenticated client session inside this
      -- SECURITY DEFINER, service-role-only function; the ONLY trustworthy
      -- staff actor identity available here is the one the reservation RPC
      -- already durably recorded).
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    );

    update public.qr_lifecycle_operations
    set status = 'consumed', consumed_at = v_now, finalized_at = v_now,
        resulting_credential_id = p_credential_id, finalization_fingerprint = v_fingerprint,
        terminal_reason_code = null, terminal_related_credential_id = null, terminal_retry_after_at = null
    where id = v_op.id;

    -- Safe metadata only — never token hash, ciphertext, nonce, key
    -- material, or fingerprint.
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', p_credential_id, 'issued',
      case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end,
      case when v_op.channel = 'participant_self_service' then v_op.requested_by_auth_user_id else v_op.requested_by_profile_id end,
      jsonb_build_object('application_id', v_op.application_id, 'issuance_channel', v_op.channel, 'issuance_reason_code', v_op.reason_code),
      v_now
    );
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting_credential public.qr_credentials;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'qr_credentials_token_hash_unique' then
          -- The token hash already belongs to a DIFFERENT, already-
          -- inserted credential row — a Node-side random-generation
          -- collision or a genuine concurrent-finalizer race on the same
          -- hash. The operation remains pending (retryable with fresh
          -- input); no partial credential, no success audit row (this
          -- whole block rolled back together).
          v_result.outcome := 'token_hash_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_pkey' then
          -- p_credential_id collides with an existing row belonging to a
          -- DIFFERENT operation entirely (this operation's own resulting_
          -- credential_id is still null at this point in the flow, since
          -- the UPDATE above never committed) — resolve safely rather
          -- than expose the raw violation.
          select * into v_conflicting_credential from public.qr_credentials where id = p_credential_id;
          if v_conflicting_credential.id is not null and v_conflicting_credential.status = 'active'
             and v_conflicting_credential.application_id = v_op.application_id then
            -- The conflicting row IS this exact application's active
            -- credential — safe to resolve as the same controlled
            -- conflict outcome the pre-lock check above would have
            -- produced, identifying the credential rather than exposing
            -- a raw error.
            v_result.outcome := 'active_credential_already_exists';
            v_result.credential_id := v_conflicting_credential.id;
            v_result.status := v_conflicting_credential.status;
            v_result.issued_at := v_conflicting_credential.issued_at;
            return v_result;
          end if;
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_lifecycle_operations_resulting_credential_unique_idx' then
          -- p_credential_id is already recorded as the RESULT of a
          -- different lifecycle operation — never legitimate for a fresh
          -- issuance.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        else
          raise;
        end if;
      end;
  end;

  v_result.outcome := 'issued';
  v_result.credential_id := p_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint) from public, anon, authenticated;
grant execute on function public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint) to service_role;

**SUPERSEDED — kept only for historical reference, do not implement as written.** The section
immediately below (through the finalization heading) is the pre-`request_key`, pre-Sub-pass-2
draft. It is retained verbatim rather than deleted so the corrections history stays legible, but
every SQL body in it is stale — see this section's own opening note above for the exact
enumerated differences. The approved staff issuance reservation is the
`request_staff_qr_issuance_transactional`/`request_staff_qr_issuance_transactional_internal`/
`resolve_blocking_qr_lifecycle_staff_issuance_operation` trio above. The approved staff reissue
reservation is the `request_staff_qr_reissue_transactional`/
`request_staff_qr_reissue_transactional_internal`/
`resolve_blocking_qr_lifecycle_staff_reissue_operation` trio immediately above this marker.

-- ================= RESERVATION (staff individual/bulk) =================
-- Signature corrected (point 6): p_bulk_batch_id moved to the END of the
-- parameter list — PostgreSQL requires every parameter after the first
-- one with a DEFAULT to also have a default.
--
-- CORRECTED this round: lock order. The previous draft locked the bulk
-- batch (FOR SHARE) BEFORE calling reserve_or_reuse — which acquires the
-- advisory lock and the operation-row lock — inverting the documented
-- global order (advisory -> operation -> bulk batch -> application ->
-- credential) and creating a deadlock window against a concurrent
-- finalizer/reservation touching the same batch and operation in the
-- opposite order. The batch's row lock is now taken AFTER reserve_or_reuse
-- returns, and BEFORE the application lock — this requires validating
-- everything about the batch EXCEPT its row-lock-dependent state
-- (existence, ownership, expiry, type) in two passes: a null-check only
-- (to decide v_channel for the reservation-intent match, which does not
-- require the row to be locked yet), then the full FOR SHARE
-- validation afterward, in its correct position in the lock order.
create function public.request_staff_qr_issuance_transactional(
  p_application_id uuid,
  p_issuance_reason_code text,
  p_issuance_note text,
  p_bulk_batch_id uuid default null
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_batch public.qr_bulk_operation_batches;
  v_app public.applications;
  v_existing_credential public.qr_credentials;
  v_reservation record;
  v_channel text;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin','program_attendance_manager') then
    raise exception 'Not authorized';
  end if;
  if p_issuance_note is not null and char_length(p_issuance_note) > 500 then
    raise exception 'Issuance note too long';
  end if;
  if p_issuance_reason_code is null or p_issuance_reason_code not in (
    'advance_badge_printing', 'participant_not_logged_in', 'bulk_event_preparation', 'staff_other'
  ) then
    raise exception 'A valid staff issuance reason code is required';
  end if;
  if p_issuance_reason_code = 'staff_other' and (p_issuance_note is null or trim(p_issuance_note) = '') then
    raise exception 'A note is required when issuance reason is staff_other';
  end if;

  -- Phase 1: cheap, lock-free channel derivation for the reservation
  -- intent-match only — does NOT validate the batch row's live state.
  v_channel := case when p_bulk_batch_id is null then 'staff_individual' else 'staff_bulk' end;

  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'issue', p_application_id, auth.uid(), v_channel, p_bulk_batch_id,
    p_issuance_reason_code, p_issuance_note, null
  );
  if v_reservation.state = 'intent_conflict' then
    v_result.outcome := 'pending_operation_conflict';
    return v_result;
  end if;

  -- Phase 2: full bulk-batch validation, FOR SHARE, now correctly
  -- positioned AFTER the advisory + operation locks and BEFORE the
  -- application lock, per the global order. Status must be 'active', not
  -- merely "exists and is recent"; expires_at is checked against DATABASE
  -- time; the batch must belong to THIS caller's own profile AND
  -- auth-user id; intended_operation_type must match ('issue').
  if p_bulk_batch_id is not null then
    select * into v_batch from public.qr_bulk_operation_batches where id = p_bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= now()
       or v_batch.created_by_profile_id is distinct from v_caller.id
       or v_batch.created_by_auth_user_id is distinct from auth.uid()
       or v_batch.intended_operation_type <> 'issue'
    then
      raise exception 'Invalid, expired, or mismatched bulk batch id';
    end if;
  end if;

  -- Lock the application and revalidate current state UNCONDITIONALLY.
  select * into v_app from public.applications where id = p_application_id for update;
  if v_app.id is null then raise exception 'Application not found'; end if;

  if v_app.status <> 'accepted' then
    if v_reservation.state = 'exact_match' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      return v_result;
    end if;
    raise exception 'Application is not accepted';
  end if;

  select * into v_existing_credential from public.qr_credentials
    where application_id = p_application_id and status = 'active';
  if v_existing_credential.id is not null then
    if v_reservation.state = 'exact_match' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists'
      where id = (v_reservation.op).id;
    end if;
    v_result.outcome := 'already_active';
    v_result.credential_id := v_existing_credential.id;
    v_result.status := v_existing_credential.status;
    v_result.issued_at := v_existing_credential.issued_at;
    return v_result;
  end if;

  if v_reservation.state = 'exact_match' then
    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  v_created_at := clock_timestamp();
  insert into public.qr_lifecycle_operations (
    operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
    channel, bulk_batch_id, reason_code, note, created_at, expires_at
  ) values (
    'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
    p_issuance_reason_code, p_issuance_note, v_created_at, v_created_at + interval '5 minutes'
  ) returning id into v_operation_id;

  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_staff_qr_issuance_transactional(uuid, text, text, uuid) from public;
grant execute on function public.request_staff_qr_issuance_transactional(uuid, text, text, uuid) to authenticated;

-- ================= FINALIZATION (service-role only) =================
-- Idempotency ordering: the lifecycle OPERATION row — not qr_credentials —
-- is the authoritative idempotency record, locked and inspected FIRST.
--
-- CORRECTED this round on four independent points:
-- (point 2) No path may UPDATE a row and then RAISE EXCEPTION. Every
-- terminal transition is followed by a plain RETURN, never a RAISE.
-- (point 4) The application row is locked FOR UPDATE — the serialization
-- point for first issuance, since no credential row exists yet to lock.
-- (point 8) Credential-id/token-hash races are now closed with BOTH a
-- pre-insert check (fast path, no exception in the common case) AND an
-- inner EXCEPTION WHEN unique_violation block around the actual INSERT
-- (correctness backstop: two finalizers racing on the SAME token_hash —
-- cryptographically near-impossible but not proof-free — could both pass
-- the pre-check before either commits). No raw unique-violation escapes
-- to the caller; the operation is left pending (retryable) whenever the
-- conflict is with a DIFFERENT operation's row, since that is a
-- Node-side/random-generation bug the caller can retry with fresh input.
-- (finalization_fingerprint) Idempotent-replay correctness for 'consumed'
-- operations is now decided by comparing a stored 32-byte fingerprint —
-- computed here from the resulting credential id, token hash, token
-- version, encryption-key version AT FINALIZATION TIME, and a SHA-256
-- digest of the ciphertext envelope — rather than by re-reading
-- qr_credentials.encryption_key_version from the CURRENT row state, which
-- is nulled out the moment that credential is later replaced or revoked
-- (§1.2) and would silently break already_finalized for a legitimately
-- delayed retry arriving after that later lifecycle transition.
-- CORRECTED this round, two additional points beyond the above:
-- fingerprint computation now goes through the shared
-- compute_qr_finalization_fingerprint helper (§5.0a) — canonical binary
-- encoding, schema-qualified pgcrypto, identical code path for both the
-- initial write and the consumed-replay comparison, never two
-- independently-maintained implementations. The unique_violation handler
-- now inspects GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME and maps each
-- of this table's actual named constraints to its own controlled outcome
-- — a blanket "any unique_violation means token_hash_conflict" was wrong,
-- since qr_credentials has FOUR unique constraints/indexes
-- (qr_credentials_pkey, qr_credentials_token_hash_unique,
-- qr_credentials_one_active_per_application,
-- qr_credentials_replacement_target_unique), each with a different true
-- meaning; an unrecognized constraint name re-raises rather than silently
-- mis-reporting.
create function public.finalize_qr_issuance_for_server(
  p_operation_id uuid,
  p_credential_id uuid,          -- generated by Node
  p_token_hash bytea,
  p_token_ciphertext bytea,
  p_token_version smallint,
  p_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_resulting_credential public.qr_credentials;
  v_app public.applications;
  v_key_row public.qr_encryption_key_registry;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_constraint_name text;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Step 1: lock the lifecycle operation FIRST — nothing else happens before this.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Operation not found'; end if;
  if v_op.operation_type <> 'issue' then raise exception 'Operation is not an issuance operation'; end if;

  v_check_now := clock_timestamp();

  -- Step 2/3: inspect status and resulting credential BEFORE anything else,
  -- using the stored finalization_fingerprint — never the current
  -- qr_credentials row's mutable fields.
  if v_op.status = 'consumed' then
    if p_credential_id is null or p_token_hash is null or octet_length(p_token_hash) <> 32
       or p_token_version is null or p_encryption_key_version is null
       or p_token_ciphertext is null then
      v_result.outcome := 'idempotency_conflict';
      return v_result;
    end if;
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
    );
    if v_op.resulting_credential_id = p_credential_id and v_op.finalization_fingerprint = v_fingerprint then
      select * into v_resulting_credential from public.qr_credentials where id = v_op.resulting_credential_id;
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_resulting_credential.id;
      v_result.status := v_resulting_credential.status;
      v_result.issued_at := v_resulting_credential.issued_at;
      return v_result; -- safe replay, proven from the OPERATION's own stored fingerprint
    end if;
    -- Consumed, but the retry's input doesn't match what was actually
    -- finalized for this operation — reject, never guess.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Step 4: expired/cancelled/anything-but-pending are terminal-already;
  -- report and RETURN, never raise after.
  if v_op.status in ('expired', 'cancelled') then
    v_result.outcome := case v_op.status when 'expired' then 'operation_expired' else 'operation_cancelled' end;
    return v_result;
  end if;
  if v_op.status <> 'pending' then
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;
  if v_op.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_operation_id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if p_credential_id is null then raise exception 'Credential id is required'; end if;

  -- crypto input shape, validated against the now-confirmed-pending operation.
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'Invalid token hash';
  end if;
  if p_token_version is null or p_token_version <> 1 then
    raise exception 'Unsupported token version';
  end if;
  if p_token_ciphertext is null or octet_length(p_token_ciphertext) <> 61 then
    raise exception 'Invalid or malformed ciphertext envelope';
  end if;
  if get_byte(p_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  -- Fast-path pre-check — not a correctness guarantee on its own (see the
  -- EXCEPTION block around the INSERT below for that), but avoids paying
  -- the exception-handling cost in the common case.
  if exists (select 1 from public.qr_credentials where id = p_credential_id) then
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;
  if exists (select 1 from public.qr_credentials where token_hash = p_token_hash) then
    v_result.outcome := 'token_hash_conflict';
    return v_result;
  end if;

  -- Step 5: lock the application row itself — the serialization point for
  -- first issuance, since no credential row exists yet to lock instead.
  select * into v_app from public.applications where id = v_op.application_id for update;
  if v_app.id is null or v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_operation_id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  if exists (select 1 from public.qr_credentials where application_id = v_op.application_id and status = 'active') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists'
    where id = p_operation_id;
    v_result.outcome := 'already_active';
    return v_result;
  end if;

  -- Step 7: lock the selected key-registry row FOR SHARE, THEN re-check
  -- status = 'active' after the lock is held. RETRYABLE: the operation
  -- is left PENDING, unchanged.
  select * into v_key_row from public.qr_encryption_key_registry
    where key_version = p_encryption_key_version for share;
  if v_key_row.id is null or v_key_row.status <> 'active' then
    v_result.outcome := 'key_version_not_active';
    return v_result;
  end if;

  -- v_transition_now is captured only now, AFTER every required lock
  -- (operation, application, key-registry) is held.
  v_transition_now := clock_timestamp();
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
  );

  -- Named-constraint-aware race backstop.
  begin
    -- CORRECTED this round: created_at was previously omitted from this
    -- column list, leaving it to the table's own independent `default
    -- now()` — a second clock read from v_transition_now that would almost
    -- never be bit-identical to issued_at, violating §1.5's new
    -- created_at = issued_at trigger invariant on every finalized insert.
    -- Passing v_transition_now explicitly for both columns guarantees they
    -- agree exactly.
    insert into public.qr_credentials (
      id, application_id, token_version, token_hash, token_ciphertext, encryption_key_version,
      status, issuance_channel, issued_by, issuance_reason_code, issuance_note, issued_at, created_at
    ) values (
      p_credential_id, v_op.application_id, p_token_version, p_token_hash, p_token_ciphertext,
      p_encryption_key_version, 'active', v_op.channel,
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end,
      v_op.reason_code, v_op.note, v_transition_now, v_transition_now
    );
  exception
    when unique_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      case v_constraint_name
        when 'qr_credentials_pkey' then
          v_result.outcome := 'idempotency_conflict';
        when 'qr_credentials_token_hash_unique' then
          v_result.outcome := 'token_hash_conflict';
        when 'qr_credentials_one_active_per_application' then
          -- A concurrent finalizer (or staff issuance racing this
          -- participant issuance) committed an active credential for this
          -- application between this function's own pre-check and its
          -- INSERT — a genuine concurrent-state race, not a caller bug.
          v_result.outcome := 'already_active';
        else
          -- qr_credentials_replacement_target_unique cannot fire on an
          -- INSERT with replaced_by_credential_id always null for a fresh
          -- issuance row; any other unique_violation here is unexpected —
          -- re-raise rather than mis-report it as a token-hash conflict.
          raise;
      end case;
      return v_result;
  end;

  insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
  values (
    'qr_credential', p_credential_id, 'issued',
    case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end,
    coalesce(v_op.requested_by_profile_id, v_op.requested_by_auth_user_id),
    jsonb_build_object('application_id', v_op.application_id, 'issuance_channel', v_op.channel),
    v_transition_now
  );

  update public.qr_lifecycle_operations
  set status = 'consumed', consumed_at = v_transition_now, finalized_at = v_transition_now,
      resulting_credential_id = p_credential_id, finalization_fingerprint = v_fingerprint
  where id = p_operation_id;

  v_result.outcome := 'issued';
  v_result.credential_id := p_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_transition_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_issuance_for_server(
  uuid, uuid, bytea, bytea, smallint, smallint
) from public;
grant execute on function public.finalize_qr_issuance_for_server(
  uuid, uuid, bytea, bytea, smallint, smallint
) to service_role;
```

**Full issuance flow (Node, trusted server-side code only):**
1. Call `request_my_qr_issuance_transactional()`/`request_staff_qr_issuance_transactional(...)`
   using the requester's authenticated session. If `outcome = 'active_credential_already_exists'`,
   skip straight to the redisplay path for `credential_id` — no token is ever generated. If
   `outcome = 'request_key_intent_conflict'` (corrected this round — the previous name,
   `pending_operation_conflict`, was never actually approved into the schema/vocabulary; see §5.2's
   own correction note), surface a controlled "you already have a different request in progress"
   message — never silently reuse an unrelated pending operation.
2. On `outcome = 'reserved'`: generate the credential UUID and 32 raw random bytes, compute the
   canonical hash, encrypt via the trusted AES-256-GCM module using the **current active** key
   version (fetched fresh, not cached, immediately before this step).
3. Call `finalize_qr_issuance_for_server(operation_id, credential_id, hash, ciphertext,
   token_version, key_version)` via the **service-role client**.
4. Return the QR payload to the caller only after this call returns `outcome = 'issued'` (or the
   idempotent `'already_finalized'` on a preserved retry). On `outcome = 'key_version_not_active'`
   — a retryable condition per §5's lock-order/outcome corrections — the operation remains
   `pending`; Node re-fetches the current active key version and repeats step 3, up to the
   operation's own 5-minute TTL, before surfacing a hard failure.

**Bulk issuance** first calls `create_qr_bulk_operation_batch_for_server(staff_auth_user_id,
staff_profile_id, 'issue')` (service-role only) once to obtain a `p_bulk_batch_id`, then loops
step 1 with that same `p_bulk_batch_id` once per application, then steps 2–4 per successful
reservation, then calls `complete_qr_bulk_operation_batch_for_server(p_bulk_batch_id)` once —
marking the batch `completed` so its id can never be reused for a later, unrelated call. The batch id
is what proves a `staff_bulk` channel label is genuine, per §1.6a.

### 5.2 Reissue — `request_my_qr_reissue_transactional` (participant self-service, APPROVED) / `request_staff_qr_reissue_transactional` (staff force-reissue, APPROVED) / `finalize_qr_reissue_for_server` (APPROVED)

**Approval note:** `request_my_qr_reissue_transactional`, `request_staff_qr_reissue_transactional`,
and `finalize_qr_reissue_for_server` below are the current approved reissue reservation and
finalization functions — extensions of the approved §5.1 issuance foundation
(`reserve_or_reuse_qr_lifecycle_operation`, the request_key/dual-advisory-lock protocol,
`qr_credential_lifecycle_result`, and — for the finalizer — the same two-stage TTL protocol and
five-position lock order approved for `finalize_qr_issuance_for_server`), not a redesign of any
of it. They supersede the older sketch that immediately follows this note (kept only for
historical reference — see the "SUPERSEDED" marker below); the old sketch predates `request_key`
entirely, used a since-abandoned `reserve_or_reuse_qr_lifecycle_operation` signature, used
outcome names (`pending_operation_conflict`, `stale_reissue_operation`, `cooldown_active`,
`daily_limit_reached`) that were never actually approved into the schema/vocabulary, and read
`qr_credentials.replaced_at` for rate-limiting — a column only the finalizer itself ever writes.
Both reissue reservation RPCs and the reissue finalizer are approved — every Phase 6 QR
issuance/reissue reservation and finalization function is now approved; only revocation,
scanning, QR redisplay, UI work, and Phase 7 remain unbuilt.

A reissue-specific blocker resolver (`resolve_blocking_qr_lifecycle_reissue_operation`) is
introduced alongside it — parameterized separately from `resolve_blocking_qr_lifecycle_operation`
because reissue's blocking-resolution decision tree is genuinely different: issuance treats an
existing active credential as the terminal conflict (`active_credential_already_exists`); reissue
treats a *missing* active credential as terminal (`no_active_credential`), and additionally
treats an active credential that no longer matches the operation's own
`expected_current_credential_id` as terminal (`expected_credential_changed`) — a comparison
issuance's resolver has no equivalent for, since issuance's `expected_current_credential_id` is
always `null` (`qr_lifecycle_operations_issue_has_no_expected_credential`).

```sql
-- SUB-PASS 2 — participant self-reissue reservation, this round's addition.
--
-- Reissue-specific blocker resolver. Takes an ALREADY-LOCKED candidate
-- reissue operation row (FOR UPDATE already held by the caller) and the
-- ALREADY-LOCKED application row, and resolves the candidate to exactly
-- one of two dispositions, mirroring resolve_blocking_qr_lifecycle_operation's
-- shape and correction discipline exactly, but with reissue's own decision
-- tree (§ "Reissue-specific blocker resolution" below, restated here):
--   1. application no longer accepted -> cancelled/application_ineligible
--      (no credential lock needed for this determination).
--   2. otherwise, lock the current active credential.
--   3. capture clock_timestamp() AFTER the credential lock.
--   4. if the candidate's own TTL has elapsed -> expired/ttl_expired.
--      Expiry wins over every credential-state finding below, exactly
--      mirroring the issuance resolver's "expiry wins" precedence.
--   5. if no active credential exists at all -> cancelled/no_active_credential.
--   6. if an active credential exists but its id is not the candidate's own
--      expected_current_credential_id -> cancelled/expected_credential_changed
--      (terminal_related_credential_id set to the credential actually
--      found active, for historically-stable replay — NOT the vanished
--      expected one, which by definition no longer exists as the active
--      row).
--   7. otherwise the candidate survives every terminal check and remains
--      genuinely blocking -> 'still_blocking'.
-- Cooldown/rate-limit are DELIBERATELY NOT evaluated here: those limits
-- apply only to a NEW request attempting to reserve, never retroactively
-- to an already-existing pending operation that was validly reserved
-- before the limit would have applied to it — an existing pending blocker
-- must never be terminalized "because a hypothetical new request would
-- have been rate-limited," since the blocker itself already passed its
-- own limit check at its own creation time.
create function public.resolve_blocking_qr_lifecycle_reissue_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- Credential lock BEFORE the TTL decision, matching the issuance
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- TTL checked immediately after the credential lock — expiry wins over
  -- any credential-state finding below.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  if v_existing_credential.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- CORRECTED this round: terminal_related_credential_id is permitted
  -- ONLY for 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null for 'expected_credential_changed'.
  if v_existing_credential.id <> p_candidate.expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

revoke all on function public.resolve_blocking_qr_lifecycle_reissue_operation(
  public.qr_lifecycle_operations, public.applications
) from public;
-- No grant to authenticated/anon — called only from within
-- request_my_qr_reissue_transactional_internal's own security-definer
-- body, which already holds every lock this function itself requires.

-- ================= RESERVATION (participant self-reissue) =================
-- Extends the approved §5.1 issuance foundation exactly — same
-- request_key/dual-advisory-lock protocol via reserve_or_reuse_qr_lifecycle_operation,
-- same split into a private internal implementation (accepts p_pending_ttl,
-- never exposed to authenticated/anon) and a thin public wrapper fixed at
-- 5 minutes, same insert-first-then-validate discipline for durable
-- first-request outcomes, same UPDATE-then-RETURN (never UPDATE-then-RAISE)
-- pattern for every terminal transition.
--
-- Global lock order (unchanged from issuance, restated for reissue):
--   1. request-key advisory lock (requester, operation_type, request_key)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   2. reservation-domain advisory lock (application_id, operation_type)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   3. lifecycle-operation row, by request_key or the domain's other
--      pending reissue operation — inside reserve_or_reuse_qr_lifecycle_operation.
--   4. bulk batch, where applicable — NOT applicable to participant
--      self-service (channel is always 'participant_self_service', which
--      qr_lifecycle_operations_bulk_batch_matches_channel forces
--      bulk_batch_id to null for).
--   5. application row, FOR UPDATE.
--   6. current active credential row, FOR UPDATE.
--   7. fresh clock_timestamp() and every authoritative TTL/cooldown/
--      rate-limit/business-rule decision, only after every lock above is
--      held.
--
-- Immutable reservation intent (compared field-for-field by
-- reserve_or_reuse_qr_lifecycle_operation's existing intent-match logic —
-- no changes needed there, since it already compares every one of these
-- fields generically): application_id, operation_type ('reissue'),
-- channel ('participant_self_service'), request_key, requested_by_auth_user_id
-- (auth.uid()), expected_current_credential_id, reason_code (the
-- participant reissue reason), note (normalized), bulk_batch_id (always
-- null for this channel).
create function public.request_my_qr_reissue_transactional_internal(
  p_request_key uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_application_id_candidate uuid;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_normalized_note text;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_retry_after_at timestamptz;
  v_consumed_at_values timestamptz[];
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_expected_current_credential_id is null then raise exception 'expected_current_credential_id is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  -- Reason-code/note validation, per §1.4's conditional rules for
  -- participant_self_service reissue: the code must be one of the six
  -- participant codes, never a staff code; 'participant_other' requires a
  -- non-empty trimmed note. This is deliberately a RAISED EXCEPTION, not a
  -- returned qr_credential_lifecycle_result outcome — malformed/invalid
  -- input never reaches the point of resolving the participant's
  -- application or creating an operation row (see the processing-order
  -- comment on the 'no_existing_operation' path below for the complete,
  -- authoritative list of what may fail before an operation exists).
  if p_reissue_reason_code is null or p_reissue_reason_code not in (
    'lost_or_stolen_phone', 'screenshot_shared', 'printed_copy_lost',
    'qr_display_issue', 'security_concern', 'participant_other'
  ) then
    raise exception 'A valid participant reissue reason code is required';
  end if;
  -- Note normalization — used identically for validation, the immutable-
  -- intent comparison inside reserve_or_reuse_qr_lifecycle_operation, AND
  -- final persistence: null stays null; trimmed-empty text becomes null;
  -- non-empty text is stored trimmed. Applying the SAME normalized value
  -- everywhere means two callers supplying, e.g., '  ' and null
  -- respectively for the same otherwise-identical request are recognized
  -- as IDENTICAL intent (never a spurious request_key_intent_conflict) —
  -- whitespace differences must never create unstable intent conflicts.
  v_normalized_note := nullif(trim(p_reissue_note), '');
  if p_reissue_reason_code = 'participant_other' and v_normalized_note is null then
    raise exception 'A note is required when reissue reason is participant_other';
  end if;

  -- Resolve the participant's own application — unlocked here, used only
  -- to shape the advisory-lock domain; re-verified under lock at position
  -- 5 below. This, and the two exceptions above, are the ONLY things that
  -- may fail before an operation row exists (beyond
  -- p_expected_current_credential_id's own foreign-key-intent validation,
  -- performed next).
  select id into v_application_id_candidate from public.applications where applicant_id = auth.uid();
  if v_application_id_candidate is null then raise exception 'No application found for this account'; end if;

  -- If p_expected_current_credential_id cannot possibly satisfy
  -- qr_lifecycle_operations_expected_credential_fkey's composite
  -- (id, application_id) target — i.e. it does not identify ANY
  -- qr_credentials row belonging to this participant's OWN application,
  -- active or not — this is treated as INVALID INPUT and rejected before
  -- any operation is ever created, exactly like the reason-code/note
  -- checks above. This is deliberately NOT the same thing as "the
  -- credential exists for this application but is no longer active" —
  -- THAT case is legal immutable intent (the participant may be trying to
  -- reissue against a credential they last saw as active, which has since
  -- been replaced/revoked) and must produce the durable
  -- expected_credential_changed outcome via a real operation row, not an
  -- input-validation exception. The distinction is made by checking
  -- existence+application match only, never status.
  if not exists (
    select 1 from public.qr_credentials
    where id = p_expected_current_credential_id and application_id = v_application_id_candidate
  ) then
    raise exception 'expected_current_credential_id does not identify a credential belonging to this application';
  end if;

  -- Positions 1-3: advisory-locked reservation lookup, unchanged shared
  -- helper — operation_type = 'reissue', bulk_batch_id always null for
  -- this channel. v_normalized_note (not the raw parameter) is passed
  -- through so the intent comparison and any subsequent insert both use
  -- the identical normalized value.
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'reissue', v_application_id_candidate, auth.uid(), p_request_key, 'participant_self_service', null,
    p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_current_active from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status; -- historically-stable: replayed as-stored, even if since revoked/replaced
    v_result.issued_at := v_current_active.issued_at;
    v_result.replaced_at := v_current_active.replaced_at;
    v_result.revoked_at := v_current_active.revoked_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    -- Identical replay of ANY previously-cancelled reissue reservation —
    -- including a cooldown/rate-limit denial — replays the STORED
    -- terminal reason and, for the two policy-driven reasons, computes
    -- retry_after_seconds from the STORED terminal_retry_after_at. Never
    -- re-derives which historical operations originally triggered the
    -- denial, and never re-evaluates current application/credential/
    -- cooldown/rate-limit state — this row's outcome was decided once, at
    -- cancellation time, and is replayed verbatim.
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'expected_credential_changed' then
      select * into v_current_active from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
    elsif (v_reservation.op).terminal_reason_code in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded') then
      v_result.retry_after_seconds := greatest(
        0,
        ceil(extract(epoch from (v_reservation.op).terminal_retry_after_at - clock_timestamp()))
      )::integer;
    end if;
    return v_result;
  end if;

  -- Position 5: lock the application, THEN re-verify ownership.
  select * into v_app from public.applications where id = v_application_id_candidate for update;
  if v_app.id is null or v_app.applicant_id is distinct from auth.uid() then
    raise exception 'No application found for this account';
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Delegates to the reissue-specific shared resolver — which evaluates
    -- ONLY application eligibility, the credential lock, TTL, active-
    -- credential existence, and expected-credential match. It deliberately
    -- never touches cooldown/rate-limit: those are admission-time controls
    -- for a NEW request, and must never retroactively invalidate an
    -- already-existing valid pending operation (this also structurally
    -- prevents a pending operation from ever invalidating itself).
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_reissue_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' (application_ineligible, ttl_expired, no_active_credential,
    -- or expected_credential_changed) — continues processing THIS request
    -- key, falling through to the shared insert-and-resolve path below,
    -- identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    -- Mirrors the reissue-specific resolver's own decision tree exactly
    -- (application eligibility -> credential lock -> TTL -> active-
    -- credential existence -> expected-credential match) but returns THIS
    -- caller's own outcomes (already_pending/operation_expired/
    -- application_ineligible/no_active_credential/expected_credential_changed)
    -- rather than the resolver's generic still_blocking/terminalized pair,
    -- exactly mirroring issuance's identical matching_pending_candidate
    -- vs. other_pending_candidate distinction. Cooldown/rate-limit are NOT
    -- re-evaluated here either, for the identical reason.
    if v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    -- Position 6: credential lock BEFORE the TTL decision.
    select * into v_current_active from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    -- Position 7: fresh timestamp, captured only after the credential
    -- lock — TTL checked immediately, and wins over every credential-state
    -- finding below.
    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id is null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
      where id = (v_reservation.op).id;
      v_result.outcome := 'no_active_credential';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    -- CORRECTED this round: terminal_related_credential_id is permitted
    -- ONLY for 'active_credential_already_exists' by the approved
    -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    -- (§1.7) — it must remain null here, and the returned result carries
    -- only the stable outcome name, no credential_id/status/issued_at.
    if v_current_active.id <> (v_reservation.op).expected_current_credential_id then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
          terminal_related_credential_id = null
      where id = (v_reservation.op).id;
      v_result.outcome := 'expected_credential_changed';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- ===================== 'no_existing_operation' path =====================
  -- (also reached for an 'other_pending_candidate' just terminalized
  -- above, which falls through here identically.)
  --
  -- Authoritative processing order for this path, restated exactly as
  -- specified and implemented step-for-step below:
  --   1. lock and recheck the application and participant ownership
  --      (already done above, at position 5 — shared by every state).
  --   2. lock the current active credential.
  --   3. capture a fresh timestamp.
  --   4. insert the participant's own PENDING reissue operation with the
  --      immutable request intent — durably persisted BEFORE any business
  --      denial is evaluated, so every subsequent denial has a real row
  --      to transition rather than reporting a no-row outcome.
  --   5. if its TTL has elapsed because of lock-waiting time, expire it.
  --      (Pathological — the window between step 3's timestamp and this
  --      check is normally microseconds — but not assumed impossible,
  --      mirroring issuance's identical restated-TTL-recheck discipline
  --      for its own freshly-inserted row.)
  --   6. if the application is ineligible, cancel with application_ineligible.
  --   7. if no active credential exists, cancel with no_active_credential.
  --   8. if the active credential differs from expected, cancel with
  --      expected_credential_changed.
  --   9. evaluate the consumed-operation daily (rolling 24h) limit.
  --  10. if blocked, cancel with reissue_rate_limit_exceeded and persist
  --      terminal_retry_after_at.
  --  11. otherwise evaluate cooldown.
  --  12. if blocked, cancel with reissue_cooldown_active and persist
  --      terminal_retry_after_at.
  --  13. otherwise return reserved.
  --
  -- Every branch below re-derives application/credential state from the
  -- SAME locks already held (position 5's application lock; this path's
  -- own credential lock next) — no separate re-locking required, and the
  -- SAME defense-in-depth exception handler for the named partial unique
  -- index is retained around the insert itself, mirroring issuance's own
  -- retained handler for the identical reason (a concurrent different
  -- request_key theoretically slipping in between the reserve_or_reuse
  -- lookup and this insert — impossible under the domain lock actually
  -- held, retained anyway as defense in depth).

  -- Step 2: credential lock BEFORE any further decision.
  select * into v_current_active from public.qr_credentials
    where application_id = v_app.id and status = 'active' for update;

  -- Step 3: fresh timestamp, captured only after the credential lock.
  v_created_at := clock_timestamp();

  -- Step 4: insert first, always — every business decision below operates
  -- on this real, durable row, never a hypothetical pre-insert check.
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
    ) values (
      'reissue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
      p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
      v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = v_app.id and operation_type = 'reissue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_reissue_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  -- Step 5: TTL recheck against THIS row's own just-inserted expires_at —
  -- pathological (the window since step 3 is normally microseconds), but
  -- not assumed impossible.
  v_check_now := clock_timestamp();
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 6: application eligibility.
  if v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 7: active-credential existence.
  if v_current_active.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = v_operation_id;
    v_result.outcome := 'no_active_credential';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 8: expected-credential match. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here, and the returned result carries
  -- only the stable outcome name, no credential_id/status/issued_at.
  if v_current_active.id <> p_expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_operation_id;
    v_result.outcome := 'expected_credential_changed';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Steps 9-12: consumed-operation cooldown and rolling-rate-limit checks
  -- — see "Cooldown and rate-limit calculation rules" below for the exact
  -- query, window boundaries, and precedence argument. ONE authoritative
  -- post-lock timestamp (v_check_now, re-captured here) is used for both.
  -- Both checks run under the SAME application-domain advisory lock
  -- already held since position 1/2 (reserve_or_reuse_qr_lifecycle_operation
  -- never released it — it is held for the remainder of this transaction)
  -- — no separate lock is required for the counting query itself.
  v_check_now := clock_timestamp();

  -- CORRECTED this round: LIMIT 3 must apply to the SOURCE rows, inside a
  -- subquery, BEFORE array_agg runs — not after array_agg as a top-level
  -- clause. array_agg is an aggregate: it consumes every row the FROM
  -- clause produces and emits exactly ONE result row (the array itself). A
  -- LIMIT 3 placed after that aggregation restricts the number of
  -- AGGREGATE-RESULT rows (already 1), never the number of SOURCE rows fed
  -- into the aggregate — the previous version's `... from
  -- qr_lifecycle_operations where ... order by consumed_at desc limit 3`
  -- with array_agg at the top level therefore aggregated EVERY qualifying
  -- historical row, not merely the three most recent, which would corrupt
  -- v_consumed_at_values[3] (and the daily-limit decision below) for any
  -- application with more than three qualifying consumed reissues ever.
  -- The corrected form nests the ORDER BY + LIMIT 3 inside an explicit
  -- subquery so exactly three rows (or fewer) reach array_agg.
  select coalesce(
           array_agg(
             q.consumed_at
             order by q.consumed_at desc
           ),
           array[]::timestamptz[]
         )
    into v_consumed_at_values
    from (
      select o.consumed_at
      from public.qr_lifecycle_operations o
      where o.application_id = v_app.id
        and o.operation_type = 'reissue'
        and o.channel = 'participant_self_service'
        and o.status = 'consumed'
        and o.consumed_at is not null
      order by o.consumed_at desc
      limit 3
    ) q;

  -- Step 9-10: rolling 24-hour daily limit, evaluated FIRST — its
  -- eligibility boundary (when 3+ qualifying operations exist) is always
  -- the effective LONGER restriction whenever both policies are active
  -- simultaneously, so it must take precedence: a caller must never be
  -- told "cooldown ends in N minutes" while still genuinely blocked by
  -- the daily limit for far longer.
  --
  -- CORRECTED this round: the window test must inspect
  -- v_consumed_at_values[3] (the THIRD-most-recent qualifying operation),
  -- not [1] (the most recent). Checking [1] only proves the LATEST reissue
  -- happened within 24 hours — it says nothing about whether a THIRD
  -- qualifying reissue exists inside that same window at all. Concretely:
  -- if the most recent qualifying reissue is 1 hour old but the second and
  -- third most recent are each several days old, [1] > now - 24h is TRUE
  -- even though only ONE reissue (not three) actually occurred inside the
  -- rolling 24-hour window — the daily limit must NOT fire in that case,
  -- and only inspecting [3] (rather than [1]) correctly reflects that.
  -- Three qualifying operations are inside the window if and only if the
  -- OLDEST of those three — [3], since the array is ordered most-recent-
  -- first — is still newer than the 24-hour boundary.
  if cardinality(v_consumed_at_values) >= 3
     and v_consumed_at_values[3] > v_check_now - interval '24 hours' then
    -- At least 3 qualifying operations exist AND the THIRD-most-recent is
    -- still within the rolling window — rate-limited. The retry boundary
    -- is that same third-most-recent qualifying consumed_at plus 24
    -- hours: once that specific operation ages out of the rolling window,
    -- only 2 qualifying operations remain within it, and a new attempt
    -- becomes eligible again.
    v_retry_after_at := v_consumed_at_values[3] + interval '24 hours';

    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_check_now, terminal_reason_code = 'reissue_rate_limit_exceeded',
        terminal_retry_after_at = v_retry_after_at
    where id = v_operation_id;

    v_result.outcome := 'reissue_rate_limit_exceeded';
    v_result.operation_id := v_operation_id;
    v_result.retry_after_seconds := greatest(0, ceil(extract(epoch from v_retry_after_at - clock_timestamp())))::integer;

    return v_result;
  elsif cardinality(v_consumed_at_values) >= 1
        and v_consumed_at_values[1] > v_check_now - interval '10 minutes' then
    -- Step 11-12: cooldown — reached only when the daily limit above did
    -- NOT fire (an elsif, not a separate independent if), so a cooldown
    -- retry time is never returned while the participant remains blocked
    -- by the longer-lasting daily limit. Cooldown depends ONLY on the
    -- participant's single most recent qualifying reissue — [1], never
    -- [3] — independent of how many total qualifying operations exist.
    v_retry_after_at := v_consumed_at_values[1] + interval '10 minutes';

    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_check_now, terminal_reason_code = 'reissue_cooldown_active',
        terminal_retry_after_at = v_retry_after_at
    where id = v_operation_id;

    v_result.outcome := 'reissue_cooldown_active';
    v_result.operation_id := v_operation_id;
    v_result.retry_after_seconds := greatest(0, ceil(extract(epoch from v_retry_after_at - clock_timestamp())))::integer;

    return v_result;
  end if;

  -- Step 13: every eligibility/TTL/cooldown/rate-limit check has passed —
  -- the pending row inserted at step 4 remains genuinely reserved.
  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_my_qr_reissue_transactional_internal(uuid, uuid, text, text, interval) from public;
-- No grant to authenticated/anon — reachable only through the public
-- wrapper below and a future test-only short-TTL wrapper, both of which
-- fix or otherwise control p_pending_ttl.

-- Public, authenticated-facing wrapper — the ONLY entry point exposed to
-- real users for participant self-reissue. TTL is hardcoded at 5 minutes,
-- identical to issuance; no caller, however privileged, can pass a
-- different value through this signature.
create function public.request_my_qr_reissue_transactional(
  p_request_key uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text
) returns public.qr_credential_lifecycle_result
language sql security definer set search_path = public, pg_temp as $$
  select public.request_my_qr_reissue_transactional_internal(
    p_request_key, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note,
    interval '5 minutes'
  );
$$;

revoke all on function public.request_my_qr_reissue_transactional(uuid, uuid, text, text) from public;
grant execute on function public.request_my_qr_reissue_transactional(uuid, uuid, text, text) to authenticated;

-- ================= FINALIZATION — reissue (service-role only) — APPROVED =================
-- SUB-PASS 2, this round's addition. Consumes a 'pending' reissue
-- operation (participant self-service, staff individual, or staff bulk —
-- all three approved reissue reservation RPCs share this ONE finalizer,
-- exactly mirroring how finalize_qr_issuance_for_server serves all three
-- approved issuance reservation RPCs) and performs the atomic
-- old-credential-replacement + new-credential-creation write —
-- `service_role`-only, ONE approved signature, no overload. Every input
-- is either an opaque identifier or already-encrypted/hashed material —
-- never plaintext, never a key, never a nonce, never a fingerprint,
-- never a ciphertext digest. The function computes its own fingerprint
-- internally and never returns it.
--
-- Lock order (five positions, identical shape to the approved issuance
-- finalizer, extended with reissue's own credential semantics):
--   1. lifecycle operation row, FOR UPDATE — locked and inspected FIRST,
--      before any other row; the operation is the authoritative
--      idempotency record, not qr_credentials. A two-stage TTL check
--      (identical protocol to the issuance finalizer) runs around this
--      lock and the locks below — an EARLY check immediately after this
--      lock avoids taking any further lock for an already-expired
--      operation; a SECOND, authoritative recheck runs again after EVERY
--      required lock, THROUGH POSITION 5 (the key-registry lock), is
--      held, and is the one that actually governs decision precedence
--      (TTL still wins over every other business outcome). CORRECTED
--      this round: the authoritative recheck previously ran after only
--      position 4, before the key-registry lock at position 5 was even
--      acquired — closing that gap required moving the authoritative
--      clock_timestamp() capture to after position 5 as well; the
--      identical narrow correction was applied to
--      finalize_qr_issuance_for_server.
--   2. durable bulk-batch row, FOR SHARE, ONLY when channel = 'staff_bulk'
--      — locked immediately after the operation lock (and the early TTL
--      check), BEFORE the application lock, and held for the remainder
--      of this transaction — identical rationale and mechanism to the
--      issuance finalizer's own corrected batch-lock position: a
--      concurrent batch completion/cancellation must block behind this
--      finalizer's hold until the transaction commits or rolls back,
--      never merely "was valid at the moment of an early, unprotected
--      read." Locking here does NOT mean the batch's business outcome
--      (bulk_batch_unavailable) is decided here — the decision
--      precedence below (application -> requester-authorization -> batch
--      -> no-active-credential -> expected-credential-mismatch ->
--      key-version-active) is independent of lock order.
--   3. application row, FOR UPDATE.
--   4. current active credential row, FOR UPDATE — selected by
--      application_id = the operation's own application_id and
--      status = 'active' ONLY; never a caller-supplied "old credential"
--      row or actor identity of any kind.
--   5. selected encryption-key registry row, FOR SHARE — via
--      is_encryption_key_version_active(), which itself takes this exact
--      lock; reused unchanged, the single source of truth for "is this
--      key version currently active" everywhere in this design. Locking
--      here does NOT mean the key's business outcome
--      (key_version_not_active) is decided here — CORRECTED this round,
--      the authoritative clock_timestamp() is captured only AFTER this
--      lock, and every decision (including this one, still evaluated
--      LAST in the approved precedence) runs from that single, final
--      timestamp.
-- No row is ever locked before the lifecycle operation; no authoritative
-- batch/application/credential/key state is ever read before its own
-- corresponding lock in this exact order.
create function public.finalize_qr_reissue_for_server(
  p_operation_id uuid,
  p_new_credential_id uuid,
  p_new_token_hash bytea,
  p_new_token_ciphertext bytea,
  p_new_token_version smallint,
  p_new_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_key_is_active boolean;
  v_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_existing_credential public.qr_credentials;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Input-shape validation BEFORE any lock is taken — malformed input is
  -- rejected as an exception, never represented as a lifecycle-result
  -- outcome, exactly mirroring the issuance finalizer's own discipline.
  if p_operation_id is null then raise exception 'operation_id is required'; end if;
  if p_new_credential_id is null then raise exception 'new_credential_id is required'; end if;
  if p_new_token_hash is null or octet_length(p_new_token_hash) <> 32 then
    raise exception 'new_token_hash must be exactly 32 bytes';
  end if;
  if p_new_token_ciphertext is null or octet_length(p_new_token_ciphertext) <> 61 then
    raise exception 'new_token_ciphertext must be exactly 61 bytes';
  end if;
  if get_byte(p_new_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  if p_new_token_version is null or p_new_token_version not between 1 and 32767 then
    raise exception 'Invalid new_token_version';
  end if;
  if p_new_encryption_key_version is null or p_new_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid new_encryption_key_version';
  end if;

  -- Position 1: lifecycle operation row, FOR UPDATE, locked and
  -- inspected FIRST, before any other row.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Lifecycle operation not found'; end if;

  -- The new credential id must differ from the operation's own durable
  -- expected_current_credential_id — checked here, against the
  -- OPERATION's own recorded value (not any later-read live state),
  -- since it is available immediately once the operation is locked and
  -- is true for every legitimate call regardless of historical/pending
  -- status.
  if v_op.expected_current_credential_id is not null and p_new_credential_id = v_op.expected_current_credential_id then
    raise exception 'new_credential_id must differ from expected_current_credential_id';
  end if;

  -- Historical states handled FIRST, before any further lock —
  -- 'consumed'/'expired'/'cancelled' are all fully resolved by the
  -- operation row alone.
  if v_op.status = 'consumed' then
    -- Idempotent replay: recompute the SAME canonical fingerprint from
    -- THIS call's supplied inputs (domain 'reissue') and compare against
    -- the durably stored one — never re-derived from the current
    -- qr_credentials row. CORRECTED this round: the replayed RESULT
    -- itself must ALSO never be derived from the current qr_credentials
    -- row — a resulting credential may later become revoked or replaced,
    -- and exact finalizer replay must not change because of that later
    -- lifecycle transition. Every field returned here comes exclusively
    -- from the durable qr_lifecycle_operations row: credential_id from
    -- resulting_credential_id, status hardcoded to 'active' (the state at
    -- the successful finalization transition, never re-queried), and
    -- issued_at from finalized_at (guaranteed equal to the new
    -- credential's own issued_at at the moment of that same transition).
    -- This branch no longer depends on the resulting credential row still
    -- being queryable, its current status, its ciphertext, its current
    -- encryption-key version, or any later revocation/replacement field.
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
    );
    if v_fingerprint = v_op.finalization_fingerprint and p_new_credential_id = v_op.resulting_credential_id then
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_op.resulting_credential_id;
      v_result.status := 'active';
      v_result.issued_at := v_op.finalized_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  if v_op.status = 'expired' then
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if v_op.status = 'cancelled' then
    -- Replay the durable terminal outcome without re-evaluating current
    -- state — identical discipline to every reservation RPC's own
    -- replay_cancelled path and the issuance finalizer's own replay.
    -- CORRECTED this round: terminal_related_credential_id is permitted
    -- ONLY for 'active_credential_already_exists' by the approved
    -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    -- (§1.7) — 'expected_credential_changed' always leaves it null, so no
    -- lookup through it is ever performed here. This finalizer has no
    -- cancellation reason that uses terminal_related_credential_id at
    -- all (active_credential_already_exists is a defense-in-depth
    -- constraint-collision outcome for reissue, never a pending-path
    -- cancellation reason set by this function); the stable outcome name
    -- alone is always sufficient to replay 'expected_credential_changed'.
    v_result.outcome := v_op.terminal_reason_code;
    return v_result;
  end if;

  if v_op.status <> 'pending' then
    -- Unsupported/unknown status — never guess. Same safe conflict
    -- outcome finalizers already use for an unrecognized state.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Pending-operation shape checks: this finalizer handles REISSUE only.
  -- An issue operation reaching this function would be a caller bug
  -- (Node calling the wrong finalizer for the operation's own recorded
  -- type) — rejected as an exception, not a lifecycle outcome, since it
  -- can never legitimately happen through the approved Node-side flow.
  if v_op.operation_type <> 'reissue' then
    raise exception 'finalize_qr_reissue_for_server called for a non-reissue operation';
  end if;
  if v_op.expected_current_credential_id is null then
    raise exception 'reissue operation is missing its required expected_current_credential_id';
  end if;
  if v_op.channel not in ('participant_self_service', 'staff_individual', 'staff_bulk') then
    raise exception 'reissue operation carries an unrecognized channel';
  end if;
  if v_op.application_id is null or v_op.requested_by_auth_user_id is null then
    raise exception 'reissue operation is missing required durable requester/application information';
  end if;
  -- Channel/batch-binding consistency — identical internal-invariant
  -- check to the issuance finalizer's own.
  if v_op.channel = 'staff_bulk' and v_op.bulk_batch_id is null then
    raise exception 'staff_bulk reissue operation is missing its required bulk_batch_id';
  end if;
  if v_op.channel <> 'staff_bulk' and v_op.bulk_batch_id is not null then
    raise exception 'non-staff_bulk reissue operation unexpectedly carries a bulk_batch_id';
  end if;

  -- TWO-STAGE TTL CHECK, stage one: an EARLY check runs immediately
  -- after the operation lock, before any further lock is taken — an
  -- already-expired operation never touches the batch/application/
  -- credential locks at all.
  if v_op.expires_at <= clock_timestamp() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_transition_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Position 2: durable bulk-batch row, FOR SHARE, ONLY for staff_bulk —
  -- locked here, but NO business outcome is returned yet; every
  -- pending-path business decision is evaluated together, in the
  -- approved order, only after every required lock (through position 5)
  -- is held.
  if v_op.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = v_op.bulk_batch_id for share;
  end if;

  -- Position 3: application row, FOR UPDATE.
  select * into v_app from public.applications where id = v_op.application_id for update;

  -- Position 4: current active credential row, FOR UPDATE — selected
  -- ONLY by application_id + status = 'active'; never a caller-supplied
  -- "old credential" row or actor identity.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;

  -- Position 5: encryption-key registry row, FOR SHARE, via the shared
  -- helper (which itself takes this exact lock). CORRECTED this round:
  -- the authoritative timestamp used for the TTL recheck and every
  -- pending-path decision was previously captured immediately after
  -- position 4 — BEFORE this lock — leaving a gap where the operation
  -- could expire while THIS call itself waited to acquire the
  -- key-registry row, and still be finalized/rejected using a stale
  -- pre-wait timestamp. The key-active result is stored here in
  -- v_key_is_active WITHOUT yet deciding anything; the authoritative
  -- v_now below is captured only AFTER this lock, and every decision —
  -- including this key-version-active outcome, now evaluated last in the
  -- approved precedence rather than the moment its lock is acquired — is
  -- made from that single, final timestamp. This exactly mirrors the
  -- identical narrow correction applied to finalize_qr_issuance_for_server
  -- this same round.
  v_key_is_active := public.is_encryption_key_version_active(p_new_encryption_key_version);

  -- ONE authoritative timestamp, captured only after every required lock
  -- (through position 5) is held — reused for every timestamp field this
  -- finalizer writes from here on, AND for the authoritative TTL
  -- recheck below (stage two), which must win over every other business
  -- decision.
  v_now := clock_timestamp();

  -- Decision 1: TTL, rechecked authoritatively now that every required
  -- lock is held.
  if v_op.expires_at <= v_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Decision 2: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'application_ineligible'
    where id = v_op.id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Decision 3: staff-channel requester authorization, re-verified at
  -- finalization time.
  if v_op.channel in ('staff_individual', 'staff_bulk') then
    select role into v_caller_role from public.profiles where id = v_op.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = v_op.id;
      v_result.outcome := 'requester_no_longer_authorized';
      return v_result;
    end if;
  end if;

  -- Decision 4: staff_bulk batch availability — the row was already
  -- locked at position 2, above (immediately after the operation lock,
  -- before the application/credential/key locks); this is simply the
  -- first point in the approved decision precedence at which a business
  -- outcome based on that already-held lock may be returned.
  if v_op.channel = 'staff_bulk' then
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= v_now
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from v_op.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from v_op.requested_by_profile_id
    then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_op.id;
      v_result.outcome := 'bulk_batch_unavailable';
      return v_result;
    end if;
  end if;

  -- Decision 5: no active credential exists at all — reissue's own
  -- credential-existence requirement (the inverse of issuance's
  -- "active-credential-already-exists" conflict).
  if v_current_active.id is null then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'no_active_credential'
    where id = v_op.id;
    v_result.outcome := 'no_active_credential';
    return v_result;
  end if;

  -- Decision 6: the active credential does not match the operation's own
  -- durable expected_current_credential_id. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here. The stable outcome name alone
  -- (with no credential_id/status/issued_at) is the entire durable
  -- result; a fresh caller who wants to know the current active
  -- credential can simply reserve a new reissue operation, which itself
  -- re-reads live state.
  if v_current_active.id <> v_op.expected_current_credential_id then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_op.id;
    v_result.outcome := 'expected_credential_changed';
    return v_result;
  end if;

  -- Decision 7: encryption-key version active state — the lock was
  -- already acquired at position 5, above; the result computed there
  -- (v_key_is_active) is evaluated LAST among all pending-path
  -- validations, per the approved order — a missing, decrypt_only, or
  -- retired key is the one RETRYABLE outcome: the operation remains
  -- pending, untouched, and neither the old credential nor audit history
  -- is modified.
  if not v_key_is_active then
    v_result.outcome := 'key_version_not_active';
    return v_result; -- operation remains pending, old credential remains active, untouched
  end if;

  -- Canonical fingerprint, computed ONLY through the shared helper — no
  -- ad-hoc format. Domain-separated for reissue ('rcoy:qr-finalization:v1'
  -- + 'reissue'), binding the NEW credential id, new token hash, new
  -- token version, new encryption-key version, and a digest of the new
  -- ciphertext envelope.
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
  );

  -- The old-credential replacement, new-credential insert, deferred-FK
  -- IMMEDIATE check, lifecycle consumed-transition, and success audit
  -- insert are ALL atomic: everything happens inside this one inner
  -- exception block, and either all commit together or (on any
  -- exception, including a caught unique_violation re-raised as a
  -- controlled outcome, or a caught foreign_key_violation from the
  -- forced-IMMEDIATE deferred constraint check) all roll back together
  -- — it is unacceptable for the OLD credential to become unusable
  -- (replaced) while the NEW credential's creation fails; both the
  -- active-to-replaced UPDATE and the new-row INSERT below are inside
  -- this SAME block precisely so a failure at any point rolls both back
  -- as one unit, leaving the OLD credential exactly as it was
  -- ('active', untouched) and the operation still 'pending' (retryable).
  --
  -- Order is REQUIRED, not arbitrary: the old row must leave 'active'
  -- status BEFORE the new row can become 'active' (satisfying
  -- qr_credentials_one_active_per_application, a same-statement
  -- non-deferrable partial unique index with no ordering flexibility) —
  -- so the UPDATE runs first. The deferred composite FK
  -- (qr_credentials_replacement_same_application_fkey) is what makes
  -- this legal despite the OLD row's UPDATE referencing a
  -- replaced_by_credential_id (p_new_credential_id) that does not exist
  -- yet at the moment of that UPDATE — the FK's referential check is
  -- deferred to (at latest) COMMIT, by which point the INSERT below has
  -- already made the referenced row exist.
  declare
    v_constraint_name text;
  begin
    update public.qr_credentials
    set status = 'replaced', token_ciphertext = null, encryption_key_version = null,
        replaced_at = v_now, replaced_by_credential_id = p_new_credential_id,
        reissue_channel = v_op.channel, reissue_reason_code = v_op.reason_code, reissue_note = v_op.note,
        -- Actor semantics for the OLD credential: participant_self_service
        -- -> null; staff_individual/staff_bulk -> the operation's own
        -- durable requested_by_profile_id (never the service-role
        -- identity, never re-resolved from any authenticated session —
        -- none exists inside this service-role-only function).
        replaced_by = case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    where id = v_current_active.id;

    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, token_version, encryption_key_version,
      status, issuance_channel, issuance_reason_code, issuance_note,
      issued_at, created_at, issued_by
    ) values (
      p_new_credential_id, v_op.application_id, p_new_token_hash, p_new_token_ciphertext, p_new_token_version, p_new_encryption_key_version,
      'active', v_op.channel,
      -- The NEW credential's own issuance_reason_code/issuance_note are
      -- ALWAYS null for a reissue — there is no "reissued_credential"
      -- value in the approved issuance-reason vocabulary, and inventing
      -- one is explicitly out of scope. The reissue's own reason/note
      -- live durably on the OLD (now-replaced) credential's
      -- reissue_reason_code/reissue_note, set above, never here.
      null, null,
      v_now, v_now,
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    );

    -- Force the deferred same-application replacement FK to IMMEDIATE
    -- and let it actually run its check HERE, inside this controlled
    -- block, rather than silently at COMMIT after this RPC has already
    -- returned a result to the caller. SET CONSTRAINTS is transaction-
    -- scoped and affects only the remainder of THIS transaction (which
    -- ends when this function returns and its caller's own transaction
    -- boundary completes — for a service-role RPC call, that is this
    -- statement's own implicit transaction).
    set constraints public.qr_credentials_replacement_same_application_fkey immediate;

    update public.qr_lifecycle_operations
    set status = 'consumed', consumed_at = v_now, finalized_at = v_now,
        resulting_credential_id = p_new_credential_id, finalization_fingerprint = v_fingerprint,
        terminal_reason_code = null, terminal_related_credential_id = null, terminal_retry_after_at = null
    where id = v_op.id;

    -- Safe metadata only — never token hash, ciphertext, nonce, key
    -- material, or fingerprint.
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', p_new_credential_id, 'reissued',
      case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end,
      case when v_op.channel = 'participant_self_service' then v_op.requested_by_auth_user_id else v_op.requested_by_profile_id end,
      jsonb_build_object(
        'application_id', v_op.application_id, 'old_credential_id', v_current_active.id,
        'new_credential_id', p_new_credential_id, 'reissue_channel', v_op.channel,
        'reissue_reason_code', v_op.reason_code
      ),
      v_now
    );
  exception
    when unique_violation then
      declare
        v_conflicting_credential public.qr_credentials;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'qr_credentials_token_hash_unique' then
          -- The new token hash already belongs to a DIFFERENT,
          -- already-inserted credential row. The operation remains
          -- pending (retryable with fresh input); the OLD credential's
          -- active-to-replaced UPDATE rolls back together with the
          -- failed INSERT, so the old credential remains active,
          -- unchanged; no new credential, no success audit row.
          v_result.outcome := 'token_hash_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_pkey' then
          -- p_new_credential_id collides with an existing row belonging
          -- to a DIFFERENT operation entirely.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_replacement_target_unique' then
          -- p_new_credential_id is already recorded as the
          -- replaced_by_credential_id of a DIFFERENT old credential row
          -- — never legitimate for a fresh reissue targeting THIS old
          -- credential.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_one_active_per_application' then
          -- The old-row UPDATE above should have already freed this
          -- application's active slot before the INSERT ever ran — a
          -- violation here means a DIFFERENT active credential appeared
          -- for this application between this transaction's own
          -- position-4 lock and this exact statement (should be
          -- structurally impossible under that lock, but resolved
          -- safely rather than exposing a raw violation, per the
          -- approved defense-in-depth discipline used throughout this
          -- design). Re-inspect authoritatively rather than guess.
          select * into v_conflicting_credential from public.qr_credentials
            where application_id = v_op.application_id and status = 'active';
          if v_conflicting_credential.id is not null then
            v_result.outcome := 'active_credential_already_exists';
            v_result.credential_id := v_conflicting_credential.id;
            v_result.status := v_conflicting_credential.status;
            v_result.issued_at := v_conflicting_credential.issued_at;
            return v_result;
          end if;
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_lifecycle_operations_resulting_credential_unique_idx' then
          -- p_new_credential_id is already recorded as the RESULT of a
          -- different lifecycle operation — never legitimate for a
          -- fresh reissue.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        else
          raise;
        end if;
      end;
    when foreign_key_violation then
      -- CORRECTED this round: previously every foreign_key_violation in
      -- this block was unconditionally mapped to idempotency_conflict —
      -- too broad, since it could silently mask an unrelated integrity
      -- failure (applications, profiles, audit rows, actors, or any
      -- future foreign key touched by this block) behind a misleading
      -- "safe" outcome instead of surfacing the real defect. Only the
      -- ONE expected constraint — the forced-IMMEDIATE deferred
      -- same-application replacement FK
      -- (qr_credentials_replacement_same_application_fkey), checked HERE,
      -- inside this controlled block, never silently at commit after
      -- this RPC has already returned a result — is mapped to a
      -- controlled outcome. This should be structurally unreachable
      -- given the INSERT immediately above always creates a row
      -- satisfying (id, application_id) for the exact application_id the
      -- OLD row's UPDATE just referenced; retained as defense-in-depth,
      -- consistent with every other named-constraint mapping in this
      -- function. Every OTHER foreign_key_violation is re-raised so the
      -- entire outer transaction rolls back and the real defect is never
      -- misreported as a routine idempotency conflict.
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'qr_credentials_replacement_same_application_fkey' then
        v_result.outcome := 'idempotency_conflict';
        return v_result;
      end if;
      raise;
  end;

  v_result.outcome := 'reissued';
  v_result.credential_id := p_new_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint) from public, anon, authenticated;
grant execute on function public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint) to service_role;

**SUPERSEDED — kept only for historical reference, do not implement as written.** The section
immediately below (through the staff force-reissue heading) is the pre-`request_key`,
pre-Sub-pass-2 draft. It is retained verbatim rather than deleted so the corrections history
stays legible, but every SQL body in it is stale: it predates the approved
`reserve_or_reuse_qr_lifecycle_operation` signature, uses outcome names that were never approved
into the final vocabulary, and depends on `qr_credentials.replaced_at` for rate-limiting (a
finalizer-only column, unusable before that finalizer exists). The approved participant
self-reissue reservation is the `request_my_qr_reissue_transactional`/
`request_my_qr_reissue_transactional_internal`/`resolve_blocking_qr_lifecycle_reissue_operation`
trio above.

Same two-step shape as issuance, with the added wrinkle that a reissue operation must record
*which* credential it expects to still be active, so the finalizer can detect a race (someone
else reissued in between reservation and finalization) rather than silently overwriting a
different credential than the one the reservation actually locked.

```sql
-- ================= RESERVATION (participant self-service) =================
-- Lock order (§1.7a): operation first, THEN application, THEN current
-- credential. CORRECTED this round: the previous draft locked application
-- (FOR UPDATE) and then credential (FOR UPDATE) BEFORE calling
-- reserve_or_reuse — the exact inversion that could deadlock against a
-- finalizer holding the operation lock and waiting on the application
-- lock. The active credential's id is now read UNLOCKED first (needed
-- only to populate expected_current_credential_id for the reservation's
-- intent-match/insert), the operation is reserved/reused/expired next,
-- THEN the application is locked, THEN the credential is re-read under
-- lock and re-verified to still be the same row — closing the race where
-- the unlocked read was stale by the time the application lock is held.
-- CORRECTED this round: rate-limit checks moved INSIDE the serialized
-- reservation flow — after the advisory lock (inside reserve_or_reuse),
-- pending-operation handling, application lock, AND current-credential
-- lock, not before any of them. Rate-limit counting reads
-- qr_credentials.replaced_at rows, which only exist/settle once a prior
-- reissue has actually finalized; checking rate limits before the current
-- request's own locks are held risked two concurrent participant reissue
-- attempts both reading the same pre-limit count and both proceeding, or
-- (as flagged this round) producing a duplicate rate-limit-denial audit
-- event for a request that would have resolved as 'already_pending' had
-- state been checked in the correct order.
create function public.request_my_qr_reissue_transactional(
  p_reissue_reason_code text,
  p_reissue_note text
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_application_id uuid;
  v_expected_credential_id uuid;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_reservation record;
  v_recent_count integer;
  v_last_reissue_at timestamptz;
  v_retry_after integer;
  v_check_now timestamptz;
  v_created_at timestamptz;
  v_transition_now timestamptz;
  v_operation_id uuid;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_reissue_note is not null and char_length(p_reissue_note) > 500 then
    raise exception 'Reissue note too long';
  end if;
  if p_reissue_reason_code is null or p_reissue_reason_code not in (
    'lost_or_stolen_phone', 'screenshot_shared', 'printed_copy_lost',
    'qr_display_issue', 'security_concern', 'participant_other'
  ) then
    raise exception 'A valid reissue reason code is required';
  end if;
  if p_reissue_reason_code = 'participant_other' and (p_reissue_note is null or trim(p_reissue_note) = '') then
    raise exception 'A note is required when reissue reason is participant_other';
  end if;

  -- Derive application id and the currently-active credential id WITHOUT
  -- row locks — used only to shape the reservation/intent-match below;
  -- both are re-verified under lock further down.
  select id into v_application_id from public.applications where applicant_id = auth.uid();
  if v_application_id is null then raise exception 'No application found for this account'; end if;

  select id into v_expected_credential_id from public.qr_credentials
    where application_id = v_application_id and status = 'active';
  if v_expected_credential_id is null then raise exception 'No active credential to reissue'; end if;

  -- Advisory-locked reservation lookup FIRST (§1.7a refined this round).
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'reissue', v_application_id, auth.uid(), 'participant_self_service', null,
    p_reissue_reason_code, p_reissue_note, v_expected_credential_id
  );
  if v_reservation.state = 'intent_conflict' then
    v_result.outcome := 'pending_operation_conflict';
    return v_result;
  end if;

  -- Lock the application, THEN the current active credential, per the
  -- global order — unconditionally, regardless of whether a match exists.
  select * into v_app from public.applications where id = v_application_id for update;
  if v_app.id is null then raise exception 'No application found for this account'; end if;

  if v_app.status <> 'accepted' then
    if v_reservation.state = 'exact_match' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      return v_result;
    end if;
    raise exception 'Application is not accepted';
  end if;

  -- CORRECTED this round: a stale match (expected_current_credential_id no
  -- longer matches, or the credential vanished entirely) must not simply
  -- be returned as 'stale_reissue_operation' while leaving the operation
  -- row pending until its own TTL — it is explicitly cancelled here, one
  -- captured timestamp, with the correct terminal_reason_code.
  select * into v_current_active from public.qr_credentials
    where application_id = v_application_id and status = 'active' for update;
  if v_current_active.id is null or v_current_active.id <> v_expected_credential_id then
    if v_reservation.state = 'exact_match' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed'
      where id = (v_reservation.op).id;
    end if;
    v_result.outcome := 'stale_reissue_operation';
    return v_result;
  end if;

  -- Only now, with the operation/application/credential locks all held, is
  -- an existing match trustworthy enough to return as 'already_pending' —
  -- BEFORE the rate-limit checks below, so an identical valid pending
  -- operation short-circuits without ever producing a second
  -- rate-limit-denial audit event for what is really the same request.
  if v_reservation.state = 'exact_match' then
    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- Rate-limit checks, now fully inside the serialized flow: the advisory
  -- lock plus the application/credential row locks above mean no
  -- concurrent reissue attempt for this same participant can be counting
  -- the same qr_credentials.replaced_at rows concurrently with this one.
  v_check_now := clock_timestamp();

  select max(replaced_at) into v_last_reissue_at
    from public.qr_credentials
    where application_id = v_application_id and status = 'replaced' and reissue_channel = 'participant_self_service';

  if v_last_reissue_at is not null and v_last_reissue_at > v_check_now - interval '10 minutes' then
    v_retry_after := extract(epoch from (v_last_reissue_at + interval '10 minutes' - v_check_now))::integer;
    v_result.outcome := 'cooldown_active';
    v_result.retry_after_seconds := greatest(v_retry_after, 1);
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', v_current_active.id, 'reissue_rate_limited', 'system', auth.uid(),
      jsonb_build_object('application_id', v_application_id, 'limit_kind', 'cooldown', 'retry_after_seconds', v_result.retry_after_seconds),
      v_check_now
    );
    return v_result; -- no operation row created, no token ever generated
  end if;

  select count(*) into v_recent_count
    from public.qr_credentials
    where application_id = v_application_id and status = 'replaced' and reissue_channel = 'participant_self_service'
      and replaced_at > v_check_now - interval '24 hours';

  if v_recent_count >= 3 then
    v_result.outcome := 'daily_limit_reached';
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', v_current_active.id, 'reissue_rate_limited', 'system', auth.uid(),
      jsonb_build_object('application_id', v_application_id, 'limit_kind', 'rolling_24h'),
      v_check_now
    );
    return v_result; -- no operation row created, no token ever generated
  end if;

  v_created_at := clock_timestamp();
  insert into public.qr_lifecycle_operations (
    operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
    channel, reason_code, note, expected_current_credential_id, created_at, expires_at
  ) values (
    'reissue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
    p_reissue_reason_code, p_reissue_note, v_current_active.id, v_created_at, v_created_at + interval '5 minutes'
  ) returning id into v_operation_id;

  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_my_qr_reissue_transactional(text, text) from public;
grant execute on function public.request_my_qr_reissue_transactional(text, text) to authenticated;

-- ================= RESERVATION (staff force-reissue, individual/bulk) =================
-- Signature corrected (point 6): p_bulk_batch_id moved to the end.
-- CORRECTED this round: same bulk-batch lock-order fix as the staff
-- issuance RPC — channel derived lock-free for the reservation call,
-- batch's FOR SHARE lock taken only afterward, before the application
-- lock. Same stale-op terminalization fix as the participant reissue RPC.
create function public.request_staff_qr_reissue_transactional(
  p_application_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_bulk_batch_id uuid default null
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_batch public.qr_bulk_operation_batches;
  v_expected_credential_id uuid;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_reservation record;
  v_channel text;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin','program_attendance_manager') then
    raise exception 'Not authorized';
  end if;
  if p_reissue_note is not null and char_length(p_reissue_note) > 500 then
    raise exception 'Reissue note too long';
  end if;
  if p_reissue_reason_code is null or p_reissue_reason_code not in (
    'staff_assisted_recovery', 'suspected_compromise', 'administrative_correction', 'staff_other'
  ) then
    raise exception 'A valid staff reissue reason code is required';
  end if;
  if p_reissue_reason_code = 'staff_other' and (p_reissue_note is null or trim(p_reissue_note) = '') then
    raise exception 'A note is required when reissue reason is staff_other';
  end if;

  -- Phase 1: cheap, lock-free channel derivation for the reservation
  -- intent-match only.
  v_channel := case when p_bulk_batch_id is null then 'staff_individual' else 'staff_bulk' end;

  select id into v_expected_credential_id from public.qr_credentials
    where application_id = p_application_id and status = 'active';
  if v_expected_credential_id is null then raise exception 'No active credential to reissue'; end if;

  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'reissue', p_application_id, auth.uid(), v_channel, p_bulk_batch_id,
    p_reissue_reason_code, p_reissue_note, v_expected_credential_id
  );
  if v_reservation.state = 'intent_conflict' then
    v_result.outcome := 'pending_operation_conflict';
    return v_result;
  end if;

  -- Phase 2: full bulk-batch validation, FOR SHARE, now correctly
  -- positioned AFTER the advisory + operation locks, before the
  -- application lock.
  if p_bulk_batch_id is not null then
    select * into v_batch from public.qr_bulk_operation_batches where id = p_bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= now()
       or v_batch.created_by_profile_id is distinct from v_caller.id
       or v_batch.created_by_auth_user_id is distinct from auth.uid()
       or v_batch.intended_operation_type <> 'reissue'
    then
      raise exception 'Invalid, expired, or mismatched bulk batch id';
    end if;
  end if;

  -- Lock application, then current active credential, UNCONDITIONALLY.
  select * into v_app from public.applications where id = p_application_id for update;
  if v_app.id is null then raise exception 'Application not found'; end if;

  if v_app.status <> 'accepted' then
    if v_reservation.state = 'exact_match' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      return v_result;
    end if;
    raise exception 'Application is not accepted';
  end if;

  select * into v_current_active from public.qr_credentials
    where application_id = p_application_id and status = 'active' for update;
  if v_current_active.id is null or v_current_active.id <> v_expected_credential_id then
    if v_reservation.state = 'exact_match' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed'
      where id = (v_reservation.op).id;
    end if;
    v_result.outcome := 'stale_reissue_operation';
    return v_result;
  end if;

  if v_reservation.state = 'exact_match' then
    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  v_created_at := clock_timestamp();
  insert into public.qr_lifecycle_operations (
    operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
    channel, bulk_batch_id, reason_code, note, expected_current_credential_id, created_at, expires_at
  ) values (
    'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
    p_reissue_reason_code, p_reissue_note, v_current_active.id, v_created_at, v_created_at + interval '5 minutes'
  ) returning id into v_operation_id;

  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_staff_qr_reissue_transactional(uuid, text, text, uuid) from public;
grant execute on function public.request_staff_qr_reissue_transactional(uuid, text, text, uuid) to authenticated;

-- ================= FINALIZATION (service-role only) =================
-- Same corrections as the issuance finalizer: no update-then-raise
-- (point 2), application row locked FOR UPDATE with a single consolidated
-- select (point 4), fingerprint-based idempotency rather than re-reading
-- mutable qr_credentials fields, and race-safe credential-id/token-hash
-- conflict handling. Additionally (point 8, reissue-specific): the
-- old-row UPDATE (status -> 'replaced') and the new-row INSERT are now
-- wrapped in a single inner EXCEPTION block, so a unique-violation on the
-- INSERT rolls back BOTH statements together — an old credential must
-- never be left transitioned to 'replaced' while the intended new
-- credential failed to insert; that would silently leave the participant
-- with NO active credential at all.
-- CORRECTED this round, three additional points beyond the shared
-- corrections listed above: fingerprint computation now goes through the
-- shared compute_qr_finalization_fingerprint helper (§5.0a); the
-- unique_violation handler now inspects GET STACKED DIAGNOSTICS ...
-- CONSTRAINT_NAME and maps qr_credentials_replacement_target_unique to
-- stale_reissue_operation (a second finalizer already replaced this exact
-- credential — genuinely the same "the credential I was replacing already
-- changed" condition covered by the expected_current_credential_id check
-- above, just caught one step later by the database itself), not merely
-- token_hash_conflict; and the NEW row's issued_by is corrected from an
-- unconditional null to the same channel-conditional expression used for
-- first issuance — a bug where the previous draft's comment claimed this
-- was "unconditionally null" for a stated reason, but the actual
-- requirement (verified against the approved actor-semantics design) is
-- that STAFF reissue must populate issued_by on the new row with the
-- resolved staff profile, exactly like staff first-issuance does; only
-- participant self-reissue leaves it null.
create function public.finalize_qr_reissue_for_server(
  p_operation_id uuid,
  p_new_credential_id uuid,       -- generated by Node, becomes the idempotency key
  p_new_token_hash bytea,
  p_new_token_ciphertext bytea,
  p_new_token_version smallint,
  p_new_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_resulting_credential public.qr_credentials;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_key_row public.qr_encryption_key_registry;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_constraint_name text;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Step 1: lock the lifecycle operation FIRST — it is the authoritative
  -- idempotency record, not qr_credentials.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Operation not found'; end if;
  if v_op.operation_type <> 'reissue' then raise exception 'Operation is not a reissue operation'; end if;

  v_check_now := clock_timestamp();

  -- Step 2/3: consumed-check using the stored finalization_fingerprint —
  -- never the current qr_credentials row's mutable fields, which are
  -- nulled out on later replacement/revocation.
  if v_op.status = 'consumed' then
    if p_new_credential_id is null or p_new_token_hash is null or octet_length(p_new_token_hash) <> 32
       or p_new_token_version is null or p_new_encryption_key_version is null
       or p_new_token_ciphertext is null then
      v_result.outcome := 'idempotency_conflict';
      return v_result;
    end if;
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
    );
    if v_op.resulting_credential_id = p_new_credential_id and v_op.finalization_fingerprint = v_fingerprint then
      select * into v_resulting_credential from public.qr_credentials where id = v_op.resulting_credential_id;
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_resulting_credential.id;
      v_result.status := v_resulting_credential.status;
      v_result.issued_at := v_resulting_credential.issued_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Step 4: expired/cancelled/anything-but-pending — report and RETURN,
  -- never raise after.
  if v_op.status in ('expired', 'cancelled') then
    v_result.outcome := case v_op.status when 'expired' then 'operation_expired' else 'operation_cancelled' end;
    return v_result;
  end if;
  if v_op.status <> 'pending' then
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;
  if v_op.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_operation_id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if p_new_credential_id is null then raise exception 'Credential id is required'; end if;

  -- crypto validation (shape only). These RAISEs happen strictly before
  -- any state-changing UPDATE in this function.
  if p_new_token_hash is null or octet_length(p_new_token_hash) <> 32 then
    raise exception 'Invalid token hash';
  end if;
  if p_new_token_version is null or p_new_token_version <> 1 then
    raise exception 'Unsupported token version';
  end if;
  if p_new_token_ciphertext is null or octet_length(p_new_token_ciphertext) <> 61 then
    raise exception 'Invalid or malformed ciphertext envelope';
  end if;
  if get_byte(p_new_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  -- Fast-path pre-check — the EXCEPTION block around the update+insert
  -- below is the actual correctness guarantee.
  if exists (select 1 from public.qr_credentials where id = p_new_credential_id) then
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;
  if exists (select 1 from public.qr_credentials where token_hash = p_new_token_hash) then
    v_result.outcome := 'token_hash_conflict';
    return v_result;
  end if;

  -- Step 5: lock the application with ONE consolidated select.
  select * into v_app from public.applications where id = v_op.application_id for update;
  if v_app.id is null or v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_operation_id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Step 6: lock the CURRENT active credential and verify it still
  -- matches what the reservation expected.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;
  if v_current_active.id is null or v_current_active.id <> v_op.expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed'
    where id = p_operation_id;
    v_result.outcome := 'stale_reissue_operation';
    return v_result;
  end if;

  -- Step 7: key-registry row via FOR SHARE, re-check status = 'active'.
  -- RETRYABLE: operation stays pending.
  select * into v_key_row from public.qr_encryption_key_registry
    where key_version = p_new_encryption_key_version for share;
  if v_key_row.id is null or v_key_row.status <> 'active' then
    v_result.outcome := 'key_version_not_active';
    return v_result;
  end if;

  -- v_transition_now captured only now, AFTER every required lock
  -- (operation, application, credential, key-registry) is held.
  v_transition_now := clock_timestamp();
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
  );

  -- The old-row transition and the new-row insert are one inner
  -- exception-handled unit — a unique-violation on the INSERT rolls back
  -- the UPDATE to the old row too, so the old credential is never left
  -- 'replaced' with no corresponding new active credential; the lifecycle
  -- operation remains pending and retryable in every branch below.
  begin
    update public.qr_credentials
    set status = 'replaced',
        replaced_at = v_transition_now,
        -- CORRECTED this round (restored actor semantics): null for
        -- participant_self_service, resolved staff profile otherwise —
        -- exactly the same conditional expression used for issued_by on
        -- first issuance.
        replaced_by = case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end,
        replaced_by_credential_id = p_new_credential_id,
        reissue_channel = v_op.channel,
        reissue_reason_code = v_op.reason_code,
        reissue_note = v_op.note,
        token_ciphertext = null,
        encryption_key_version = null
    where id = v_current_active.id;

    -- CORRECTED this round: created_at was previously omitted from this
    -- column list (same gap as finalize_qr_issuance_for_server's insert
    -- above) — added explicitly, sourced from the same v_transition_now as
    -- issued_at, so §1.5's created_at = issued_at trigger invariant holds.
    insert into public.qr_credentials (
      id, application_id, token_version, token_hash, token_ciphertext, encryption_key_version,
      status, issuance_channel, issued_by, issuance_reason_code, issuance_note, issued_at, created_at
    ) values (
      p_new_credential_id, v_op.application_id, p_new_token_version, p_new_token_hash, p_new_token_ciphertext,
      p_new_encryption_key_version, 'active', v_op.channel,
      -- CORRECTED this round: this was unconditionally NULL in the
      -- previous draft, which under-populated the staff-reissue case
      -- (staff reissue must store the staff profile in issued_by on the
      -- NEW credential, exactly as staff first-issuance does — only
      -- participant self-reissue leaves it null). Uses the identical
      -- conditional expression as replaced_by above and as issued_by in
      -- finalize_qr_issuance_for_server.
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end,
      -- issuance_reason_code is intentionally NOT the reissue reason (that
      -- lives in reissue_reason_code on the OLD row) — a fixed marker
      -- distinguishing "this credential exists because of a reissue" from
      -- a first-issuance row's real reason code, unchanged from prior drafts.
      case when v_op.channel = 'participant_self_service' then null else 'reissued_credential' end,
      null, v_transition_now, v_transition_now
    );
  exception
    when unique_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      case v_constraint_name
        when 'qr_credentials_pkey' then
          v_result.outcome := 'idempotency_conflict';
        when 'qr_credentials_token_hash_unique' then
          v_result.outcome := 'token_hash_conflict';
        when 'qr_credentials_replacement_target_unique' then
          -- A concurrent finalizer already recorded a DIFFERENT new
          -- credential as the replacement for v_current_active.id between
          -- this function's expected_current_credential_id check and this
          -- INSERT — the same underlying race the check above exists to
          -- catch, just observed one step later via the database's own
          -- constraint instead of this function's own read.
          v_result.outcome := 'stale_reissue_operation';
        when 'qr_credentials_one_active_per_application' then
          v_result.outcome := 'already_active';
        else
          raise;
      end case;
      return v_result;
  end;

  insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
  values (
    'qr_credential', p_new_credential_id, 'reissued',
    case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end,
    coalesce(v_op.requested_by_profile_id, v_op.requested_by_auth_user_id),
    jsonb_build_object(
      'application_id', v_op.application_id, 'reissue_channel', v_op.channel,
      'previous_credential_id', v_current_active.id
    ),
    v_transition_now
  );

  update public.qr_lifecycle_operations
  set status = 'consumed', consumed_at = v_transition_now, finalized_at = v_transition_now,
      resulting_credential_id = p_new_credential_id, finalization_fingerprint = v_fingerprint
  where id = p_operation_id;

  v_result.outcome := 'reissued';
  v_result.credential_id := p_new_credential_id;
  v_result.status := 'active';
  v_result.replaced_at := v_transition_now;
  v_result.issued_at := v_transition_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_reissue_for_server(
  uuid, uuid, bytea, bytea, smallint, smallint
) from public;
grant execute on function public.finalize_qr_reissue_for_server(
  uuid, uuid, bytea, bytea, smallint, smallint
) to service_role;
```

**§5's disposition on `staff_bulk` (strengthened this round, point 7):** the reservation RPCs
above no longer accept a free-form `p_channel` string at all, and `p_bulk_batch_id` is now the
**last** parameter in both staff signatures (point 6's PostgreSQL default-parameter ordering
fix). A non-null batch id is validated against `qr_bulk_operation_batches` (§1.6a) on **four**
independent conditions, all of which must hold: `status = 'active'`, `expires_at > now()` (the
batch's own column, not a hardcoded interval), `created_by_profile_id` equal to the *resolved
caller's own profile id* (not merely "some staff member created it recently"), and
`intended_operation_type` matching the RPC being called (`'issue'` for
`request_staff_qr_issuance_transactional`, `'reissue'` for
`request_staff_qr_reissue_transactional`) — a batch created for one operation type cannot
authorize the other. `channel` is derived server-side: `null` batch id → `'staff_individual'`;
a batch id passing all four checks → `'staff_bulk'`; anything else raises. The batch id itself is
now persisted onto the resulting `qr_lifecycle_operations` row via `bulk_batch_id`, which is
required exactly when `channel = 'staff_bulk'` and forbidden otherwise (table constraint
`qr_lifecycle_operations_bulk_batch_matches_channel`), immutable once set (trigger), and
foreign-keyed to the batch. This closes both the self-labeling gap (a caller cannot claim
`staff_bulk` by passing a string) and the cross-staff/cross-operation-type reuse gap (a batch
belongs to exactly one staff member and one operation type) — a Node-side bulk orchestration
workflow calls `create_qr_bulk_operation_batch_for_server` once per batch, loops the matching
reservation RPC per application passing that same `p_bulk_batch_id`, then calls
`complete_qr_bulk_operation_batch_for_server` once all reservations in the batch have been
attempted. Both channels still require the identical staff-role check inside the RPC — the
distinction is audit/reporting granularity, not authorization scope — but the label is now
provably genuine rather than caller-asserted.

**Full reissue flow (Node):** identical shape to issuance — call the matching reservation RPC,
and on `outcome = 'reserved'`, generate/encrypt, call `finalize_qr_reissue_for_server`, return
the payload only after `'reissued'`/`'already_finalized'`. On `'cooldown_active'`/
`'daily_limit_reached'`, no operation was ever created and no token was ever generated — Node
never reaches the generate/encrypt step at all for those two outcomes. On `'stale_reissue_operation'`
from either the reservation RPC or the finalizer, Node simply retries the whole flow from step 1
— the reservation RPC re-derives the current active credential from scratch each call, so a stale
observation self-heals on retry rather than requiring any special-case handling.

### 5.2a Issuance/reissue outcome vocabulary — corrected this round to remove stale reissue names

**Correction note:** this table previously carried four reissue-specific rows
(`pending_operation_conflict`, `stale_reissue_operation`, `cooldown_active`, `daily_limit_reached`)
inherited from the pre-`request_key` reissue sketch — none of these were ever actually approved
into the schema/vocabulary; they were struck and replaced with the actual approved participant
self-reissue outcomes. The newly approved staff reissue reservation was added to every applicable
"Produced by" cell — it reuses the identical outcome names already established by the participant
reissue and staff issuance resolvers, no new outcome names introduced for staff reissue.
`reissue_cooldown_active`/`reissue_rate_limit_exceeded` remain exclusive to
`request_my_qr_reissue_transactional` — staff reissue has no participant cooldown or
rolling-rate-limit concept at all. `finalize_qr_issuance_for_server` was previously added —
every row it can produce corrected from "not yet built" to the real function, and
`operation_cancelled` removed from that function's own row (issuance finalization never
re-observes an operation another finalizer call already cancelled mid-retry-sequence the way a
two-finalizer reissue design might — an issuance operation's only finalizer is this one function,
and every terminal state it can reach on replay is already covered by the
`consumed`/`expired`/`cancelled` historical-state handling above). **Further correction, this
round:** the newly approved `finalize_qr_reissue_for_server` is added — it reuses every outcome
name `finalize_qr_issuance_for_server` and the reissue reservation RPCs already established
(`operation_expired`, `already_finalized`, `idempotency_conflict`, `token_hash_conflict`,
`key_version_not_active`, `application_ineligible`, `requester_no_longer_authorized`,
`bulk_batch_unavailable`, `no_active_credential`, `expected_credential_changed`,
`request_key_intent_conflict`) — no new outcome names introduced. It additionally reuses
`active_credential_already_exists` for one specific defense-in-depth path (the
`qr_credentials_one_active_per_application` collision handler, structurally unreachable under
this finalizer's own position-4 lock but resolved safely rather than exposing a raw violation,
exactly mirroring how the issuance finalizer resolves its own analogous collision). This is now
the **one authoritative outcome vocabulary** for every function in §5.1/§5.2 that has been
formally approved (participant issuance, participant reissue, staff issuance, staff reissue
reservation, the issuance finalizer, and the reissue finalizer) — no not-yet-built Phase 6 QR
issuance/reissue function remains.

**All outcomes producible by the approved functions in §5.1/§5.2**, each annotated with whether
the underlying `qr_lifecycle_operations` row (if any) is left `pending` (retryable in place),
transitioned to a terminal state, or never created at all — **for the approved reservation RPCs,
"never created" never applies to a genuine business decision**: every outcome below that reflects
a business decision (as opposed to malformed input) is backed by a real, durable, terminal row,
per the corrected durability rule in §5.2/§5.1 (staff) themselves:

| `outcome` | Produced by | Operation row disposition | Meaning |
|---|---|---|---|
| `reserved` | all four approved reservation RPCs | new row, `pending` | Caller proceeds to generate crypto material and call the finalizer |
| `already_pending` | all four approved reservation RPCs | existing row, unchanged, `pending` | A still-valid pending operation already exists with **identical intent**; reuse its `operation_id` |
| `request_key_intent_conflict` | all four approved reservation RPCs | existing row, unchanged (whatever status it already had) | The same `request_key` was reused by the same requester with a **different** immutable intent (application/channel/reason/note/expected-credential/bulk-batch); the ORIGINAL operation is returned unchanged, never reinterpreted or overwritten |
| `another_operation_pending` | all four approved reservation RPCs | existing row, unchanged, `pending` (belongs to a different `request_key` within the same domain) | A different, still-valid pending operation blocks this domain; `operation_id` populated only if it belongs to the SAME requester (leak-avoidance) |
| `active_credential_already_exists` | `request_my_qr_issuance_transactional`, `request_staff_qr_issuance_transactional`, `finalize_qr_issuance_for_server`, `finalize_qr_reissue_for_server` (defense-in-depth `qr_credentials_one_active_per_application` collision path only, structurally unreachable under the finalizer's own held locks) | → `cancelled`, `terminal_reason_code = 'active_credential_already_exists'` | An active credential already exists; no token ever generated (reservation) or persisted (finalizer) on this path |
| `no_active_credential` | `request_my_qr_reissue_transactional`, `request_staff_qr_reissue_transactional`, `finalize_qr_reissue_for_server` | → `cancelled`, `terminal_reason_code = 'no_active_credential'` | The application has no active credential to reissue |
| `expected_credential_changed` | `request_my_qr_reissue_transactional`, `request_staff_qr_reissue_transactional`, `finalize_qr_reissue_for_server` | → `cancelled`, `terminal_reason_code = 'expected_credential_changed'`, `terminal_related_credential_id` left **null** (CORRECTED this round — see below) | The active credential exists but does not match the operation's own `expected_current_credential_id` — safe to retry from step 1, which re-reads live state itself |
| `reissue_cooldown_active` | `request_my_qr_reissue_transactional` only | → `cancelled`, `terminal_reason_code = 'reissue_cooldown_active'`, `terminal_retry_after_at` set | Participant self-service cooldown (10 minutes since the most recent QUALIFYING consumed reissue — see §5.2's cooldown/rate-limit rules); `retry_after_seconds` populated, derived from the stored `terminal_retry_after_at`. Never produced by staff reissue or either finalizer |
| `reissue_rate_limit_exceeded` | `request_my_qr_reissue_transactional` only | → `cancelled`, `terminal_reason_code = 'reissue_rate_limit_exceeded'`, `terminal_retry_after_at` set | Participant self-service rolling 24-hour limit (3 qualifying consumed reissues); `retry_after_seconds` populated, derived from the stored `terminal_retry_after_at`. Takes precedence over `reissue_cooldown_active` whenever both would otherwise apply. Never produced by staff reissue or either finalizer |
| `requester_no_longer_authorized` | `request_staff_qr_issuance_transactional`, `request_staff_qr_reissue_transactional`, `finalize_qr_issuance_for_server`, `finalize_qr_reissue_for_server` (staff channels only) | → `cancelled`, `terminal_reason_code = 'requester_no_longer_authorized'` | The operation's own recorded requester no longer holds `super_admin`/`program_attendance_manager` at the moment of authoritative recheck — never leaves a pending operation belonging to a now-unauthorized requester |
| `bulk_batch_unavailable` | `request_staff_qr_issuance_transactional`, `request_staff_qr_reissue_transactional`, `finalize_qr_issuance_for_server`, `finalize_qr_reissue_for_server` (`staff_bulk` channel only) | → `cancelled`, `terminal_reason_code = 'bulk_batch_unavailable'` | Only for `channel = 'staff_bulk'`: the authorizing batch is missing, not `active`, expired, wrong `intended_operation_type` (must be `'issue'` for staff issuance, `'reissue'` for staff reissue), or no longer owned by the operation's own recorded requester |
| `application_ineligible` | all four approved reservation RPCs, `finalize_qr_issuance_for_server`, `finalize_qr_reissue_for_server` | → `cancelled`, `terminal_reason_code = 'application_ineligible'` | The application is no longer `accepted` |
| `operation_expired` | all four approved reservation RPCs (replay), both finalizers | → `expired`, `terminal_reason_code = 'ttl_expired'` | The operation's TTL elapsed |
| `already_finalized` | all four approved reservation RPCs (replay) **and** both finalizers (idempotent retry, exact fingerprint + credential-id match) | already `consumed`, unchanged | Safe historical replay of a previously consumed operation's own stored result — never re-derived from the current, possibly-since-mutated `qr_credentials` row |
| `issued` | `finalize_qr_issuance_for_server` (APPROVED) | → `consumed` | New credential successfully created |
| `reissued` | `finalize_qr_reissue_for_server` (APPROVED) | → `consumed` | Old credential atomically replaced, new credential created |
| `idempotency_conflict` | both finalizers (APPROVED) | unchanged — either the operation stays `consumed` (fingerprint/credential-id mismatch on retry) or nothing was ever touched (a `qr_credentials_pkey`/`qr_credentials_replacement_target_unique`/`qr_lifecycle_operations_resulting_credential_unique_idx` collision, or a defense-in-depth deferred-FK check failure, caught and resolved inside the finalizer's own exception handler — the OLD credential's active-to-replaced update rolls back together with the failed new-row insert, so it remains `active`, unchanged) | Either a consumed operation retried with different inputs than its own stored fingerprint, or the caller-supplied new credential id collides with a row belonging to a different operation/replacement entirely |
| `token_hash_conflict` | both finalizers (APPROVED) | unchanged (no row touched — the whole update/insert/consumed-transition/audit block rolled back together, old credential remains active) | The token hash already belongs to a different, already-inserted credential row — a Node-side random-generation collision or a genuine concurrent-finalizer race, caught via `qr_credentials_token_hash_unique` |
| `key_version_not_active` | both finalizers (APPROVED) | **left `pending`, unchanged** — for reissue, the old credential also remains `active`, untouched | The selected encryption key version is missing, `decrypt_only`, or `retired` — retryable: Node re-fetches the current active key version and calls the finalizer again against this SAME still-pending operation, before its TTL elapses |

**Correction round, this pass — three defects fixed in `finalize_qr_reissue_for_server`, one narrow
issuance-finalizer regression fix, one reservation-layer sweep:**

1. `terminal_related_credential_id` was incorrectly set (and read back on replay) for
   `expected_credential_changed` cancellations in `finalize_qr_reissue_for_server` — the approved
   `qr_lifecycle_operations_cancelled_is_consistent` CHECK constraint (§1.7) permits it ONLY for
   `active_credential_already_exists`. Fixed to leave it null and to return the stable outcome name
   alone, with no `credential_id`/`status`/`issued_at`. The identical violation was also present in
   every reservation-layer occurrence of this exact pattern
   (`resolve_blocking_qr_lifecycle_staff_reissue_operation`,
   `request_staff_qr_reissue_transactional_internal`,
   `resolve_blocking_qr_lifecycle_reissue_operation`,
   `request_my_qr_reissue_transactional_internal`) and was corrected identically in all of them
   this same round.
2. The authoritative `clock_timestamp()` used for the TTL recheck and every pending-path decision
   was captured BEFORE the position-5 encryption-key-registry lock was acquired, leaving a gap
   where the operation could expire while the finalizer itself waited on that lock and still be
   finalized/rejected using a stale timestamp. Fixed by moving the authoritative timestamp capture
   to after position 5 in both `finalize_qr_reissue_for_server` and (identical narrow defect,
   discovered only after its own earlier approval) `finalize_qr_issuance_for_server`.
3. The inner `foreign_key_violation` handler in `finalize_qr_reissue_for_server` mapped every
   foreign-key violation to `idempotency_conflict` unconditionally — too broad, risking silently
   masking an unrelated integrity failure. Narrowed to map only
   `qr_credentials_replacement_same_application_fkey` by name; every other foreign-key violation is
   now re-raised.

**Deliberately NOT a `qr_credential_lifecycle_result` outcome:** an invalid/malformed
`p_reissue_reason_code`, a missing required note, or an `p_expected_current_credential_id` that
cannot identify any credential belonging to the participant's own application are all represented
as **raised Postgres exceptions**, per §5.2's own processing-order comment — never as a returned
outcome row. A caller-facing `invalid_reissue_reason` label, if one is needed at the client layer,
describes how the CALLER classifies that raised-exception error shape; it is not, and must never
be listed as, a value the function itself returns in `qr_credential_lifecycle_result.outcome`.

**Why `key_version_not_active` is the one outcome that leaves the operation `pending` (point 2):**
every other terminal outcome above reflects a condition that cannot self-resolve by retrying the
same finalizer call unchanged (the application became ineligible, the credential changed, the TTL
elapsed) — so the operation is correctly moved to a terminal state. An inactive key version is
different: it is a transient server-side input problem (Node selected a key version that was
rotated out between the reservation and the finalize call), fully correctable by Node simply
re-reading the current active key version and retrying with fresh crypto material against the
*same* still-pending operation, with no need to reserve a new one.

### 5.2b Required regression tests — this round's corrections

**Added per this round's requirement.** These are in addition to, not a replacement for, §4.7's
existing eleven-item list — scoped specifically to the reservation/finalizer redesign and its
corrections this round. Each must exist as an executable test before this design's migration
step for §5.1/§5.2 is mergeable, not merely asserted in prose:

**Actor semantics (restores the previously-approved guarantee, this round's regression):**
- Participant self-service issuance (`request_my_qr_issuance_transactional` →
  `finalize_qr_issuance_for_server`) produces a `qr_credentials` row with `issued_by is null`.
  Assert this directly against the row, not merely against the RPC's return shape (the RPC never
  returned `issued_by` to begin with — the actual bug was in the stored row, invisible to a
  test that only inspects `qr_credential_lifecycle_result`).
- Participant self-reissue (`request_my_qr_reissue_transactional` →
  `finalize_qr_reissue_for_server`) produces an old (`replaced`) `qr_credentials` row with
  `replaced_by is null`.
- Staff issuance (`request_staff_qr_issuance_transactional` →
  `finalize_qr_issuance_for_server`) produces a row with `issued_by` equal to the resolved staff
  `profiles.id` — confirming the fix didn't overshoot and null out the legitimate staff case.
- Staff reissue (`request_staff_qr_reissue_transactional` → `finalize_qr_reissue_for_server`)
  produces an old (`replaced`) row with `replaced_by` equal to the resolved staff `profiles.id`.
- A direct attempt to `insert`/`update` a `participant_self_service`-channel row with a non-null
  `issued_by`/`replaced_by` (as `service_role`, bypassing the RPCs entirely) is rejected by
  `qr_credentials_self_service_has_no_actor`/`qr_credentials_self_service_reissue_has_no_actor` —
  proving the guarantee is a durable database constraint, not merely an RPC-level convention that
  a future code change could silently regress again.

**Concurrency (advisory lock + lock-order correctness):**
- Two concurrent calls to `request_my_qr_issuance_transactional()` for the same participant,
  fired without waiting for either to complete, resolve to exactly one `reserved` and one
  `already_pending` — never two `reserved` rows, and never an unhandled unique-violation
  surfacing to either caller.
- The identical concurrency test repeated for `request_my_qr_reissue_transactional`,
  `request_staff_qr_issuance_transactional`, and `request_staff_qr_reissue_transactional`.
- A reservation call and a finalizer call for a *different* operation on the *same* application,
  issued concurrently in opposite lock-acquisition order relative to each other's start, never
  produce a Postgres deadlock (`40P01`) — only ordinary lock waits, per §1.7a's global order.
- Two concurrent `finalize_qr_issuance_for_server` calls for the same `p_operation_id` (a
  legitimate Node-side retry racing itself, e.g. after a timeout that the first call actually
  completed) resolve to exactly one `issued` and one `already_finalized` — never two credential
  rows, never an unhandled unique-violation.

**Bulk-batch ownership and cross-type binding:**
- A bulk batch created by staff member A (`create_qr_bulk_operation_batch_for_server` with A's
  `auth_user_id`/`profile_id`) cannot be used by staff member B's reservation call — rejected as
  an invalid/mismatched batch id, even though B independently holds
  `super_admin`/`program_attendance_manager` and could create their own batch.
- A batch created with `intended_operation_type = 'issue'` cannot be used to authorize a
  `request_staff_qr_reissue_transactional` call, and vice versa.
- `create_qr_bulk_operation_batch_for_server` rejects a call where `p_staff_auth_user_id <>
  p_staff_profile_id` outright, before any row is inserted.
- A `completed`/`cancelled` batch (via `complete_qr_bulk_operation_batch_for_server`) can no
  longer be used to authorize a new reservation, even if its `expires_at` has not yet passed.

**Unique-constraint race safety:**
- Simulate a token-hash collision (two finalizer calls constructed with identical
  `p_token_hash`, launched concurrently) and confirm exactly one resolves `issued`/`reissued` and
  the other resolves `token_hash_conflict` — never a raw `23505 unique_violation` propagating out
  of either RPC call, and the losing call's `qr_lifecycle_operations` row remains `pending`
  (retryable with a fresh, non-colliding hash), not silently transitioned to any terminal state.
- The reissue-specific variant: the same collision test, additionally asserting that when the
  new-row `INSERT` fails, the OLD credential's row is still `status = 'active'` (the inner
  exception block's rollback of the `UPDATE` alongside the failed `INSERT` is what this test
  actually proves) — a participant must never be left with zero active credentials because of a
  losing race on a collision this improbable.

**Historical idempotency after later lifecycle changes:**
- Finalize an issuance to `issued`. Separately, revoke that same credential
  (`revoke_qr_credential_transactional`, once §5.3 is implemented) or reissue it (a second,
  independent reissue cycle), which nulls `token_ciphertext`/`encryption_key_version` on that row
  per §1.2's `qr_credentials_revoked_is_consistent`/`replaced_is_consistent` constraints. THEN
  retry the *original* `finalize_qr_issuance_for_server` call with the exact original input.
  Assert it still returns `already_finalized` with the correct `credential_id` — proving the
  fingerprint comparison (stored on the operation row, computed once, at finalization time) does
  not depend on `qr_credentials.encryption_key_version`, which is now `null` on that row at the
  time of the retry.
- The identical test repeated for `finalize_qr_reissue_for_server`.

**Stale pending-operation terminalization (added this round):**
- Create a pending issuance operation, advance time past its 5-minute TTL (or wait in a
  slow-running integration test), then issue a *new*, intent-identical reservation call. Assert
  the stale row transitions to `expired`/`ttl_expired` (via `reserve_or_reuse_qr_lifecycle_operation`'s
  own expiry branch) in the SAME transaction that creates the new `reserved` operation — never
  left `pending` past its TTL, and never silently abandoned without a `finalized_at`/
  `terminal_reason_code`.
- Create a pending reissue operation, then externally change the active credential (e.g. an
  independent staff-forced reissue completes first). Call the SAME participant's reissue
  reservation RPC again with identical intent. Assert the stale operation is explicitly cancelled
  with `terminal_reason_code = 'expected_credential_changed'` — not left pending, and not
  returned as `already_pending`.
- The identical two tests for a pending operation whose application became ineligible
  (`terminal_reason_code = 'application_ineligible'`) between reservation and a later reservation
  call for the same intent.

**Named-constraint outcome mapping (added this round):**
- Force a `qr_credentials_pkey` collision (attempt to finalize with a `p_credential_id` that a
  concurrent transaction inserts first) and assert the outcome is `idempotency_conflict`, sourced
  from `GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME = 'qr_credentials_pkey'` — not a guessed or
  defaulted classification.
- Force a `qr_credentials_token_hash_unique` collision and assert `token_hash_conflict` via the
  same named-constraint path.
- Force a `qr_credentials_one_active_per_application` collision (a concurrent finalizer commits
  an active credential for the same application between this finalizer's own pre-check and its
  `INSERT`) and assert `already_active` — not misreported as `token_hash_conflict`.
- Force a `qr_credentials_replacement_target_unique` collision in the reissue finalizer (a
  concurrent finalizer already recorded a different `replaced_by_credential_id` for the same old
  row) and assert `stale_reissue_operation` — not misreported as `token_hash_conflict`.
- Directly unit-test that an unrecognized/unexpected constraint name in the `CASE`'s `else` branch
  re-raises the original exception rather than silently mapping to any outcome — inject a
  contrived exception in a test harness if no natural trigger exists for this branch in ordinary
  operation.

**Canonical fingerprint correctness (added this round):**
- Two finalization calls with identical `(operation_type, credential_id, token_hash,
  token_version, encryption_key_version, ciphertext)` produce byte-identical
  `finalization_fingerprint` values via `compute_qr_finalization_fingerprint` — determinism.
- Two calls differing in exactly one field (e.g. `token_version` off by one, holding everything
  else constant) produce different fingerprints — no accidental collision from the binary
  encoding's fixed-width fields.
- An `issue`-type and a `reissue`-type call with otherwise-identical remaining fields produce
  different fingerprints — the domain separator plus the length-prefixed `operation_type` field
  are both load-bearing, not decorative.

**pgcrypto resolution under the hardened search path (added this round):**
- Call `compute_qr_finalization_fingerprint` directly (as a privileged test role) in a session
  where `search_path` has been explicitly reset to exclude `extensions`, confirming
  `extensions.digest`'s schema-qualification means the function resolves correctly regardless of
  the calling session's own `search_path` — this is the actual regression this round's correction
  targets (the previous unqualified `digest()` call would have failed under exactly this
  condition, which every `security definer` function's own `set search_path = public, pg_temp`
  guarantees for calls originating from within this document's own RPCs, but is worth testing
  directly against the helper in isolation). `pg_catalog.uuid_send`/`pg_catalog.int2send` resolve
  regardless of `search_path` since `pg_catalog` is always implicitly consulted first by Postgres
  — no equivalent test is needed for those two, only for the genuine `pgcrypto` dependency.
- Confirm `create extension if not exists pgcrypto with schema extensions` is idempotent — running
  the full migration twice against a fresh database does not error on the second run.

**Obsolete-overload removal (added this round):**
- After running the §4.6a migration, query `pg_proc` for every name in `v_obsolete_names` and
  assert zero rows for each.
- As a participant `authenticated` test session, call each obsolete name via PostgREST and assert
  a function-not-found error, never a permission error.
- The identical test as a `scanner_device` test session.
- Run this entire test suite twice in sequence against a fresh migration apply — once
  immediately after migration, once after an unrelated later migration has run — to catch a
  regression where some later change accidentally reintroduces one of these names.

### 5.2c Trigger-level regression tests for §1.5's five corrections — this round's addition

**Corrected this round: moved from raw SQL `do $$ ... $$` blocks to a real Vitest file,**
`tests/attendance/qr-credentials-lifecycle-trigger.test.ts`, matching this repository's actual
established live-test convention (`tests/attendance/scan-attempt-live.test.ts`,
`tests/schedule/concurrency.test.ts`): real Supabase Auth users via `admin.auth.admin.createUser`
(which fires `handle_new_user()` and creates the matching `profiles` row automatically —
`profiles` is never inserted directly, only updated afterward for `role`), one real `accepted`
`applications` row per fixture linked through its real `applicant_id` (respecting
`applications_one_per_applicant`), and `service_role` inserts/updates against `qr_credentials`
issued directly via the Supabase JS client — bypassing every reservation/finalizer RPC entirely —
to prove the trigger is a genuine second, independent defense layer, not merely a restatement of
what the RPCs already check.

The previous draft's abbreviated `insert into public.applications (id, status) values (v_app_id,
'accepted')` / `insert into public.profiles (id, role) values (...)` fixtures did not reflect the
actual repository schema — verified against `supabase/migrations/20260721200747_roles_and_profiles.sql`
and `supabase/migrations/20260721202027_applications_table.sql`: `profiles.id` is a foreign key to
`auth.users(id) on delete cascade` populated only via the `on_auth_user_created` trigger (a direct
`insert into profiles` with a fabricated `id` was never a valid row), `profiles.full_name`/`email`
are `not null` with no default, and `applications.applicant_id` is both a foreign key to
`profiles(id)` and covered by the `applications_one_per_applicant` unique index. The rewritten
test file creates a genuine `auth.users` row (and its cascaded `profiles` row) for every fixture,
never a fabricated application id disconnected from a real applicant.

Also corrected: every negative test now captures `error.code`/`error.message` (Supabase JS's
surfacing of Postgres's `RETURNED_SQLSTATE`/`MESSAGE_TEXT`) and asserts the **exact** trigger
message via the shared `expectTriggerRejection()` helper, rather than treating any thrown error as
proof the intended branch fired — a `raise exception '<msg>'` with no explicit SQLSTATE always
surfaces as code `'P0001'`, which is asserted alongside the literal message text, distinguishing
the trigger's own raise from an unrelated FK violation (`23503`), unique violation (`23505`), or
CHECK violation (`23514`) that could otherwise produce a false-positive "rejected" result. Every
reason code used in a fixture (`administrative_correction`, `staff_assisted_recovery`) is a real,
CHECK-constraint-valid value from §1.4's vocabulary — not a placeholder that would itself trigger
an unrelated CHECK failure and mask the trigger assertion under test.

Binary fixtures use Node's built-in `crypto.randomBytes`/`Buffer`, not any Postgres-side pgcrypto
call — `token_hash`/`token_ciphertext` are constructed client-side and sent to PostgREST as
`"\x" + hex`-encoded strings (PostgREST's own documented `bytea` wire format), so the earlier
concern about `gen_random_bytes` needing `extensions.` qualification does not apply to this test
file at all (it only ever mattered for SQL run server-side, e.g. inside a `security definer`
function's own body, which none of these tests are).

Every test resolves the current active encryption key version live, per call, via a
`getActiveKeyVersion()` helper (`select key_version from qr_encryption_key_registry where
status = 'active' limit 1`) rather than caching it once — the decrypt_only-key test rotates the
registry's active key mid-suite, and a cached value would silently desynchronize every test that
ran after it. Every test constructs its own isolated `auth.users` row, `profiles` row, `applications`
row, credential id, and token hash (via `createCredentialFixture()`/`createStaffActor()`) — no two
tests ever share an `application_id`, so `qr_credentials_one_active_per_application` cannot collide
across tests regardless of run order, and no test can fail because another test left an active
credential behind.

**`replaced_by`/replacement tests require a real same-application replacement, which requires a
single-transaction test helper.** §1.2's `qr_credentials_replacement_same_application_fkey` now
requires the replacement target to share the OLD row's `application_id` (this round's correction,
below §1.2). The real finalizer (§5.2) satisfies this by updating the OLD row to `status =
'replaced'` (freeing `qr_credentials_one_active_per_application`'s slot) and inserting the NEW
`active` row on the SAME application in one transaction — the deferred FK only resolves at that
transaction's commit. PostgREST/Supabase JS has no way to span one transaction across two separate
REST calls, so a JS test issuing the UPDATE and the INSERT as two separate `.update()`/`.insert()`
calls cannot reproduce this: the first call's own implicit transaction would commit (and fail the
deferred FK check) before the second call's INSERT ever runs, and reversing the order fails
`qr_credentials_one_active_per_application` instead (two active rows on one application, however
briefly). A same-application replacement is therefore only reproducible through a single
transaction — so the replacement-side trigger tests call a narrow, test-only, `security definer`
helper that performs exactly the same two statements the real finalizer's inner block does, nothing
more, letting the JS test drive both through one `.rpc()` call.

**This helper is NOT part of this document's migration surface at all.** It is defined in its own
standalone file, `tests/attendance/qr-credentials-lifecycle-trigger.test-only-setup.sql` —
deliberately outside `supabase/migrations/` so it is never picked up by the normal migration-apply
flow and never ships to any deployed environment. That file (and its paired teardown,
`qr-credentials-lifecycle-trigger.test-only-teardown.sql`) is applied only against a disposable
local Supabase instance (`supabase start` / `supabase db reset --local`), never a shared, staging,
or production project — enforced both by the test file's own runtime guard (rejects any
`NEXT_PUBLIC_SUPABASE_URL` whose host isn't `127.0.0.1`/`localhost`, short of an explicit
CI-only override) and by keeping the function definitions entirely out of the migration chain.

**Grants, corrected this round.** An earlier draft revoked `EXECUTE` from `service_role` and
claimed `service_role`'s RLS bypass also bypassed function `EXECUTE` privileges — that claim was
wrong. RLS and function-level `EXECUTE` grants are independent Postgres mechanisms; a function with
no `EXECUTE` grant to a role is simply not callable by that role regardless of what it bypasses
elsewhere. Since the Vitest suite invokes this helper through the service-role Supabase client, the
correct grant list revokes from `public, anon, authenticated` and grants `EXECUTE` explicitly to
`service_role` — the one role the test harness actually needs.

**Scope, clarified this round: what this helper proves and does not prove.** It performs the same
two-statement *shape* the real finalizer's inner block uses (old row → `replaced`, new row inserted
`active`, same application, deferred FK resolved at commit) — proving the atomic old-row transition
plus new-row insertion, same-application lineage via
`qr_credentials_replacement_same_application_fkey`, rollback of the old-row UPDATE when the new-row
INSERT fails, and `qr_credentials_enforce_lifecycle_trigger()`'s `replaced_by`/`reissue_channel`
validation on the OLD row exactly as the real finalizer's own UPDATE would trigger it. **It is not
a reproduction of `finalize_qr_reissue_for_server`'s own logic** — it always inserts the NEW row
with `issuance_channel = 'system'`/`issued_by = null`, regardless of what `reissue_channel` was
passed for the OLD row, and does not implement the real finalizer's conditional expression for
populating the NEW row's `issued_by` from a resolved staff actor. It must not be described as
implementing "the same finalizer logic," and it does not establish that staff reissue correctly
sets the new credential's `issued_by`. Deferred to Sub-pass 2, against the real
`finalize_qr_reissue_for_server` RPC: staff reissue setting the OLD row's `replaced_by` via the
finalizer's own resolved-actor logic (as opposed to this helper's caller-supplied `p_replaced_by`);
staff reissue setting the NEW row's `issued_by`; participant self-reissue leaving both actor fields
null via the finalizer's own conditional expression; and a failure of the NEW row's INSERT rolling
back the OLD row's transition inside the *real* finalizer specifically (this helper's own rollback
behavior, proven above, is a structural stand-in for that same guarantee, not a test of the
finalizer's own exception-handling block).

**Requires a disposable local database — corrected this round.** An earlier draft instructed
reviewers to run this suite "against whichever project `.env.local` references," matching this
repo's other live-test files. That is wrong for this specific file: it creates permanent
`qr_encryption_key_registry` transitions (`rotate_encryption_key_version_for_server` calls with no
corresponding "un-rotate" in its own `afterAll`) and depends on two `security definer` test-only
helpers that must never exist on a shared project. The test file now refuses to start
(`assertDisposableLocalDatabase`, top of the file) unless `NEXT_PUBLIC_SUPABASE_URL`'s host is
`127.0.0.1`/`localhost`, or `QR_TRIGGER_TEST_ALLOW_REMOTE=1` is explicitly set for an isolated CI
runner provisioning its own throwaway instance. Verified exact local sequence (Supabase CLI 2.109.1
installed in this worktree; `supabase db query --local -f <file>`, `supabase db reset --local`, and
`supabase start` all confirmed present in this version's `db`/root subcommands):

```bash
supabase start
```

`supabase start` prints the local API URL and local `service_role` key (re-printable at any time
via `supabase status -o env`); point `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` at those LOCAL values, not the shared project's, before running.

**Failure-safe runner, corrected again this round.** The manual six-command sequence (reset, setup,
run, teardown, reset) is not itself failure-safe: if Vitest fails or is interrupted between the
setup and teardown steps, the test-only `security definer` functions are left installed on the local
database with nothing to remove them.
`scripts/run-qr-credentials-lifecycle-trigger-tests.sh` wraps the same sequence in a `trap ... EXIT`.
This round's corrections to the script itself:

1. **Environment loading, corrected.** `vitest.config.ts` loads `.env.local` only inside the Vitest
   process, which starts after the script's own local-database guard needs to run and after the SQL
   setup step. A prior version of the script read `NEXT_PUBLIC_SUPABASE_URL` directly from the shell
   environment, which is empty unless the caller separately exported it by hand — the guard would
   silently see an empty string and (depending on the exact check) either false-reject or, worse,
   false-accept. The script now sources `.env.local` itself (`set -a; . .env.local; set +a`) before
   running its guard, so the guard evaluates the actual configured value. Strictly local, with no
   remote-CI override in this script at all — an isolated CI runner should invoke Vitest directly
   through its own workflow step, not through this script.
2. **Local-stack availability check, added.** The script now runs `supabase status` (exit-code check
   only) before `supabase db reset --local`, and fails with a clear message ("run `supabase start`
   first") if the local stack isn't up, rather than letting `db reset` fail with a more confusing
   underlying error.
3. **Cleanup failure now affects the exit code, corrected.** A prior version logged a warning when
   teardown or the final reset failed but still exited with Vitest's own exit code — so a passing
   test run with FAILED cleanup could report success (exit 0) while the test-only functions remained
   installed. `cleanup_failed` is now tracked independently inside the trap and forces a nonzero
   final exit whenever teardown or the final reset fails, regardless of Vitest's own outcome. When
   cleanup succeeds, Vitest's own exit code is preserved exactly.
4. **`npx` version pinning, corrected.** A bare `npx vitest` with no local `node_modules` can
   silently fetch and run a different Vitest version from the registry. The script now checks
   `node_modules` exists upfront (failing with "run `npm ci` first" if not) and invokes
   `npx --no-install vitest run ...`, which refuses to fetch anything and errors instead of silently
   substituting a different version.

Exact invocation:

```bash
npm ci   # only if node_modules is not already present
npm run test:qr-trigger
```

(equivalently: `bash scripts/run-qr-credentials-lifecycle-trigger-tests.sh`, run from anywhere — the
script `cd`s to the repo root itself). This is now the documented way to run this suite; the
six-command manual sequence above remains accurate as a description of what the script does
internally, but should not be run by hand step-by-step when the script is available.

**Teardown SQL, corrected to be idempotent under partial failure.** A prior version of
`qr-credentials-lifecycle-trigger.test-only-teardown.sql` issued a separate
`revoke all on function ... from service_role` before each `drop function if exists` — if setup only
partially completed, or the teardown file is re-run after an earlier run already dropped one
function, `REVOKE` on a nonexistent function raises an error and halts the rest of the file before
its later statements ever run. The file is now exactly two `drop function if exists` statements
(which are themselves unconditionally safe no-ops when absent, and remove any grants along with the
function — nothing is left for a separate `REVOKE` to do), safe to run zero, one, or many times in
any order relative to how much of setup actually succeeded.

**Two test refinements, this round:**
- The unknown-key-version test (`rejects an insert referencing a key version that does not exist in
  the registry at all`) no longer computes `max(key_version) + 1` — at the `smallint` boundary
  (`32767`), that arithmetic overflows to `32768`, which `encryption_key_version`'s own CHECK
  constraint rejects before the value ever reaches the trigger, testing the wrong failure path
  entirely. It now scans `1..32767` for the first genuinely unused version
  (`findUnusedKeyVersion()`), failing with an explicit precondition error if none exists.
- The decrypt-only-key rollback test no longer predicts which temporary key version
  `test_only_rotate_and_probe_inactive_key` will internally select (a prior version computed
  `max(key_version) + 1` client-side, before the helper's own advisory lock was ever acquired — an
  external guess about an internal implementation detail, independent of the helper's own
  lock-protected selection even in a single-writer disposable environment). It now captures a full
  ordered snapshot of the entire `qr_encryption_key_registry` (`key_version`, `status`,
  `activated_at`, `retired_at`) before and after the call and asserts exact equality — proving the
  rotation left no trace at all without needing to know which version the helper picked.

The full test file (see `tests/attendance/qr-credentials-lifecycle-trigger.test.ts` in this
worktree) covers: correction 1 (participant/system-channel `issued_by`/`replaced_by` null,
staff-channel non-null, including the `system` reissue-channel gap not covered by
`qr_credentials_self_service_reissue_has_no_actor`); correction 2 (authorized-role validation for
`issued_by`, `revoked_by`, and `replaced_by`, both a rejection case and an acceptance case for
each); correction 3 (`created_at = issued_at`, both a mismatch rejection and an exact-match
acceptance); correction 4 (61-byte length in both directions and the version-byte tag, plus one
fully-valid acceptance case); correction 5, race-safe (a genuine single-transaction rollback via
`test_only_rotate_and_probe_inactive_key` — captures the active key, rotates to a temporary unused
version, attempts the now-rejected insert, asserts the exact `P0001` message, then unconditionally
raises a documented sentinel so the rotation itself rolls back with everything else; the Vitest test
asserts that sentinel and independently re-verifies the original key is still `active`, the
temporary key version does not exist, and no probe credential exists); `ON DELETE SET NULL`
remaining permitted after issuance, revocation, and replacement, exercised via real
`admin.auth.admin.deleteUser` calls rather than a hand-simulated update, for all three actor
columns; and `qr_credentials_replacement_same_application_fkey` (this round's addition), both a
rejection of a replacement target on a different application (a plain single-request UPDATE, since
rejecting the deferred composite FK needs no same-transaction trick — only a successful replacement
does, via `test_only_replace_qr_credential_same_application`) with a full rollback assertion on the
OLD row's `status`/`replaced_at`/`replaced_by`/`replaced_by_credential_id`/`reissue_channel`/
`token_ciphertext`/`encryption_key_version`, and, implicitly, every successful replacement test's
own assertion that the new row's `application_id` matches the old row's.

**Deferred to Sub-pass 2, against the real finalizer RPCs (not this file's test-only helpers):**
staff reissue setting the OLD row's `replaced_by` via `finalize_qr_reissue_for_server`'s own
resolved-actor conditional expression; staff reissue setting the NEW row's `issued_by` via that same
finalizer; participant self-reissue leaving both actor fields null via the finalizer's own logic;
a failure of the NEW row's INSERT rolling back the OLD row's transition inside the real finalizer
specifically; a `retired`-key-version rejection test (deferred because
`is_encryption_key_version_active()` has exactly one "not active" branch shared by both
`decrypt_only` and `retired` — a retired-key test would exercise no code path this file's
`decrypt_only` test doesn't already exercise, and reaching `retired` requires
`retire_encryption_key_version`'s `auth.uid()`-resolved `super_admin` session rather than the
`service_role` admin client this file otherwise uses throughout); and every item from §5.2b's
original prose requirements not yet implemented as executable tests at all — concurrency/advisory-
lock races, bulk-batch ownership and cross-type binding, unique-constraint race safety, historical
idempotency after later lifecycle changes, stale pending-operation terminalization, named-constraint
outcome mapping, canonical fingerprint correctness, pgcrypto search-path resolution, and
obsolete-overload removal. Sub-pass 1 has covered only `qr_credentials_enforce_lifecycle_trigger()`
(§5.2c); the full §5.2b list remains unaddressed.

### 5.3 `revoke_qr_credential_transactional`

```sql
create function revoke_qr_credential_transactional(
  p_application_id uuid,
  p_revocation_reason_code text,
  p_revocation_note text
) returns qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller profiles;
  v_old qr_credentials;
  v_result qr_credential_lifecycle_result;
begin
  -- §1.4: revocation reason must be a valid code; 'staff_other' requires a
  -- non-empty trimmed note.
  if p_revocation_reason_code is null or p_revocation_reason_code not in (
    'suspected_compromise', 'participant_request', 'administrative_correction', 'staff_other'
  ) then
    raise exception 'A valid revocation reason code is required';
  end if;
  if p_revocation_reason_code = 'staff_other' and (p_revocation_note is null or trim(p_revocation_note) = '') then
    raise exception 'A note is required when revocation reason is staff_other';
  end if;
  if p_revocation_note is not null and char_length(p_revocation_note) > 500 then
    raise exception 'Revocation note too long';
  end if;

  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin','program_attendance_manager') then
    raise exception 'Not authorized';
  end if;

  perform 1 from applications where id = p_application_id for update;

  select * into v_old from qr_credentials
    where application_id = p_application_id and status = 'active' for update;
  if v_old.id is null then raise exception 'No active credential to revoke'; end if;

  update qr_credentials
  set status = 'revoked',
      revoked_at = now(),
      revoked_by = v_caller.id,
      revocation_reason_code = p_revocation_reason_code,
      revocation_note = p_revocation_note,
      token_ciphertext = null,
      encryption_key_version = null
  where id = v_old.id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values ('qr_credential', v_old.id, 'revoked', 'admin', v_caller.id,
          jsonb_build_object('application_id', p_application_id));

  v_result.outcome := 'revoked';
  v_result.credential_id := v_old.id;
  v_result.status := 'revoked';
  v_result.revoked_at := now();
  return v_result;
end;
$$;

revoke all on function revoke_qr_credential_transactional(uuid, text, text) from public;
grant execute on function revoke_qr_credential_transactional(uuid, text, text) to authenticated;
```

### 5.4 `resolve_qr_token_for_scan`

```sql
create function resolve_qr_token_for_scan(
  p_token_hash bytea,
  p_session_id uuid
) returns table (scan_attempt_id uuid, application_id uuid, result text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller profiles;
  v_session record;
  v_assignment scanner_assignments;
  v_credential qr_credentials;
  v_attempt_id uuid;
  v_result text;
  v_app_id uuid;
begin
  if octet_length(p_token_hash) <> 32 then raise exception 'Invalid token hash'; end if;

  -- Pattern C in full (§3): role-checked identity + authoritative assignment.
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role <> 'scanner_device' then
    raise exception 'Not authorized';
  end if;
  select id, room_id into v_session from sessions where id = p_session_id;
  if v_session.id is null then raise exception 'Session not found'; end if;
  select * into v_assignment from scanner_assignments
    where scanner_user_id = v_caller.id and is_active = true
      and (session_id = p_session_id or room_id = v_session.room_id)
    limit 1;
  if v_assignment.id is null then raise exception 'Not authorized for this session'; end if;

  select * into v_credential from qr_credentials where token_hash = p_token_hash;

  if v_credential.id is null then
    v_result := 'token_unknown';
    v_app_id := null;
  elsif v_credential.status = 'revoked' then
    v_result := 'token_revoked';
    v_app_id := v_credential.application_id;
  elsif v_credential.status = 'replaced' then
    v_result := 'token_replaced';
    v_app_id := v_credential.application_id;
  else -- 'active'
    v_app_id := v_credential.application_id;
    if is_application_eligible_for_admission(v_app_id) then
      v_result := 'token_valid_pending_confirmation';
    else
      v_result := 'token_ineligible';
    end if;
  end if;

  -- Every non-pending outcome is written already finalized, with
  -- expires_at left null, per scan_attempts_finalization_state_check
  -- (§1.3). Only the pending outcome gets a null finalized_at and a
  -- non-null expires_at.
  insert into scan_attempts (
    application_id, session_id, scanned_by, result, finalized_at, expires_at
  ) values (
    v_app_id, p_session_id, v_caller.id, v_result,
    case when v_result = 'token_valid_pending_confirmation' then null else now() end,
    case when v_result = 'token_valid_pending_confirmation' then now() + interval '5 minutes' else null end
  ) returning id into v_attempt_id;

  return query select v_attempt_id, v_app_id, v_result;
end;
$$;

revoke all on function resolve_qr_token_for_scan(bytea, uuid) from public;
grant execute on function resolve_qr_token_for_scan(bytea, uuid) to authenticated;
```

`p_device_identifier` removed entirely, per §3's corrected Pattern C. `token_revoked`/
`token_replaced`/`token_ineligible` populate `application_id` for internal audit/classification,
but the Node caller for these three outcomes **never** calls `getScannerParticipantSummary` —
personal information never reaches the scanner UI for these outcomes.

### 5.5 `confirm_scan_attempt_transactional`

```sql
create function confirm_scan_attempt_transactional(
  p_scan_attempt_id uuid,
  p_time_slot_group_key text
) returns table (result text, resulting_attendance_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller profiles;
  v_attempt scan_attempts;
  v_session record;
  v_assignment scanner_assignments;
  v_decision record;
begin
  -- Pattern C in full — re-derived independently, never trusting that
  -- resolve_qr_token_for_scan already checked it for this same request.
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role <> 'scanner_device' then
    raise exception 'Not authorized';
  end if;

  select * into v_attempt from scan_attempts where id = p_scan_attempt_id for update;
  if v_attempt.id is null then raise exception 'Scan attempt not found'; end if;

  select id, room_id into v_session from sessions where id = v_attempt.session_id;
  select * into v_assignment from scanner_assignments
    where scanner_user_id = v_caller.id and is_active = true
      and (session_id = v_attempt.session_id or room_id = v_session.room_id)
    limit 1;
  if v_assignment.id is null then raise exception 'Not authorized for this session'; end if;

  if v_attempt.finalized_at is not null then
    raise exception 'Scan attempt already finalized';
  end if;
  if v_attempt.result <> 'token_valid_pending_confirmation' then
    raise exception 'Scan attempt is not pending confirmation';
  end if;

  -- Independent expiry re-check: correctness never depends solely on the
  -- scheduled job having already run. expires_at is explicitly cleared
  -- here too, per §1.3's finalization-constraint requirement.
  if v_attempt.expires_at <= now() then
    update scan_attempts set result = 'expired_pending', finalized_at = now(), expires_at = null
    where id = p_scan_attempt_id;
    raise exception 'Scan attempt has expired';
  end if;

  -- Shared decision core (§5.8) re-checks capacity, duplicate attendance,
  -- conflicts, and session policy AT THIS MOMENT.
  select * into v_decision from perform_admission_decision(
    v_attempt.application_id, v_attempt.session_id, v_caller.id,
    p_time_slot_group_key, false
  );

  update scan_attempts
  set result = v_decision.decision,
      resulting_attendance_id = v_decision.attendance_id,
      finalized_at = now(),
      expires_at = null
  where id = p_scan_attempt_id;

  return query select v_decision.decision, v_decision.attendance_id;
end;
$$;

revoke all on function confirm_scan_attempt_transactional(uuid, text) from public;
grant execute on function confirm_scan_attempt_transactional(uuid, text) to authenticated;
```

### 5.6 `cancel_scan_attempt_transactional`

```sql
create function cancel_scan_attempt_transactional(p_scan_attempt_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller profiles;
  v_attempt scan_attempts;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role <> 'scanner_device' then
    raise exception 'Not authorized';
  end if;

  select * into v_attempt from scan_attempts where id = p_scan_attempt_id for update;
  if v_attempt.id is null then raise exception 'Scan attempt not found'; end if;
  if v_attempt.finalized_at is not null then
    return; -- idempotent: already finalized (by anyone/anything) is not an error to cancel
  end if;

  update scan_attempts set result = 'cancelled_by_operator', finalized_at = now(), expires_at = null
  where id = p_scan_attempt_id;
end;
$$;

revoke all on function cancel_scan_attempt_transactional(uuid) from public;
grant execute on function cancel_scan_attempt_transactional(uuid) to authenticated;
```
Cancellation is deliberately idempotent (silently succeeds if already finalized by something
else) rather than raising, since "operator taps Cancel just as the row happens to expire" is a
benign race, not an error worth surfacing. This function does **not** re-validate scanner
assignment against the attempt's session — cancellation is a low-risk operation (it only ever
moves a pending row to `cancelled_by_operator`, never touches admission state) and any
authenticated `scanner_device` may cancel any pending attempt; if tighter scoping is wanted here
too, it can be added symmetrically with confirm's assignment check, flagged as an open
refinement rather than assumed necessary.

### 5.7 `record_malformed_scan_attempt`

```sql
create function record_malformed_scan_attempt(
  p_session_id uuid,
  p_payload_version smallint   -- null if not even the version prefix was parseable
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller profiles;
  v_session record;
  v_assignment scanner_assignments;
  v_attempt_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role <> 'scanner_device' then
    raise exception 'Not authorized';
  end if;

  select id, room_id into v_session from sessions where id = p_session_id;
  if v_session.id is null then raise exception 'Session not found'; end if;
  select * into v_assignment from scanner_assignments
    where scanner_user_id = v_caller.id and is_active = true
      and (session_id = p_session_id or room_id = v_session.room_id)
    limit 1;
  if v_assignment.id is null then raise exception 'Not authorized for this session'; end if;

  insert into scan_attempts (application_id, session_id, scanned_by, result, finalized_at, expires_at, metadata)
  values (
    null, p_session_id, v_caller.id, 'token_malformed', now(), null,
    case when p_payload_version is not null then jsonb_build_object('payload_version', p_payload_version) else null end
  ) returning id into v_attempt_id;

  return v_attempt_id;
end;
$$;

revoke all on function record_malformed_scan_attempt(uuid, smallint) from public;
grant execute on function record_malformed_scan_attempt(uuid, smallint) to authenticated;
```
Node never writes to `scan_attempts` directly for the malformed case; it calls this RPC, which
independently re-derives and re-validates scanner identity and assignment.

### 5.8 `perform_admission_decision` (internal helper — refactor, not new logic)

```sql
create function perform_admission_decision(
  p_application_id uuid, p_session_id uuid, p_scanned_by uuid,
  p_time_slot_group_key text, p_is_override_caller boolean
) returns table (decision text, attendance_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- BODY: the exact existing decision/write logic currently inlined in
  -- scan_attempt_transactional (advisory lock, application/session load,
  -- capacity/duplicate/conflict checks, attendance_records insert) — moved
  -- here VERBATIM, with zero behavioral change. resolveAdmissionDecision's
  -- TS mirror requirement is UNCHANGED: this SQL body and the TS function
  -- must still be kept logically identical. p_device_identifier is REMOVED
  -- from this shared core too (§5.11's retirement of the old signature) —
  -- it was never used in any capacity/duplicate/conflict decision logic,
  -- only forwarded into the final scan_attempts row, which both callers
  -- (scan_attempt_transactional and confirm_scan_attempt_transactional)
  -- now handle themselves at their own insert/update site instead.
  --
  -- scan_attempt_transactional (RETIRED OLD SIGNATURE, NEW SIGNATURE per
  -- §5.11) calls this function, then INSERTS a fresh scan_attempts row with
  -- the returned decision.
  --
  -- confirm_scan_attempt_transactional calls this SAME function, but
  -- UPDATES an already-locked pending row instead of inserting a new one —
  -- this is what guarantees exactly one scan_attempts row per QR submission.
end;
$$;

revoke all on function perform_admission_decision(uuid, uuid, uuid, text, boolean) from public;
-- No grant to authenticated/anon at all.
```

### 5.9 `get_my_active_qr_descriptor` — safe, client-callable, no secrets

```sql
create type qr_credential_descriptor as (
  credential_id uuid, application_id uuid, issued_at timestamptz, status text
);

create function get_my_active_qr_descriptor()
returns qr_credential_descriptor
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_result qr_credential_descriptor;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select c.id, c.application_id, c.issued_at, c.status into v_result
  from qr_credentials c
  join applications a on a.id = c.application_id
  where a.applicant_id = auth.uid() and c.status = 'active';
  return v_result; -- null-composite (all fields null) if no active credential — Node treats this as "not issued"
end;
$$;

revoke all on function get_my_active_qr_descriptor() from public;
grant execute on function get_my_active_qr_descriptor() to authenticated;
```
Zero parameters — structurally impossible for a participant to request anyone else's
credential. Returns **only** locator/status data — no `token_hash`, `token_ciphertext`, or
`encryption_key_version` ever appear in this function's return type. The redisplay flow calls
this first (using the participant's own authenticated session), then — only if it needs the
actual QR payload — separately calls the service-role-only `get_active_qr_ciphertext_for_server`
(§5.10) from trusted server-side code, never forwarding that second call's result to the browser
directly.

### 5.10 `authorize_qr_badge_generation` / `get_active_qr_ciphertext_for_server`

```sql
create function authorize_qr_badge_generation(p_application_id uuid)
returns qr_credential_descriptor
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller profiles;
  v_result qr_credential_descriptor;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin','program_attendance_manager') then
    raise exception 'Not authorized';
  end if;
  select c.id, c.application_id, c.issued_at, c.status into v_result
  from qr_credentials c
  where c.application_id = p_application_id and c.status = 'active';
  return v_result;
end;
$$;

revoke all on function authorize_qr_badge_generation(uuid) from public;
grant execute on function authorize_qr_badge_generation(uuid) to authenticated;

-- Service-role-only. See §2/§4.4 for the full verified property list.
create function get_active_qr_ciphertext_for_server(p_credential_id uuid, p_application_id uuid)
returns table (
  credential_id uuid, application_id uuid, token_version smallint,
  encryption_key_version smallint, token_ciphertext bytea, issued_at timestamptz
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Data-integrity check, not actor authorization (§4.4 point 2) — actor
  -- authorization already happened one layer up, via
  -- get_my_active_qr_descriptor/authorize_qr_badge_generation, before Node
  -- ever calls this function.
  return query
    select c.id, c.application_id, c.token_version, c.encryption_key_version, c.token_ciphertext, c.issued_at
    from qr_credentials c
    where c.id = p_credential_id and c.application_id = p_application_id and c.status = 'active';
end;
$$;

revoke all on function get_active_qr_ciphertext_for_server(uuid, uuid) from public;
grant execute on function get_active_qr_ciphertext_for_server(uuid, uuid) to service_role;
```
If the credential changed between the descriptor call and this call (e.g. revoked in the
interim), the `where c.status = 'active'` clause returns zero rows and Node fails safely,
re-running authorization from the top rather than serving stale material — per the "if the
credential changes between steps, fail safely and retry authorization" requirement from the
encryption-approach round.

### 5.11 `scan_attempt_transactional` — retired old signature, new signature, full migration

**Full disposition per this round's requirement.** Postgres allows function overloading by
argument signature — a `create or replace function scan_attempt_transactional(...)` with a
*different* parameter list does **not** replace the existing 6-parameter function; it creates a
**second, independently callable overload**, leaving the old signature fully reachable in
parallel. This would silently preserve the exact bypass this design closes. The migration must
therefore explicitly retire the old overload, not merely add a new one:

**1. Exact existing signature and all current callers, identified:**
```sql
-- OLD signature (supabase/migrations/20260804160000_scan_attempt_transactional_function.sql):
scan_attempt_transactional(
  p_application_id uuid, p_session_id uuid, p_scanned_by uuid,
  p_device_identifier text, p_time_slot_group_key text, p_is_override_caller boolean default false
) returns scan_attempts
```
Callers found via repository-wide search:
- `src/lib/attendance/scan-attempt.ts:121` — `scanAttemptConfirmForCaller`, called only from
  `scanAttemptConfirm()`'s `requireScannerDeviceCaller()`-gated wrapper.
- `src/lib/attendance/admission-management.ts:30` — `admitOverrideForCaller`, called only from
  `requireProgramAttendanceStaffCaller()`-gated code (already staff-only in practice — this is
  the one that matches the new role check without any behavior change).
- `tests/attendance/scan-attempt-live.test.ts:449` — **direct call via the bare service-role
  `admin` client**, with no authenticated session at all (confirmed:
  `admin = createClient(URL, SERVICE_KEY)`, no `auth.signInWithPassword` on this client). This
  is the one call site requiring more than a mechanical signature update — see step 3.
- `tests/attendance/scan-attempt-concurrency-live.test.ts` — exercises the RPC only through
  `scanAttemptConfirmForCaller`, not directly.
- `tests/attendance/admission-management-live.test.ts` — exercises it only through
  `admitOverrideForCaller`, not directly.

**2. Corrected replacement signature, created:**
```sql
scan_attempt_transactional(
  p_application_id uuid, p_session_id uuid,
  p_time_slot_group_key text, p_is_override_caller boolean default false
) returns scan_attempts
```
```sql
create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false
) returns scan_attempts as $$
declare
  v_caller profiles;
  v_lock_key bigint;
  v_lock_acquired boolean := false;
  v_retry_count int := 0;
  v_max_retries constant int := 20;
  v_decision record;
begin
  -- NEW: role check, replacing the removed p_scanned_by parameter.
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin', 'program_attendance_manager') then
    raise exception 'Not authorized';
  end if;

  -- ... existing advisory-lock retry loop, UNCHANGED ...

  select * into v_decision from perform_admission_decision(
    p_application_id, p_session_id, v_caller.id, p_time_slot_group_key, p_is_override_caller
  );

  insert into scan_attempts (application_id, session_id, scanned_by, result, resulting_attendance_id, finalized_at)
  values (p_application_id, p_session_id, v_caller.id, v_decision.decision, v_decision.attendance_id, now())
  returning * into scan_attempts; -- existing return shape, unchanged
  return;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
```

**3. Every server action, SQL caller, test, generated type, and fixture updated:**
- `src/lib/attendance/scan-attempt.ts:121` — drop `p_scanned_by: userId` and
  `p_device_identifier: params.deviceIdentifier as string` from the `.rpc()` call args. No
  other change — `requireScannerDeviceCaller()`'s existing gate is superseded by (but not made
  redundant with) the new in-database role check; **however**, note this function's wrapper
  currently gates on `isScannerDeviceRole`, while the new SQL-level check requires
  `super_admin`/`program_attendance_manager` — **this is a real interaction that must be
  verified during implementation**: `scanAttemptConfirm()`'s existing TS-level gate
  (`requireScannerDeviceCaller`) would need to change to call the *new* QR-resolution path
  (`confirm_scan_attempt_transactional`, §5.5) instead of `scan_attempt_transactional` going
  forward, since a `scanner_device` caller can no longer reach the legacy RPC at all post-
  migration. This is exactly the routing change specified in §4.5 — flagged here as the concrete
  code-level consequence, not a new decision.
- `src/lib/attendance/admission-management.ts:30` (`admitOverrideForCaller`) — drop
  `p_scanned_by: userId` and `p_device_identifier: params.deviceIdentifier as string`. No
  behavior change: this caller is already `requireProgramAttendanceStaffCaller()`-gated, exactly
  matching the new SQL-level role check.
- `tests/attendance/admission-management-live.test.ts` — update its call sites (via
  `admitOverrideForCaller`) to match the removed TS-layer parameters; no test-assertion changes
  expected since the underlying behavior for a staff caller is unchanged.
- `tests/attendance/scan-attempt-live.test.ts:449` — **requires more than a parameter drop.**
  This test calls the RPC directly via the bare service-role `admin` client, which has no
  `auth.uid()` at all — under the new role check, this call would now fail with `'Not
  authenticated'`, not because the test's intent (proving the override branch) is wrong, but
  because the test's *mechanism* (bare service-role call, no session) no longer satisfies the
  new authorization boundary. **Required rewrite:** this test must first authenticate as a real
  `super_admin`/`program_attendance_manager` profile (mirroring how
  `admission-management-live.test.ts` already sets up its manager-role test client) and call the
  RPC through that authenticated client, not the bare `admin` service-role client. This is a
  genuine test-infrastructure change, not a one-line edit — flagged explicitly rather than
  understated.
- `tests/attendance/scan-attempt-concurrency-live.test.ts` — no direct call to this RPC exists
  (confirmed above); no change needed beyond whatever downstream effect
  `scanAttemptConfirmForCaller`'s own routing change (see `scan-attempt.ts` above) has, which
  is out of this RPC's retirement scope specifically.
- `src/types/database.ts` — regenerate via the project's standard Supabase type-generation step
  after the migration lands; the old 6-arg RPC's generated type disappears, the new 4-arg one
  appears.
- `src/lib/attendance/resolve-admission-decision.ts` — its header comment references
  `scan_attempt_transactional`'s file path and "keep in sync" warning; update the comment to
  also reference `perform_admission_decision` (§5.8) as the actual shared decision core the
  comment's synchronization requirement now applies to, since that's the function whose body
  the TS file must stay logically identical to going forward, not `scan_attempt_transactional`
  directly (which is now a thin wrapper).

**4. Revoke `EXECUTE` from every role on the OLD signature before removal:**
```sql
revoke all on function scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean) from
  public, anon, authenticated, service_role;
```
Explicit and comprehensive — including `service_role`, per the requirement — even though
`service_role` bypasses most authorization concerns, this revoke ensures no lingering grant
exists on the old signature for any role, belt-and-braces ahead of the drop in step 5.

**5. Drop the old overload once dependencies are updated:**
```sql
drop function scan_attempt_transactional(uuid, uuid, uuid, text, text, boolean);
```
This runs only after steps 3's code updates are merged and deployed — sequenced in the Migration
Strategy section (later) as its own migration step, not bundled into the same deploy as the
`create or replace` for the new signature, so there is no window where application code still
targets the old signature after it's been dropped.

**6. Verification that Postgres does not retain both signatures as independently callable
overloads:** after step 5's `drop function` runs,
```sql
select p.proname, pg_get_function_identity_arguments(p.oid)
from pg_proc p where p.proname = 'scan_attempt_transactional';
```
must return **exactly one row** — the new 4-parameter signature. This is a concrete,
verifiable migration-acceptance check, run manually or as part of a migration-verification
script, not merely asserted in prose.

**7. Regression test proving the old signature cannot be invoked:**
```ts
// New test, e.g. in scan-attempt-live.test.ts:
it('rejects a direct call using the retired 6-parameter scan_attempt_transactional signature', async () => {
  const { error } = await admin.rpc('scan_attempt_transactional', {
    p_application_id: applicationId, p_session_id: sessionId, p_scanned_by: scannerId,
    p_device_identifier: null, p_time_slot_group_key: `k-${sessionId}`, p_is_override_caller: true,
  });
  // PostgREST/Postgres reports "function does not exist" for this argument
  // shape once the old overload is dropped — this is the actual proof the
  // retirement took effect, not an assumption.
  expect(error).not.toBeNull();
  expect(error?.message).toMatch(/function.*scan_attempt_transactional.*does not exist/i);
});
```

**8. Test proving `scanner_device` cannot invoke either the old or new manual-admission path:**
```ts
it('scanner_device cannot invoke scan_attempt_transactional under the old OR new signature', async () => {
  const scannerClient = /* authenticated as a scanner_device profile */;
  const oldShape = await scannerClient.rpc('scan_attempt_transactional', {
    p_application_id: applicationId, p_session_id: sessionId, p_scanned_by: scannerId,
    p_device_identifier: null, p_time_slot_group_key: `k-${sessionId}`, p_is_override_caller: false,
  });
  expect(oldShape.error).not.toBeNull(); // function does not exist (retired)

  const newShape = await scannerClient.rpc('scan_attempt_transactional', {
    p_application_id: applicationId, p_session_id: sessionId,
    p_time_slot_group_key: `k-${sessionId}`, p_is_override_caller: false,
  });
  expect(newShape.error).not.toBeNull(); // 'Not authorized' from the new role check
});
```
This single test satisfies both this requirement and overlaps with §4.7 step 4's "manual QR
text entry uses token resolution, not application_id admission" requirement — a `scanner_device`
caller has no path to this function at all, old or new shape, confirming the manual-fallback
token-entry UI has no alternative but to route through `resolve_qr_token_for_scan`.

Both `scan_attempt_transactional` (new signature) and `confirm_scan_attempt_transactional`
continue to share `perform_admission_decision` (§5.8) as their one decision core.

---

## 6. Idempotency and race-safety, verified per-operation

| Operation | Idempotency / race behavior |
|---|---|
| **Issuance retry** (network timeout, commit succeeded but response lost) | Second call locks the same `applications` row, finds the now-existing active credential, returns `outcome='already_active'` instead of erroring. Node treats this as success and calls `get_my_active_qr_descriptor` (§5.9) then the service-role `get_active_qr_ciphertext_for_server` (§5.10) to obtain the payload. |
| **Reissue reservation retry** (corrected this round — this row previously described a stale, non-idempotent design that predates `request_key`) | Fully idempotent via the same `request_key` mechanism as issuance (§5.2): an identical retry (same requester, same `request_key`, same immutable intent) replays the ORIGINAL durable operation's outcome exactly — `already_pending` for a still-pending reservation, or the STORED terminal outcome (including `reissue_cooldown_active`/`reissue_rate_limit_exceeded` with `retry_after_seconds` derived from the stored `terminal_retry_after_at`, never recalculated) for any already-cancelled/expired/consumed operation. A retry with the same key but different intent returns `request_key_intent_conflict` instead of silently reusing or overwriting the original. |
| **Confirmation retry** | `select ... for update` + `finalized_at is not null` check makes a second confirm attempt on the same `scan_attempt_id` fail closed with "already finalized" — never double-writes `attendance_records`. |
| **Cancellation retry** | Explicitly idempotent (§5.6) — a second cancel call on an already-finalized row is a silent no-op, not an error. |
| **Scheduled expiry vs. concurrent confirm** | Both paths take a row lock (`for update` in confirm; a plain `update ... where finalized_at is null` in the scheduled job, which is itself a row-level lock for the duration of that update) on the same `scan_attempts` row. Whichever transaction commits first wins; the loser's own precondition (`finalized_at is null` for the job, or the freshly-read `finalized_at`/`expires_at` for confirm) fails, and it takes the corresponding "already finalized" or "expired" branch. Neither path can ever produce two finalizations of the same row. |
| **Concurrent reissue attempts for the same application** | Both transactions attempt `select ... from qr_credentials where application_id = ... and status = 'active' for update` — Postgres serializes them on that row lock. The first commits (old row → `replaced`, new row → `active`); the second, once unblocked, re-reads and finds the *original* row now `status='replaced'` — its own `for update` clause (`where status = 'active'`) now matches zero rows, so it raises `'No active credential to reissue'` rather than proceeding — never producing two `active` rows for one application. |
| **Concurrent first-issuance attempts** | Both transactions lock `applications ... for update` — Postgres serializes them on that row lock (this is precisely why §10 requires locking the parent even when no credential row exists yet: there is nothing else to lock on the first attempt). The first inserts the active row and commits; the second, once unblocked, re-reads and finds the now-existing active credential, returning `already_active` rather than violating the partial unique index. |

---

## 7. Audit log actions and safe metadata (verified against the real `audit_actor_type` enum)

Confirmed via the codebase's actual schema: `audit_actor_type` is `enum('admin', 'system')` —
exactly two values, both already valid, no migration needed to use either. No third value
(e.g. `'participant'`) is introduced, matching the existing precedent in
`claim_imported_application_transactional`.

| Event | `action` | `actor_type` | `actor_id` | `metadata` (safe fields only) |
|---|---|---|---|---|
| Participant self-issues | `'issued'` | `'system'` | `auth.uid()` (the participant) | `application_id`, `issuance_channel` |
| Staff issues (individual/bulk) | `'issued'` | `'admin'` | resolved staff `profiles.id` | `application_id`, `issuance_channel`, `issuance_reason_code` |
| Participant self-reissues | `'reissued'` | `'system'` | `auth.uid()` | `application_id`, `reissue_channel`, `previous_credential_id`, `reissue_reason_code` |
| Staff force-reissues | `'reissued'` | `'admin'` | resolved staff `profiles.id` | same, plus `reissue_reason_code` from staff's free text |
| Staff revokes | `'revoked'` | `'admin'` | resolved staff `profiles.id` | `application_id`, `revocation_reason_code` |
| Rate-limit/cooldown denial (corrected this round — no separate `audit_logs` row) | *(none — see note below)* | n/a | n/a | n/a |

**Note on rate-limit/cooldown denials (corrected this round):** the approved
`request_my_qr_reissue_transactional` does not write a separate `audit_logs` row for a
`reissue_cooldown_active`/`reissue_rate_limit_exceeded` denial — the durable, cancelled
`qr_lifecycle_operations` row itself (with `terminal_reason_code` and `terminal_retry_after_at`
set) IS the complete, queryable audit record of the denial, consistent with this whole design's
governing principle that `qr_lifecycle_operations` is the single source of truth for reservation
history. A separate `audit_logs` entry would be a redundant second copy of the same fact with no
additional information; if operational tooling later needs `audit_logs`-specific aggregation for
these events, that is a genuinely new requirement to design explicitly, not something this table
assumes exists today.

`actor_id` is, in every row, a value the function derived itself (either from `auth.uid()`
directly, or from a `profiles` row looked up by `auth.uid()` and role-checked) — never a
caller-supplied parameter, closing the coalesce-as-authorization concern from the previous
round for good: there is no longer any `coalesce(p_xxx, auth.uid())` pattern anywhere in this
document.

---

## 8. Machine-readable outcomes and controlled user-facing messages

| Internal `outcome`/`result` code | Participant-facing message | Operator (scanner)-facing message |
|---|---|---|
| `issued` / `already_active` | *(QR displayed, no error message)* | n/a |
| `reissued` | *(new QR displayed)* | n/a |
| `reissue_cooldown_active` | "You recently generated a new QR code. Please try again in **{retry_after_seconds/60}** minutes." | n/a |
| `reissue_rate_limit_exceeded` | "You've reached today's self-service limit. Please contact event support." | n/a |
| `revoked` (admin action) | *(participant's dashboard shows "Revoked" state on next load — no push notification in this phase)* | n/a |
| `token_malformed` | n/a | "Invalid QR code" |
| `token_unknown` | n/a | "Invalid QR code" |
| `token_revoked` | n/a | "This QR is no longer active" |
| `token_replaced` | n/a | "This QR is no longer active" |
| `token_ineligible` | n/a | "Participant is not eligible for entry." |
| `token_valid_pending_confirmation` | n/a | *(participant summary + admission decision shown, per existing preview UI — unchanged)* |
| `expired_pending` | n/a | "This scan has expired. Please scan the QR code again." |
| `cancelled_by_operator` | n/a | *(scanner UI simply returns to the ready-to-scan state)* |
| `admitted` / `flexible_admitted` / `priority_hold` / `full` / `restricted_denied` / `duplicate` / `timeslot_conflict` / `override_admitted` | n/a | **Unchanged** — existing messages from today's admission-decision UI, untouched by this design |

Every internal code beyond what's listed in the right two columns (e.g. distinguishing
`token_revoked` from `token_replaced` from `token_ineligible` internally) exists purely for
audit/reporting — the operator-facing UI deliberately collapses the first five failure codes
into three controlled phrases, exactly as specified.

---

## 9. Consistency review (self-check against this round's explicit requirements)

- **No caller-supplied UUID is treated as the authenticated actor.** ✅ Verified: every
  function signature in §5 was audited — none accepts `p_issued_by`, `p_staff_actor_id`,
  `p_actor_kind`, or `p_scanned_by`. All actor identity flows from `auth.uid()` (Pattern A/B/C,
  §3), independently re-derived in every single function, including `confirm_scan_attempt_transactional`
  which re-validates scanner assignment rather than trusting that `resolve_qr_token_for_scan`
  already did so for the same request.
- **No RPC returns hashes, ciphertext, key versions, or raw tokens** — with one deliberate,
  narrow, documented exception: `get_active_qr_ciphertext_for_server` (§5.10) returns
  `token_ciphertext`/`encryption_key_version` **to `service_role` only, never to `authenticated`**
  (§2, §4.4) — the client-callable descriptor RPCs (`get_my_active_qr_descriptor`,
  `authorize_qr_badge_generation`) return only the `qr_credential_descriptor` composite
  (`credential_id, application_id, issued_at, status` — no secrets at all). Every other RPC
  returns only `qr_credential_lifecycle_result`, plain scalars/text, or (for
  `get_scan_attempt_status_for_caller`, §4.1) a narrow safe-fields table — never `qr_credentials`
  itself, never any bytea secret field to any `authenticated` caller.
- **Replacement FK ordering works with the partial active-credential unique index.** ✅
  **Corrected in this round** (the previous claim that a single CTE statement guarantees safe
  insert-before-update ordering was withdrawn as incorrect — see §1.2's note). The actual proof:
  `replaced_by_credential_id` is `deferrable initially deferred` (§1.2); §5.2 issues the `update`
  (old row → `replaced`, freeing the partial-unique-index slot) **before** the `insert` (new row
  → `active`), as two ordinary statements, not a CTE — the update's reference to
  `p_new_credential_id` (a row that doesn't exist yet at that point) is permitted only because
  the FK's referential check is deferred to `commit`, by which point the insert has run and the
  row exists.
- **Staff reissues are identified through a durable `reissue_channel`, not a nullable actor
  reference.** ✅ §1.1/§5.2: rate-limit counting filters on `reissue_channel =
  'participant_self_service'` exclusively — never on `replaced_by is null`, which would
  misclassify a staff reissue as participant-initiated after that staff profile is deleted.
- **Every submitted scan produces exactly one `scan_attempts` row.** ✅ §5.4 inserts exactly
  one row per call, for every branch (`token_unknown`/`token_revoked`/`token_replaced`/
  `token_ineligible`/`token_valid_pending_confirmation`). §5.5 (`confirm`) and §5.6 (`cancel`)
  both `update` that same row in place — never insert a second one. §5.7
  (`record_malformed_scan_attempt`) is the one case that doesn't go through `resolve_qr_token_for_scan`
  at all (a malformed payload can't be hashed meaningfully), and it independently inserts its
  own single row. No code path in this document ever produces two rows for one physical scan.
- **Pending expiry and confirmation cannot both finalize the same attempt.** ✅ §6's race
  table: both take a row lock on the same `scan_attempts` row before writing; Postgres
  serializes them; the loser's own precondition check (`finalized_at is null` for the
  scheduled job's `where` clause; the freshly-locked row's `finalized_at`/`expires_at` for
  `confirm_scan_attempt_transactional`) fails on whichever transaction loses the race,
  guaranteeing exactly one finalization.
- **Capacity, duplicate attendance, conflicts, policy, and eligibility are re-evaluated at
  final confirmation.** ✅ `perform_admission_decision` (§5.8) is the exact existing decision
  core from `scan_attempt_transactional`, called fresh inside `confirm_scan_attempt_transactional`
  at confirm time — nothing from the `resolve`/preview step is cached or reused for the actual
  admission decision. Eligibility (`is_application_eligible_for_admission`) is checked once at
  `resolve` time to decide `token_ineligible` vs. `token_valid_pending_confirmation`, and
  implicitly re-checked at confirm time too, since `perform_admission_decision` independently
  loads `applications.status` itself (existing behavior, unchanged) as part of its own decision
  logic — an application that flips out of `accepted` between resolve and confirm is caught
  there, not assumed still valid from the earlier check.

`is_application_eligible_for_admission`, per your explicit requirement:
```sql
create function is_application_eligible_for_admission(p_application_id uuid) returns boolean
language sql security definer set search_path = public, pg_temp stable as $$
  select coalesce(
    (select status = 'accepted' from applications where id = p_application_id),
    false  -- application does not exist -> false, never null
  );
$$;

revoke all on function is_application_eligible_for_admission(uuid) from public;
-- No grant to authenticated or anon at all. Callable only from within
-- resolve_qr_token_for_scan's own security-definer body (and any future
-- eligibility call site, per the centralization requirement) — never
-- independently invocable by any client role.
```
Phase 6 scope is documented inline: only `applications.status = 'accepted'` is checked. Future
phases (participant suspension, withdrawal) extend this **one** function; every eligibility
call site continues calling it rather than re-implementing the condition inline.

**New self-check items for this round:**
- **`scan_attempt_transactional`'s old 6-parameter overload cannot remain independently
  callable.** ✅ §5.11 specifies explicit `revoke` (from `public, anon, authenticated,
  service_role`) then `drop function` on the exact old signature, sequenced as its own migration
  step after all callers are updated, with a `pg_proc` verification query and two regression
  tests (old-signature rejection, `scanner_device` rejection under both signatures) as hard
  requirements — not merely a `create or replace` that would have left both overloads live.
- **Pattern C's role-check gap (staff-with-incidental-assignment) is closed everywhere it
  applies.** ✅ Every scanner-facing function in the final §5 (`resolve_qr_token_for_scan`,
  `confirm_scan_attempt_transactional`, `cancel_scan_attempt_transactional`,
  `record_malformed_scan_attempt`, plus §4.1's `get_scan_attempt_status_for_caller`) now
  explicitly checks `v_caller.role <> 'scanner_device'` before ever consulting
  `scanner_assignments` — a staff profile with an incidental assignment row is rejected at the
  role check, never reaching the assignment lookup.
- **`scan_attempts` table access matches §4's final model exactly.** ✅ No function in §5 selects
  or writes `scan_attempts` outside the RPCs themselves; `scan_attempts_manager_select` (read-
  only), the dropped scanner policies, and the revoked direct-mutation grants from §4.1 are the
  only access paths left, consistent with §4.8's final privilege table.
- **Reason-code conditional validation (§1.4) is enforced in every RPC that accepts a reason
  code/note pair.** ✅ §5.1 (issuance), §5.2 (reissue), §5.3 (revocation) each validate the
  correct vocabulary for their channel and enforce the `*_other`-requires-a-note rule explicitly,
  closing the gap where the previous round's bodies validated note *length* but not vocabulary
  membership or the conditional note requirement.
- **Every finalizing `update` sets `expires_at = null` alongside `result`/`finalized_at`.** ✅
  §5.5 (both its self-expiry branch and its main confirmation update) and §5.6 (cancellation)
  both include `expires_at = null` explicitly, per §1.3's constraint requirement — the previous
  round's bodies were missing this on two of three finalizing statements before this correction.

---

## 10. Open items carried forward (not blocking, but noted for the full spec)

- The exact Node-side `canonicalEncode` helper module (uint16BE + UUID-as-UTF8 encoding,
  shared by the hash-input builder and the AAD builder) will be written out in full in the
  **Token Format and Lifecycle** section of the final spec, alongside its unit-test plan.
- `perform_admission_decision`'s full body is a verbatim extraction of
  `scan_attempt_transactional`'s existing logic — the actual migration diff will be shown in
  the **Migration Strategy** section, since it touches an existing, currently-working function
  and needs its own careful before/after verification (both SQL and the `resolveAdmissionDecision`
  TS mirror must keep agreeing after the refactor).
- The scheduled `expire_stale_pending_scan_attempts` job's exact invocation mechanism
  (Supabase `pg_cron` vs. a Vercel/Edge Function on a timer) is a deployment-environment
  decision I'll confirm in the **Phased Implementation Plan** section rather than assume here.
