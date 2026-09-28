# Participant Import — Operator Guide

This covers the Excel-based participant import feature (Phase 5.1): how to bring accepted participants from an external Google Form / screening process into the platform, review and correct the mapping, confirm the import, run downstream processing, and invite participants to claim their accounts.

## The workflow, end to end

Public registration and applicant screening no longer happen inside this platform. The process is:

1. Applications are collected externally via Google Forms.
2. Screening and selection happen externally (outside this platform).
3. The organizing team exports one Excel file of **accepted** participants.
4. That file is uploaded here, mapped, reviewed, and confirmed.
5. Once imported, participants go through the existing feature-extraction → clustering → allocation → schedule-publication pipeline, exactly as before — nothing about that pipeline changed for this phase.
6. Once an admin is ready, invitations are sent so participants can claim their accounts and see their schedule.

Every step from upload through confirm is staff-only. **No participant can create or influence data through this flow at all** — they only ever appear after an admin explicitly confirms an import, and they only ever gain access to their own record after they explicitly claim it via an emailed invitation link.

## What makes a "good" Excel file — and what the importer tolerates

- `.xlsx` format. Password-protected, macro-enabled, or corrupted workbooks are rejected safely with a clear error at upload time — nothing is ever staged from a file that fails to parse.
- Multiple sheets are fine; the importer detects all non-empty sheets and suggests the one with the most data rows. You can pick a different sheet if the suggestion is wrong.
- Column order doesn't matter, and column headers don't need to match any fixed template — the importer works from whatever headers your file actually has, in English or Arabic, and asks you to confirm or correct its guesses (see "Mapping" below).
- One header row, one data row per participant. Phone numbers should be entered as text (a leading `+` or a leading `0` surviving) rather than a number Excel might reformat — the importer preserves whatever text is in the cell either way, but a text-formatted phone column avoids Excel silently stripping a leading zero before the file ever reaches this platform.
- Multi-select answers (e.g. multiple interests) can be separated by commas, semicolons, or newlines within a single cell — all three are recognized.
- Yes/No-style answers are recognized in both English and Arabic.
- Up to ~5,000 rows is a tested, supported scale (see "Performance" below). Larger files aren't blocked, but haven't been measured.

## Upload and mapping

1. **Upload**: drag-and-drop the `.xlsx` file. If the exact same file (by content, not filename) was already uploaded before, you're told immediately — which batch, when, what status — so you can decide whether to proceed (e.g. intentionally re-running because the source file was regenerated with identical content) or stop.
2. **Sheet selection**: confirm or change the auto-suggested sheet.
3. **Mapping**: each column gets an automatic suggestion — full name, email, phone, WhatsApp, country, nationality, city, gender, date of birth/age, preferred language, organization, experience level, interests, topics, accessibility needs, dietary needs, emergency contact, or a generic free-text answer — matched against English and Arabic header aliases.
   - **Confidence indicator**: each suggestion shows how confident the match is. Anything below a fairly high confidence threshold is flagged and requires you to explicitly confirm or correct it — the importer never silently auto-maps a low-confidence guess, and it **never** auto-maps the email column or whichever column you designate as the unique identifier, regardless of confidence. Those two always require an explicit human decision.
   - **Correcting a mapping**: click any column's target and pick the right field, or mark it "ignored" if it's not needed. You must also designate which column is the unique identifier (normally the email column, pre-selected if one was recognized).
   - **Reusable templates**: if this file's headers match a template you saved from a previous import, it's suggested — but never applied automatically, even on an exact match. You always click to accept it.
4. Once you confirm the mapping, the file moves to validation.

## Validation, preview, and duplicate handling

Every row is validated and classified before anything is written to the participant database — **uploading and mapping never touch live participant data**. Only an explicit "Confirm import" click does that.

The preview screen shows counts (valid / warning / error / duplicate) and a searchable per-row table. Rows with errors can be downloaded as a CSV report so you can fix the source file and re-upload if needed.

Duplicate/re-import handling works in three tiers, checked in this order:

