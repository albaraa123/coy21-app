-- 20261006030000_add_no_show_booking_status.sql
--
-- Must be its own migration, committed before any later migration
-- references the new value (Postgres requires ALTER TYPE ... ADD VALUE
-- to commit before use -- same constraint every prior enum extension in
-- this codebase has worked around). See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 8.

alter type booking_status add value 'no_show';
