-- supabase/migrations/20261008071000_add_notification_claimed_at.sql
--
-- Companion to 20261008070000 (adds the 'processing' email_status value).
-- `claimed_at` is stamped by process-notifications/route.ts's claim UPDATE
-- (pending -> processing) and lets the route's fetch query self-heal a row
-- abandoned mid-processing by a crashed/timed-out prior invocation: a
-- 'processing' row older than STALE_PROCESSING_MS is picked up again
-- exactly as if it were 'pending'. Replaces notifications_pending_idx
-- (20261008010000, 'pending'-only) with an index covering both statuses
-- the route now queries for.
alter table notifications add column claimed_at timestamptz;

drop index notifications_pending_idx;
create index notifications_pending_idx on notifications (created_at)
  where email_status in ('pending', 'processing');
