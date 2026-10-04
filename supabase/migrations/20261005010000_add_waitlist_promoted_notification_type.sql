-- 20261005010000_add_waitlist_promoted_notification_type.sql
--
-- Must be its own migration, committed before any later migration
-- references the new value (Postgres requires ALTER TYPE ... ADD VALUE
-- to commit before use -- same constraint 20261004000000 worked around
-- for 'session_cancelled'). See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md.

alter type session_notification_type add value 'waitlist_promoted';
