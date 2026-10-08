-- supabase/migrations/20261008090000_dedupe_session_reminder_notifications.sql
--
-- Final whole-branch review of sub-project 6 found a real duplicate-row
-- bug: session-reminders/route.ts matches sessions starting 25-35 minutes
-- from now (a 10-minute window, to tolerate cron drift) but the cron
-- itself runs every 5 minutes with no existence check before calling
-- create_notification. Consecutive invocations 5 minutes apart both match
-- the same upcoming session for 2-3 ticks in a row, each inserting a
-- fresh session_reminder row for the same application_id/session_id pair
-- -- the participant sees the same reminder 2-3 times in their bell
-- (and, via the email cron, 2-3 times in their inbox).
--
-- A unique partial index on (application_id, session_id, channel) for
-- session_reminder rows makes a second insert for the same
-- participant/session/channel impossible at the database level, rather
-- than relying on the route to remember to check first (every future
-- caller of create_notification for this channel is protected for free).
-- Scoped to session_reminder only -- no other channel has this
-- "re-evaluated on a schedule against a window wider than the cron
-- interval" shape, so no other channel needs this constraint.
create unique index notifications_session_reminder_dedupe_idx
  on notifications (application_id, session_id, channel)
  where channel = 'session_reminder';
