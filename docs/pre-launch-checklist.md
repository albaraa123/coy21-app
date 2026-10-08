# COY21 Pre-Launch Checklist

Conference: Antalya, Türkiye, 5–7 Nov 2026 (~500 participants).

This tracks mandatory items that must be verified/completed before the platform is used for real production traffic. Items are added as they're identified; nothing here is removed once verified unless explicitly superseded.

## Notifications (sub-project 6)

- [ ] **Do not disable sandbox mode until the new unified notifications system has been verified via a real sandbox email, then delete the old `process-session-notifications` cron to avoid duplicate emails.**

  Context: `feature/notifications-layer` merged to `master` on 2026-10-08. It deliberately kept the old `process-session-notifications` cron (reading from `session_notification_outbox`) running alongside the new `process-notifications` cron (reading from the `notifications` table) for 3 overlapping event types — `session_cancelled`, `session_rescheduled`, `waitlist_promoted`. Both paths are live simultaneously right now, meaning these 3 event types currently send **2 duplicate emails** per real event. This was an explicit, accepted interim state (not an oversight) to avoid a risky hard cutover without first confirming the new cron actually sends mail correctly in the deployed/production environment — something that can't be verified from a local worktree.

  Required sequence, in order:
  1. Deploy this branch's changes to production.
  2. With sandbox mode still ON, trigger (or wait for) at least one real notification of each type and confirm the sandbox email actually arrives and looks correct — at minimum: `application_accepted`/`application_rejected`, `booking_confirmed`, one of `session_cancelled`/`session_rescheduled`/`waitlist_promoted`, `session_reminder`, `travel_reminder`, `announcement`.
  3. Confirm via a direct query that `notifications.email_status = 'sent'` rows are appearing for these events: `select channel, email_status, sent_at from notifications where email_status = 'sent' order by sent_at desc limit 10;`
  4. Only after that's confirmed: delete `src/app/api/cron/process-session-notifications/route.ts` and remove its entry from `vercel.json`, then redeploy.
  5. Only after the old cron is confirmed gone from the deployed cron schedule: sandbox mode may be turned off (set a real `sandbox_recipient_email` first if you want a staging-style redirect address, or disable `sandbox_enabled` entirely once ready for real participant traffic).

  Do not skip step 4 — turning off sandbox mode while both crons are still active would send every participant 2 real emails per cancellation/reschedule/waitlist-promotion event.

## Deployment

- [ ] _(to be filled in)_

## Resend configuration

- [ ] _(to be filled in)_

## Test data cleanup (COY21 production project)

- [ ] _(to be filled in)_
