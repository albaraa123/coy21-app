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

- [x] Deployed to Vercel (`coy21-app.vercel.app`), connected to GitHub (`albaraa123/coy21-app`), confirmed live and connected to the real COY21 Supabase project (`vfwcbkjvinbtcntwjrzq`) via an actual login test as `albaraak2002@gmail.com` (participant role).
- [x] `vercel.json` trimmed to 1 cron (`travel-reminders`, daily) to fit the Vercel Hobby plan's 2-cron/once-daily limit. The other 4 cron routes (`process-notifications`, `session-reminders`, `process-session-notifications`, `process-session-no-shows`) keep their existing Route Handlers deployed but are no longer auto-triggered by Vercel.
- [ ] **Set up the 4 external cron jobs** (e.g. via cron-job.org, free tier) to call the routes above at their original cadence, each with an `Authorization: Bearer <CRON_SECRET>` header matching the `CRON_SECRET` value set in Vercel:
  - `/api/cron/process-notifications` — every 1 minute
  - `/api/cron/session-reminders` — every 5 minutes
  - `/api/cron/process-session-notifications` — every 5 minutes (until removed per the Notifications section above)
  - `/api/cron/process-session-no-shows` — every 5 minutes
- [ ] Add a custom domain (if/when one is available) under Vercel → Domains, and update `NEXT_PUBLIC_SITE_URL` to match.
- [ ] **Self-registration form (`/register`) is functionally complete but has zero visual styling** (plain unstyled HTML inputs, no layout, fields visually indistinguishable) — confirmed unusable in its current state during a live test. Deliberately deprioritized: participant import is the primary onboarding path for the real conference, this form is a secondary/fallback path. Needs a real design pass before being pointed at by anyone outside the team, but is not a blocker for the primary launch flow.

## Resend configuration

- [ ] `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are still unset in Vercel's environment variables — no real email can send yet (sandbox mode being on doesn't change this; an unset Resend config fails outright with "Resend not configured").
- [ ] **No verified domain available yet** — plan is to use Resend's free `onboarding@resend.dev` sender for now. Confirmed via Resend's own docs: that address can only send to the Resend account owner's own email address (any other recipient gets a 403, "You can only send testing emails to your own email address"). This is sufficient for the full sandbox-mode verification pass below (sandbox redirects everything to one address anyway, so set it to the account owner's email) but is a hard blocker for real launch — no email can reach any of the ~500 real participants until a real domain is verified with Resend.
- [ ] **Before real launch: verify a real domain with Resend** (resend.com/domains) and point `RESEND_FROM_EMAIL` at an address on it. A cheap purchased domain or an existing subdomain both work — does not need to be `climatecoy.com` specifically, just something DNS-verifiable before go-live.

## Live admin walkthrough findings (2026-10-09)

Found by clicking through the entire admin sidebar as `super_admin` and `participant` on the real deployed site after test-data cleanup.

- [x] Fixed: sidebar group collapse was fought by a re-expand effect (committed `473c776`) — clicking a group header to collapse it while on a route inside that group silently re-expanded it on the next render.
- [x] Fixed: `/register` 404'd because `ENABLE_SELF_REGISTRATION` wasn't set in Vercel — now set to `true`.
- [x] Fixed: `revalidatePath` in 5 admin Server Action files (`settings/actions.ts` and 4 `local-info`-family action files) targeted `/en/admin/<page>`, a path that 404s since `(admin)` is a route group stripped from the real URL — confirmed live via curl (committed `f2b9422`). Impact was masked for the person making the change (their own `router.refresh()` call shows it immediately) but meant other staff/tabs wouldn't see a settings change until Next.js's cache happened to expire on its own.
- [x] A required `tracks` row now exists (`GENERAL` / `عام`) — `sessions.track_id` is `NOT NULL` and the session-creation form requires selecting one, so at least one track must exist before any real session can be created. Tracks as a *feature* (multiple tracks, track-based filtering) is not needed for this conference — always select "General" when creating sessions; no further action needed here unless multi-track filtering becomes useful later.
- [ ] **Minor, not launch-blocking:** the "New track" form (and likely other similar admin create-forms using plain HTML forms rather than the styled components) fails silently when submitted with empty required fields — no validation error shown, the request is just dropped. Confirmed by reproducing it live: an empty submit produced no track row and no visible error; a filled-in submit worked correctly. Low priority since staff will naturally fill in required fields, but worth a validation-message pass if time allows before the conference.
- [x] All other admin sections walked and confirmed working with correct styling: Participants (Applications, Accounts, Import CSV, Care & Needs, Travel & Logistics, Arrivals, Status & Funding), Agenda (Sessions, Days, Rooms, People), Allocation (Runs, Schedules), Attendance (Scanners, Admissions, Walk-In Admission, Demand & Capacity, Ops Dashboard), Reporting (Reports, Communications).

## Test data cleanup (COY21 production project)

- [x] Done 2026-10-08. Full backup taken first (`C:\Users\albar\.claude\backups\coy21\coy21-backup-20261008-pre-test-data-cleanup\`, outside the repo). All test fixture data purged (`applications`, `sessions`, `rooms`, `session_types`, `conference_days`, `tracks`, `qr_credentials`, `attendance_records`, etc. — all confirmed at 0 rows after cleanup) and all non-kept `auth.users` rows deleted (462 → 4). Settings tables (`conference_settings`, `email_settings`, `qr_encryption_key_registry`) and real content (`local_info_*`) were left untouched. The 4 kept accounts (`albaraak2002@gmail.com` participant, `albaraa.coy21@gmail.com` super_admin, `albaraaalbadwi@gmail.com` staff, `albaraa.scale.om@gmail.com` scanner_device) were confirmed working via a real login test post-deploy.
