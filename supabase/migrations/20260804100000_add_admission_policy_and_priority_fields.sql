-- add_admission_policy_and_priority_fields.sql
--
-- Phase 6 (docs/superpowers/specs/2026-07-31-flexible-admission-qr-attendance-design.md).
-- New sessions columns for the admission-policy/capacity layer. Purely
-- additive; sessions.is_mandatory/enable_qr_checkin/checkin_opens_at/
-- checkin_closes_at are explicitly untouched (see spec Non-Goals) — this
-- migration supersedes their purpose without modifying them.
alter table sessions
  add column admission_policy text not null default 'priority_then_open',
  add column priority_seats int,
  add column priority_release_at timestamptz,
  add column priority_release_minutes_before int,
  add column late_entry_cutoff_minutes int,
  add column flexible_entry_manual_override boolean;

alter table sessions add constraint sessions_admission_policy_check
  check (admission_policy in ('open', 'priority_then_open', 'restricted', 'plenary', 'cross_cutting'));

alter table sessions add constraint sessions_priority_seats_check
  check (priority_seats is null or (priority_seats >= 0 and priority_seats <= capacity));
