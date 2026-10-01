# Timezone Unification (Europe/Istanbul) — Design

**Sub-project:** 4a of the Sessions/Booking/Work-Groups roadmap item (sub-project 4 of 6 in the overall COY21 platform plan).

## 1. Problem

The conference is in Antalya, Türkiye (5–7 Nov 2026). All conference-time display in the app should show Turkey local time. Instead, the codebase has two inconsistent, both-wrong hardcoded timezones in active use:

- **`'Asia/Muscat'`** — used in 17 application files plus one DB trigger. Muscat is a fixed UTC+4 offset, no DST.
- **`'Asia/Istanbul'`** — used in 4 newer, participant-facing files (`my-agenda/browse`, `my-agenda/agenda-day`, `arrivals/page.tsx`, `travel-form.tsx`). **This is not a valid IANA timezone identifier.** `Intl.DateTimeFormat`/`toLocaleString` throw `RangeError: Invalid time zone specified: Asia/Istanbul` when given it — meaning these screens are likely crashing for real users today, not just showing a wrong time.
- The session-reminder cron email (`src/app/api/cron/session-reminders/route.ts`) formats the session start time with **no `timeZone` option at all**, so it renders in whatever zone the server process happens to run in (UTC on Vercel) — a different bug class (missing, not wrong).
- The correct identifier, `'Europe/Istanbul'`, appears exactly once in the entire `src/` tree, as a label string in `en.json` — never actually passed to any formatting call.

Turkey abolished DST in 2016 and has stayed on permanent UTC+3 ("TRT") year-round since. This means the fix can reuse the exact same fixed-offset-arithmetic technique already used for Muscat (`session-edit-form.tsx`'s `MUSCAT_OFFSET_MS`), just with a different constant — no DST-aware timezone library is needed for correctness.

All relevant timestamp columns (`sessions.start_time/end_time`, `session_bookings.*`, `applications.submitted_at`, etc.) are already `timestamptz` (UTC instants) — this is a presentation-layer-only fix. No data migration is needed.

**Scope decision (confirmed with user):** display Europe/Istanbul time unconditionally, regardless of the viewer's device/browser timezone — not device-adaptive. No device-timezone-detection infrastructure exists today and none is partially built, consistent with this reading of the original request.

**Explicitly out of scope for this sub-project:** the suspicious hardcoded `start_time - 3 hours` fallback booking-deadline value in `my-agenda/browse/page.tsx:100` (used only when `booking_deadline` is null) — documented here as a known oddity but not changed, since it's a booking-rules question that belongs to a later part of sub-project 4. The parallel `src/components/schedule/*` feature (`time-marker.tsx`, `day-timeline.tsx`) is updated for consistency (it's cheap and in-scope since it hardcodes Muscat too) but no investigation into whether it's live or dead code is performed.

## 2. Shared utility module

New file: `src/lib/datetime/conference-time.ts`. Exports:

- `CONFERENCE_TIMEZONE_OFFSET_MS` = `3 * 60 * 60 * 1000` (UTC+3, fixed, no DST) — with a one-line comment explaining why a constant offset is correct for Turkey and referencing this spec if the offset ever needs revisiting (e.g., if Turkey were to reintroduce DST).
- `formatConferenceTime(iso: string, locale: 'ar' | 'en', options?: { hour12?: boolean }): string` — replaces every inline `Intl.DateTimeFormat(..., { timeZone: 'Asia/Muscat' | 'Asia/Istanbul' })` display call site. Formatting options are not fully uniform across today's call sites — most use `hour: 'numeric', minute: '2-digit', hour12: true`, but `format-session-time.ts` uses `hour12: false` (24-hour, for scanner/gate staff) — so the function accepts an optional `hour12` override (default `true`) rather than assuming one fixed format fits every caller. Each updated call site passes whatever option preserves its current displayed format.
- `formatConferenceDate(iso: string, locale: 'ar' | 'en'): string` — replaces the day-heading formatting call sites (`conference-agenda/page.tsx`, `day-timeline.tsx`).
- `isoToConferenceLocalInputValue(iso: string): string` and `conferenceLocalInputValueToIso(value: string): string` — direct renames/ports of `session-edit-form.tsx`'s `isoToMuscatLocalInputValue`/`muscatLocalInputValueToIso`, with the offset swapped to the new constant. These become the single source of truth for the `datetime-local` round-trip used by session create/edit/reschedule forms.

All 21 Muscat call sites, the 4 invalid-Istanbul call sites, and the two write-path functions currently duplicated/imported from `session-edit-form.tsx` are updated to import from this new module instead. `session-edit-form.tsx` keeps re-exporting the two conversion functions under their old names is **not** done — call sites (`session-create-form.tsx`, `reschedule-and-reassign.tsx`) are updated to import from the new module directly, and the old Muscat-named functions are deleted from `session-edit-form.tsx` entirely (no backward-compat shim, per project convention of not keeping unused renamed exports around).