- **Duplicate within the same file** — the same email appears twice in one upload. Both rows are flagged; neither is silently dropped or silently applied. You resolve this in the source file.
- **Matches an existing, not-yet-claimed imported participant** — this row will **update** that participant's record when you confirm. A snapshot of the prior data is kept so this can be undone later (see Rollback).
- **Matches an existing, already-claimed participant** (someone who has already logged in and claimed their account) — this is treated as a review-required update. It's shown in its own category on the preview screen with a clear warning banner, and the import will skip these rows entirely unless you click the "Approve claimed-participant updates" button on the preview screen first — this is a deliberate, separate confirmation from clicking "Proceed to confirm," since overwriting an active participant's data is a bigger deal than updating an unclaimed staging row.
- **Blocked** — if a match (claimed or unclaimed) already has downstream data (feature extraction, clustering, allocation, a published schedule, or a pending unconfirmed schedule-publication draft) attached, that row is blocked from being applied automatically at all, regardless of claim status. You'll need to resolve it manually (see "Troubleshooting").

**Re-importing identical content**: if you re-import a file (or a corrected file) containing a row whose content is byte-for-byte identical (after normalization) to what was already applied to that participant, the row is classified as "unchanged" and skipped — no duplicate answer history, no spurious status-change entry is created. This works even across different upload batches, as long as the participant's record hasn't been rolled back since. Note the identical-content check only covers the *normalized* value of each answer, not incidental formatting differences in the original cell text — a value that means the same thing but is typed slightly differently in the raw Excel cell will still be treated as changed.

## Confirming the import

Clicking "Confirm" starts a chunked, resumable process — the platform processes rows in batches rather than all at once, and progress is saved as it goes.

- **If your browser closes or the connection drops mid-import**: no progress is lost. Any admin (not necessarily the one who started it) can resume the same batch, and it continues from where it left off — no row is ever double-applied and no row is skipped.
- **If two admins try to confirm the same batch at the same time**: the second one gets a clear "this batch is already being processed" error rather than silently causing a conflict.
- **If one row has a problem the importer can't handle** (e.g. a genuinely malformed value that slips past validation): that single row is marked as a processing error and the import continues past it — one bad row never wedges the entire batch.
- **Performance**: at the tested scale, a 500-row import completes in roughly 20-25 seconds, and a 5,000-row import in roughly 3 minutes. If an import that size seems to be taking dramatically longer than that, check the batch's status page for an error before assuming something is wrong — the resumable design means it's always safe to just resume it.

## Automatic downstream processing (optional)

When confirming an import, you can optionally enable automatic downstream processing. If enabled, the platform automatically runs feature extraction, then clustering (you still choose the cluster count — there's no parameter-free "just figure it out" mode), then allocation, immediately after the import completes.

**What automatic processing never does**, no matter what: it never publishes a schedule, never activates a schedule revision, and never sends any invitation. Those always remain separate, explicit actions on their own pages, exactly as they were before this phase — automatic processing only ever gets participants as far as "allocated," never further.

If you don't enable this, the batch simply finishes after import, and you run analysis/allocation manually from the existing clustering page exactly as before.

If a downstream stage fails partway through (e.g. clustering succeeds but allocation errors), whatever completed successfully is kept and inspectable — nothing is thrown away — and you can manually re-trigger the failed stage from its normal page.

## Sending invitations

Invitations are **never sent automatically** — always a separate, explicit action, typically days or weeks after the import, once schedules are finalized.

From a participant's admin detail page (or a bulk action over a filtered list), you can send an invitation. This calls Supabase's invite-email system, which emails the participant a claim link.

- **If the email is already registered** to an existing account, the invitation is not sent automatically — you're shown that it failed and can resolve it manually (linking to the existing account is a separate, explicit action requiring you to confirm the existing account's identity first).
- **Resend**: safe to click again — it simply refreshes the invite link and increments a resend counter, it does not double-invite anyone.
- **Revoke**: marks the invitation revoked. If the participant never claimed it, this also removes the associated login account. If they already claimed it (i.e., they're an active user now), revoking never deletes their account.
- **Claiming**: when the participant clicks their link and logs in, the platform verifies the login is actually the person the invitation was sent to before granting them access to their own application and schedule — simply having *an* Auth account is never enough to see anyone's data; ownership is only established by this explicit claim step.

**A known, current limitation**: as of this writing, this project's outbound email has a low sending rate limit (2 emails/hour on Supabase's default mailer, with no custom email service currently configured) — plan invitation sends accordingly for a large batch, or contact whoever manages the Supabase project about configuring a custom SMTP provider if higher throughput is needed. This is an infrastructure limitation, not a bug in the import feature.

