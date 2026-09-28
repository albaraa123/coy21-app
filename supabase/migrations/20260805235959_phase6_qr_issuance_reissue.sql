-- Phase 6 — Secure Participant QR Issuance: schema + issuance/reissue RPCs
-- Mechanically extracted from docs/superpowers/specs/_phase6-qr-rpc-reference-draft.md
-- Only sections explicitly marked APPROVED (or confirmed approved via surrounding prose
-- / function-name cross-check) are included. SUPERSEDED sections are excluded entirely.
-- Scope: §1 (schema), §2.1 (qr_credentials privilege revocation), §5.0a (fingerprint
-- helper), §5.1 (issuance), §5.2 (reissue). §5.3 onward (revocation, scanning,
-- admission-decision, badge generation) is explicitly out of scope for this migration.

-- Hard prerequisite for the fingerprint helper's digest() call (§1 preamble).
create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- §1.2  qr_credentials — full final constraint set
-- ============================================================================
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

-- ============================================================================
-- §1.3  scan_attempts — additive columns, backfill, and result values
-- ============================================================================
alter table scan_attempts add column finalized_at timestamptz;
alter table scan_attempts add column expires_at timestamptz;

update scan_attempts set finalized_at = created_at where finalized_at is null;

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

-- ============================================================================
-- §1.4  Reason-code vocabularies
-- ============================================================================
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

-- ============================================================================
-- §1.5  Defensive lifecycle/immutability trigger — qr_credentials
-- ============================================================================
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

-- ============================================================================
-- §1.6  Encryption-key-version registry
-- ============================================================================
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

alter table public.qr_credentials
  add constraint qr_credentials_encryption_key_version_fkey
  foreign key (encryption_key_version) references public.qr_encryption_key_registry(key_version)
  on delete restrict;

-- ============================================================================
-- §1.6a  qr_bulk_operation_batches
-- ============================================================================
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

-- ============================================================================
-- §1.7  qr_lifecycle_operations — the reservation/finalization bridge table
-- ============================================================================
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

-- ============================================================================
-- §2.1  Explicit direct table-privilege revocation on qr_credentials
-- ============================================================================
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_credentials from anon, authenticated;

-- ============================================================================
-- §5.0a  compute_qr_finalization_fingerprint — shared fingerprint helper
-- ============================================================================
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

-- ============================================================================
-- §5.1  Issuance — approved reservation (participant self-service, staff
-- individual/bulk) + approved reissue reservation (staff force-reissue,
-- individual/bulk — physically located within this section of the source doc
-- but is the reissue reservation by actual function name) + approved
-- finalize_qr_issuance_for_server
-- ============================================================================
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

-- ============================================================================
-- §5.2  Reissue — approved participant self-reissue reservation +
-- approved finalize_qr_reissue_for_server
-- (staff reissue reservation already extracted above in the §5.1 block)
-- ============================================================================
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
