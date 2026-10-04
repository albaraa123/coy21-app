-- 20261005000000_add_session_types_enable_waitlist.sql
--
-- Lets staff opt any session type into waitlist behavior (sub-project 4d).
-- Defaults to false, so every existing session type keeps today's
-- behavior (participants see "Full" with no action) until staff
-- explicitly enable it. See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md
-- for full rationale.

alter table session_types add column enable_waitlist boolean not null default false;