## Rollback

Rollback undoes an entire import batch — either it fully undoes, or it's blocked entirely; there's no partial rollback.

- **If nothing downstream has touched any participant from that batch yet** (no feature extraction, clustering, allocation, or published schedule references them): rollback is allowed. Newly-created participants are removed entirely; updated participants are restored to exactly what they were before the import, including their answers.
- **If anything downstream already references even one participant from that batch**: rollback is blocked for the whole batch, and you're shown exactly what's blocking it. In that situation, the documented path forward is a **correcting/superseding import** — a new upload that updates the same records going forward — rather than forcing an undo of state that's already been built on.
- **If an invitation has already been sent** to anyone in the batch: rollback is also blocked for that participant until the invitation is revoked first, since an invitation being sent means a real email (and potentially a real login account) now exists outside the platform's own undo boundary.

Rolling back a batch, then re-importing the exact same file, works cleanly and is not treated as "unchanged" — the rollback restores the participant to their pre-import state, so a subsequent re-import is correctly seen as new content to apply.

## The legacy self-registration flag

The platform's original public self-registration flow still exists in the codebase but is switched off by default and removed from the production navigation. It's controlled by the `ENABLE_SELF_REGISTRATION` environment variable — set it to `true` to re-enable it, or leave it unset/`false` (the default) to keep it off. This is a deliberate feature flag, not a removal, in case self-registration needs to come back for a future intake round.

## Troubleshooting

- **"This file was already uploaded"** — the platform detected an identical file by content checksum. If you intended a fresh run with the same content, you can proceed anyway; this is a heads-up, not a hard block.
- **A row is stuck in "blocked" and won't import** — it matches an existing participant who already has downstream data (feature extraction/clustering/allocation/a published schedule) attached. Resolve by either leaving that row out of this import (it'll still import everyone else) or, if the update genuinely needs to happen, removing the conflicting downstream data for that one participant first through its own page before re-attempting.
- **A row shows a validation error** — download the error report (CSV) from the preview screen, fix the underlying cell in your source Excel file, and re-upload. The error messages describe exactly what didn't parse (a malformed email, an unparseable date, a required field left blank, etc.).
- **Invitation send fails with "email already registered"** — someone already has a login with that email address. Use the manual "link to existing account" action after confirming you're looking at the right person; the platform will not guess this for you.
- **Invitation send fails with a rate-limit error** — see the "Sending invitations" section above; this is Supabase's own email quota, not a code defect. Wait for the quota to reset (roughly hourly) and retry, or ask whoever manages the Supabase project about a custom SMTP provider for higher volume.
- **An import seems slow or stuck** — check the batch's status page. If it shows an error, that's the actual cause. If it's genuinely just still running, it's always safe to leave the page and come back — the import is resumable and nothing is lost by waiting or by having any admin resume it.

## Data privacy and retention

- Uploaded Excel files are stored in a **private** storage bucket — never publicly accessible, and never downloadable by anyone outside staff with import permissions.
- Every original Excel cell's exact text is preserved (`raw_value`) alongside a cleaned/normalized version used for matching and processing — this is intentional, for audit and correction purposes, not an oversight. If a participant's raw imported answer needs to be corrected or removed for a privacy request, that's a manual data-correction action, not something this feature does automatically.
- A subset of answers — accessibility requirements, dietary requirements, emergency contact name, emergency contact phone, and general special-needs notes — are marked sensitive and restricted to the most privileged staff role only; ordinary allocation/agenda staff can see and use every other imported answer for their normal review and allocation work, but never these fields.
- An imported participant's data is invisible to everyone except staff until that specific participant claims their account via their invitation link — there is no window where an unclaimed record is readable by any other logged-in user, participant or otherwise.
- Every sensitive action on an import — upload, mapping confirmation, import confirmation, rollback, downstream processing, and every invitation send/resend/revoke/claim — is written to the platform's existing audit log, associated with the staff member who performed it.