The admin audit-timestamp call sites (accounts table, applications list, import batch detail, etc. — the ones currently using bare `toLocaleString()`/`toLocaleDateString()` with no `timeZone`, rendering in the viewer's browser-local time) are **not** touched by this sub-project. Those are "when did I perform this action" audit trails, not conference-schedule times, and changing them wasn't part of the reported problem — flagged here only so it's a deliberate exclusion, not an oversight.

## 3. Cron reminder email fix

`src/app/api/cron/session-reminders/route.ts`'s `startLocal` computation (currently `new Date(session.start_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })` with no timezone) is updated to use `formatConferenceTime` from the new module instead, so reminder emails show the correct Istanbul-local session time regardless of which UTC offset the Vercel cron runtime happens to be in.

## 4. Database trigger fix

Migration `supabase/migrations/20261002000000_sessions_day_match_europe_istanbul.sql`: redefines `enforce_session_day_match()` to use `at time zone 'Europe/Istanbul'` instead of `at time zone 'Asia/Muscat'`. Postgres ships its own IANA tzdata and supports `'Europe/Istanbul'` natively in `AT TIME ZONE` — this is unrelated to the JS-side `'Asia/Istanbul'` typo bug and is a straightforward, correct one-line swap. The function's existing `comment on function` documentation (from `20260723030000_document_trigger_cross_references.sql`) is updated in the same migration to reflect the new zone.

## 5. i18n label strings

`en.json`/`ar.json` label strings referencing "Asia/Muscat"/"توقيت مسقط" (timeMarker label, admin form field labels for start/end/check-in times) are updated to "Europe/Istanbul"/"توقيت إسطنبول", matching the one existing correct English label at `(public).agenda.timezoneLabel`. This also fixes the inconsistency where the Arabic public-agenda label already said "توقيت مسقط" even where its English sibling said "Europe/Istanbul".

## 6. Testing

- **Unit tests** (`tests/datetime/conference-time.test.ts`): round-trip correctness of `isoToConferenceLocalInputValue`/`conferenceLocalInputValueToIso` (a known UTC instant converts to the expected Istanbul wall-clock string and back losslessly), and `formatConferenceTime`/`formatConferenceDate` produce the expected Istanbul-local string for both `ar` and `en` locales given a known UTC instant.
- **Live test** (`tests/agenda/session-day-match-live.test.ts`, against the scratch project): inserting a session whose UTC `start_time`/`end_time` correspond to a valid Istanbul-local calendar day matching its `conference_day_id` succeeds; a session whose Istanbul-local date would fall outside that day is rejected by the trigger — confirming the DB-side fix works with real Postgres tzdata, not just the JS-side assumption.
- No new RLS or permission surface is introduced — this sub-project touches only formatting/conversion logic.

## 7. Files touched (summary)

**New:**
- `src/lib/datetime/conference-time.ts`
- `tests/datetime/conference-time.test.ts`
- `tests/agenda/session-day-match-live.test.ts`
- `supabase/migrations/20261002000000_sessions_day_match_europe_istanbul.sql`

**Modified (display call sites, Muscat → shared module):**
- `src/app/[locale]/(public)/conference-agenda/page.tsx`
- `src/app/[locale]/(participant)/(shell)/my-application/page.tsx`
- `src/components/schedule/time-marker.tsx`
- `src/components/schedule/day-timeline.tsx`
- `src/components/scanner/format-session-time.ts`
- `src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/page.tsx`
- `src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/draft-review.tsx`
- `src/app/[locale]/(admin)/allocation/schedules/run-list.tsx`
- `src/app/[locale]/(admin)/allocation/schedules/participants/[applicationId]/revision-history.tsx`
- `src/app/[locale]/(admin)/allocation/schedules/changed/changed-queue.tsx`
- `src/app/[locale]/(admin)/allocation/runs/[id]/page.tsx`
- `src/app/[locale]/(admin)/allocation/runs/[id]/export/route.ts`
- `src/app/[locale]/(admin)/allocation/runs/run-list.tsx`
- `src/app/[locale]/(admin)/allocation/extraction/rule-manager.tsx`
- `src/app/[locale]/(admin)/allocation/clustering/cluster-list.tsx`
- `src/app/[locale]/(admin)/agenda/sessions/page.tsx`

**Modified (display call sites, invalid Asia/Istanbul → shared module):**
- `src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx`
- `src/app/[locale]/(participant)/(shell)/my-agenda/agenda-day.tsx`
- `src/app/[locale]/(admin)/participants/arrivals/page.tsx`
- `src/app/[locale]/(participant)/(shell)/my-travel/travel-form.tsx`

**Modified (write-path conversion, Muscat → shared module):**
- `src/app/[locale]/(admin)/agenda/sessions/[id]/session-edit-form.tsx` (conversion functions removed, display calls updated)
- `src/app/[locale]/(admin)/agenda/sessions/new/session-create-form.tsx`
- `src/app/[locale]/(admin)/agenda/sessions/[id]/reschedule-and-reassign.tsx`

**Modified (other):**
- `src/app/api/cron/session-reminders/route.ts`
- `src/messages/en.json`, `src/messages/ar.json`
