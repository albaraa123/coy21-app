# Timezone Unification (Europe/Istanbul) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every hardcoded `'Asia/Muscat'` and the invalid `'Asia/Istanbul'` timezone string in the codebase with a single shared `Europe/Istanbul` conversion module, fixing both a wrong-timezone bug and a runtime-crashing invalid-IANA-identifier bug.

**Architecture:** A new `src/lib/datetime/conference-time.ts` module centralizes all conference-time formatting and `datetime-local` round-trip conversion using a fixed +3 hour offset (Turkey has observed permanent UTC+3 with no DST since 2016, so no DST-aware timezone library is needed). One DB migration updates the `enforce_session_day_match` trigger to use `Europe/Istanbul` natively (Postgres ships its own IANA tzdata). All display/write call sites across ~24 files are updated to import from the new module; the two Muscat-named conversion functions in `session-edit-form.tsx` are deleted (not re-exported) once their only two importers are updated. i18n labels are updated for consistency. No DB schema or RLS changes — purely presentation-layer plus one trigger's internal timezone string.

**Tech Stack:** Next.js App Router, TypeScript, `Intl.DateTimeFormat`, Supabase Postgres (`AT TIME ZONE`), Vitest.

**Reference spec:** `docs/superpowers/specs/2026-10-01-timezone-unification-design.md`

---

### Task 1: Shared conference-time module + unit tests

**Files:**
- Create: `src/lib/datetime/conference-time.ts`
- Test: `tests/datetime/conference-time.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/datetime/conference-time.test.ts
import { describe, it, expect } from 'vitest';
import {
  CONFERENCE_TIMEZONE_OFFSET_MS,
  formatConferenceTime,
  formatConferenceDate,
  isoToConferenceLocalInputValue,
  conferenceLocalInputValueToIso,
} from '@/lib/datetime/conference-time';

describe('conference-time', () => {
  it('CONFERENCE_TIMEZONE_OFFSET_MS is exactly 3 hours', () => {
    expect(CONFERENCE_TIMEZONE_OFFSET_MS).toBe(3 * 60 * 60 * 1000);
  });

  it('formatConferenceTime renders the Istanbul-local wall-clock time (en, 12h)', () => {
    // 2026-11-05T09:30:00Z -> Istanbul (UTC+3) = 12:30 PM
    const result = formatConferenceTime('2026-11-05T09:30:00Z', 'en');
    expect(result).toBe('12:30 PM');
  });

  it('formatConferenceTime supports a 24-hour override via hour12: false', () => {
    const result = formatConferenceTime('2026-11-05T09:30:00Z', 'en', { hour12: false });
    expect(result).toBe('12:30');
  });

  it('formatConferenceDate renders the Istanbul-local calendar date (en)', () => {
    // 2026-11-05T22:00:00Z -> Istanbul = 2026-11-06T01:00 -> next calendar day
    const result = formatConferenceDate('2026-11-05T22:00:00Z', 'en');
    expect(result).toContain('November 6, 2026');
  });

  it('isoToConferenceLocalInputValue converts a UTC instant to the Istanbul wall-clock datetime-local string', () => {
    const result = isoToConferenceLocalInputValue('2026-11-05T09:30:00.000Z');
    expect(result).toBe('2026-11-05T12:30');
  });

  it('conferenceLocalInputValueToIso converts an Istanbul wall-clock string back to the correct UTC instant', () => {
    const result = conferenceLocalInputValueToIso('2026-11-05T12:30');
    expect(new Date(result).toISOString()).toBe('2026-11-05T09:30:00.000Z');
  });

  it('round-trips isoToConferenceLocalInputValue -> conferenceLocalInputValueToIso losslessly', () => {
    const original = '2026-11-05T14:45:00.000Z';
    const local = isoToConferenceLocalInputValue(original);
    const roundTripped = conferenceLocalInputValueToIso(local);
    expect(new Date(roundTripped).getTime()).toBe(new Date(original).getTime());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/datetime/conference-time.test.ts`
Expected: FAIL — `Cannot find module '@/lib/datetime/conference-time'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/datetime/conference-time.ts
//
// Turkey (host country for COY21, Antalya, Nov 2026) abolished DST in 2016
// and has observed a permanent UTC+3 offset ("TRT") year-round since. This
// means conference-local time can be computed with plain fixed-offset
// arithmetic rather than a full IANA-aware timezone library. If Turkey ever
// reintroduces DST, this constant (and the two conversion functions below)
// would need to become DST-aware — see
// docs/superpowers/specs/2026-10-01-timezone-unification-design.md for the
// full investigation this module replaces (17 files hardcoding the wrong
// 'Asia/Muscat' zone, plus 4 files using the invalid, crash-inducing
// 'Asia/Istanbul' string).
export const CONFERENCE_TIMEZONE_OFFSET_MS = 3 * 60 * 60 * 1000;

type Locale = 'ar' | 'en';

function toIntlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar' : 'en-US';
}

export function formatConferenceTime(
  iso: string,
  locale: Locale,
  options?: { hour12?: boolean }
): string {
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    timeZone: 'Europe/Istanbul',
    hour: 'numeric',
    minute: '2-digit',
    hour12: options?.hour12 ?? true,
  }).format(new Date(iso));
}

export function formatConferenceDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    timeZone: 'Europe/Istanbul',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso));
}

// ISO instant (from the DB) -> the wall-clock time an Istanbul-based staff
// member should see in a `datetime-local` input, formatted as the
// `YYYY-MM-DDTHH:mm` string that input requires.
export function isoToConferenceLocalInputValue(iso: string): string {
  const utcMs = new Date(iso).getTime();
  const istanbulMs = utcMs + CONFERENCE_TIMEZONE_OFFSET_MS;
  const d = new Date(istanbulMs);
  // Read UTC getters on the shifted timestamp so no additional (browser-local)
  // timezone conversion is layered on top of the Istanbul shift already applied.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// What staff type into a `datetime-local` input (a timezone-less wall-clock
// string) -> the ISO instant to send to the server, interpreting what they
// typed as Europe/Istanbul wall-clock time (not the browser's local
// timezone, which may differ from Istanbul).
export function conferenceLocalInputValueToIso(value: string): string {
  // `value` is `YYYY-MM-DDTHH:mm`, timezone-less. Parsing it with a trailing
  // `Z` makes Date.UTC-style parsing treat those digits as UTC wall-clock
  // fields; subtracting the Istanbul offset then yields the correct UTC
  // instant for "this wall-clock time, in Europe/Istanbul".
  const asIfUtcMs = new Date(`${value}:00Z`).getTime();
  const utcMs = asIfUtcMs - CONFERENCE_TIMEZONE_OFFSET_MS;
  return new Date(utcMs).toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/datetime/conference-time.test.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add src/lib/datetime/conference-time.ts tests/datetime/conference-time.test.ts
git commit -m "feat: add shared Europe/Istanbul conference-time conversion module"
```

---

### Task 2: DB trigger migration + fix existing test fixture offsets + new live test

**Context:** `enforce_session_day_match()` in `supabase/migrations/20260723020000_sessions_triggers.sql:6-30` currently converts via `at time zone 'Asia/Muscat'`. Its exact exception message text ("Session start/end time (%) does not match its conference day (%)") is pattern-matched by name elsewhere (documented in `supabase/migrations/20260723030000_document_trigger_cross_references.sql:17`) — **do not change the message text**, only the timezone inside the function body.

`tests/agenda/conflict-and-validation.test.ts` already exercises this trigger using fixture literals with a hardcoded `+04:00` offset (Muscat) throughout — e.g. line 91: `` `${DAY1}T${hour}:00:00+04:00` ``. These fixtures encode wall-clock-as-written-assuming-Muscat. Once the trigger switches to Istanbul (+3), the same UTC instants are interpreted 1 hour differently, which does not change which calendar date they fall on for any of this file's existing times (none are within 1 hour of midnight Muscat-time) — but this must be verified by actually running the file against the new trigger, not assumed. The literals are also updated from `+04:00` to `+03:00` so the intent of each fixture ("insert a session at wall-clock time X in the conference's timezone") remains correct and self-documenting now that the conference timezone is Istanbul, not Muscat.

**Files:**
- Create: `supabase/migrations/20261002000000_sessions_day_match_europe_istanbul.sql`
- Modify: `tests/agenda/conflict-and-validation.test.ts` (all 17 occurrences of `+04:00` → `+03:00`)
- Test: `tests/agenda/session-day-match-live.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- 20261002000000_sessions_day_match_europe_istanbul.sql
--
-- Switches enforce_session_day_match() from Asia/Muscat to Europe/Istanbul,
-- matching the conference's actual location (Antalya, Türkiye). Turkey
-- observes a fixed UTC+3 offset year-round (no DST since 2016), and
-- Postgres ships its own IANA tzdata, so 'Europe/Istanbul' is valid and
-- correct directly in AT TIME ZONE here (this is unrelated to the
-- JavaScript-side 'Asia/Istanbul' bug fixed in application code separately
-- — that was an invalid IANA string; this is a valid one, just the wrong
-- city, being corrected).
--
-- The exception message text is NOT changed — it is pattern-matched
-- elsewhere (see supabase/migrations/20260723030000_document_trigger_cross_references.sql's
-- comment on this function for the full contract).
create or replace function enforce_session_day_match() returns trigger as $$
declare
  v_conference_date date;
  v_start_date date;
  v_end_date date;
begin
  select conference_date into v_conference_date from conference_days where id = new.conference_day_id;
  if v_conference_date is null then
    raise exception 'conference_day_id % does not exist', new.conference_day_id;
  end if;

  v_start_date := (new.start_time at time zone 'Europe/Istanbul')::date;
  v_end_date := (new.end_time at time zone 'Europe/Istanbul')::date;

  if v_start_date <> v_end_date then
    raise exception 'Session cannot span across midnight into a different conference day (start: %, end: %)', v_start_date, v_end_date;
  end if;

  if v_start_date <> v_conference_date then
    raise exception 'Session start/end time (%) does not match its conference day (%)', v_start_date, v_conference_date;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function enforce_session_day_match() is 'Fires on sessions insert/update of start_time, end_time, conference_day_id. Enforces that a session''s start/end time (converted to Europe/Istanbul) falls on the same calendar date as its conference_day_id''s conference_date, and does not cross midnight. Contract: the raise exception message "Session start/end time (%) does not match its conference day (%)" contains the substring ''does not match its conference day'', which Task 12''s translateSessionWriteError() (src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts) matches via error.message.includes(''does not match its conference day'') to produce a friendly UI error. Do not reword this message without updating that function too.';
```

- [ ] **Step 2: Confirm the scratch project is linked, then apply the migration**

Run: `cat supabase/.temp/linked-project.json`
Expected output must show `"ref":"jgsuguohtjqurnshagup"` (the `coy21-dev-scratch3` scratch project). **Do not proceed if it shows any other ref.**

Run: `npx supabase db push`
Expected: migration applies cleanly with no errors.

- [ ] **Step 3: Update the existing live test's fixture offsets**

In `tests/agenda/conflict-and-validation.test.ts`, replace every occurrence of `+04:00` with `+03:00` (17 occurrences — the `baseSession()` default at line 91-92, and every explicit `start_time`/`end_time` override throughout the file, including the RPC call at lines 264-265). Also add a one-line comment near the top of the file (near the `DAY1`/`DAY2` constants, around line 23) noting that fixture times use `+03:00` because the conference timezone is Europe/Istanbul (fixed UTC+3), not Asia/Muscat.

Run: `npx vitest run tests/agenda/conflict-and-validation.test.ts`
Expected: PASS, same pass count as before the edit (this file has no skips as of this plan's writing — confirm the count matches a pre-edit baseline run if uncertain).

- [ ] **Step 4: Write the new live test for the Istanbul conversion itself**

```typescript
// tests/agenda/session-day-match-live.test.ts
//
// Confirms the DB trigger (migrated in
// 20261002000000_sessions_day_match_europe_istanbul.sql) correctly uses
// Postgres's native Europe/Istanbul tzdata, not just a JS-side assumption.
// Runs against the live scratch Supabase project — NOT isolated from other
// test data; see tests/agenda/conflict-and-validation.test.ts for the same
// pattern this file follows.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!URL || !SERVICE_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to run this live test');
}
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const DAY = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let dayId: string;
let trackId: string;
let sessionTypeId: string;
let roomId: string;

beforeAll(async () => {
  const { data: day } = await admin.from('conference_days').insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 }).select('id').single();
  dayId = day!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `TZ-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sType } = await admin.from('session_types').insert({ code: `TZ-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sType!.id;
  const { data: room } = await admin.from('rooms').insert({ code: `TZ-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 100 }).select('id').single();
  roomId = room!.id;
});

afterAll(async () => {
  await admin.from('sessions').delete().eq('track_id', trackId);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().eq('id', dayId);
});

function baseSession(overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  return {
    session_code: `TZ-${Math.random().toString(36).slice(2, 10)}`,
    title_ar: 'جلسة اختبار التوقيت', title_en: 'Timezone Test Session',
    conference_day_id: dayId,
    track_id: trackId, session_type_id: sessionTypeId, room_id: roomId,
    language: 'en' as const, difficulty_level: 'beginner' as const,
    capacity: 20, min_capacity: 0,
    ...overrides,
  };
}

describe('enforce_session_day_match uses Europe/Istanbul (not Asia/Muscat)', () => {
  it('accepts a session whose Istanbul-local wall-clock time falls within the conference day, even when its UTC date differs', async () => {
    // 00:30 Istanbul (+03:00) on DAY falls on DAY in Istanbul, but is
    // 21:30 UTC on the PREVIOUS calendar day. If the trigger were still
    // using Asia/Muscat (+04:00) this same instant is 01:30 Muscat-time on
    // DAY -- also matches DAY, so this specific instant doesn't
    // discriminate between the two zones. The real discriminator is the
    // offset used when WRITING the literal below: we write it as an
    // explicit +03:00 offset, so this test is really confirming Postgres's
    // AT TIME ZONE 'Europe/Istanbul' agrees with a +03:00 wall-clock
        // reading -- i.e., that the migration's string is valid and produces
    // the expected offset, not a different real-world UTC+3 zone with
    // unexpected DST rules.
    const { error } = await admin.from('sessions').insert(baseSession({
      start_time: `${DAY}T00:30:00+03:00`,
      end_time: `${DAY}T01:30:00+03:00`,
    }));
    expect(error).toBeNull();
  });

  it('rejects a session whose Istanbul-local date does not match its conference_day_id', async () => {
    // 23:30 UTC on DAY -> Istanbul (+3) = 02:30 on the NEXT calendar day,
    // which does not match conference_day_id's date (DAY).
    const { error } = await admin.from('sessions').insert(baseSession({
      start_time: `${DAY}T23:30:00Z`,
      end_time: `${DAY}T23:50:00Z`,
    }));
    expect(error).not.toBeNull();
    expect(error?.message).toContain('does not match its conference day');
  });
});
```

- [ ] **Step 5: Run the new live test**

Run: `npx vitest run tests/agenda/session-day-match-live.test.ts`
Expected: PASS (2/2)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261002000000_sessions_day_match_europe_istanbul.sql tests/agenda/conflict-and-validation.test.ts tests/agenda/session-day-match-live.test.ts
git commit -m "fix: switch enforce_session_day_match trigger from Asia/Muscat to Europe/Istanbul"
```

---

### Task 3: Fix the session-reminder cron email's missing timezone

**Context:** `src/app/api/cron/session-reminders/route.ts:102-104` formats `startLocal` with `toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })` and **no `timeZone` option**, so it renders in the server process's local zone (UTC on Vercel), not Istanbul.

**Files:**
- Modify: `src/app/api/cron/session-reminders/route.ts`

- [ ] **Step 1: Add the import**

Add near the top of the file, alongside the other `@/lib/...` imports (after line 18's `fetchEmailSettings, sendEmailGuarded` import):

```typescript
import { formatConferenceTime } from '@/lib/datetime/conference-time';
```

- [ ] **Step 2: Replace the formatting call**

Replace (around line 102-104):
```typescript
    const startLocal = session.start_time
      ? new Date(session.start_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '';
```
with:
```typescript
    const startLocal = session.start_time
      ? formatConferenceTime(session.start_time, 'en', { hour12: false })
      : '';
```

(`hour12: false` preserves the existing 24-hour `en-GB`-style display this email already used; only the missing timezone is being fixed, not the hour format.)

- [ ] **Step 3: Verify no other formatting logic in this file needs the same fix**

Run: `grep -n "toLocaleTimeString\|toLocaleDateString\|toLocaleString" "src/app/api/cron/session-reminders/route.ts"`
Expected: only the line just changed matches (now calling `formatConferenceTime`, not `toLocaleTimeString`) — confirms there is no second unguarded formatting call left in this file.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors introduced by this file.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/cron/session-reminders/route.ts"
git commit -m "fix: session-reminder cron email now shows the correct Europe/Istanbul time"
```

---

### Task 4: Session create/edit/reschedule forms — remove Muscat conversion functions, use shared module

**Context:** `session-edit-form.tsx` currently exports `MUSCAT_OFFSET_MS`, `isoToMuscatLocalInputValue`, `muscatLocalInputValueToIso` (lines 15-45), imported by exactly two other files: `session-create-form.tsx` (imports `muscatLocalInputValueToIso`) and `reschedule-and-reassign.tsx` (imports both conversion functions). All three files also independently call `Intl.DateTimeFormat`/similar with `'Asia/Muscat'` or `'Asia/Istanbul'` for display elsewhere — those display call sites are handled together with the rest of the display sweep in Task 5, **except** these three files are done here since they're tightly coupled to the conversion-function deletion (deleting the functions breaks the other two files' imports in the same commit, so they must move together).

**Files:**
- Modify: `src/app/[locale]/(admin)/agenda/sessions/[id]/session-edit-form.tsx`
- Modify: `src/app/[locale]/(admin)/agenda/sessions/new/session-create-form.tsx`
- Modify: `src/app/[locale]/(admin)/agenda/sessions/[id]/reschedule-and-reassign.tsx`

- [ ] **Step 1: Remove the Muscat conversion functions from `session-edit-form.tsx`**

Delete lines 15-45 (the comment block, `MUSCAT_OFFSET_MS`, `isoToMuscatLocalInputValue`, `muscatLocalInputValueToIso`) entirely. Add an import instead:

```typescript
import { isoToConferenceLocalInputValue, conferenceLocalInputValueToIso } from '@/lib/datetime/conference-time';
```

Then, within this same file, find every remaining usage of `isoToMuscatLocalInputValue`/`muscatLocalInputValueToIso` (the functions just deleted were almost certainly also used later in this same file, not just re-exported) and rename those call sites to `isoToConferenceLocalInputValue`/`conferenceLocalInputValueToIso`. Run `grep -n "Muscat" "src/app/[locale]/(admin)/agenda/sessions/[id]/session-edit-form.tsx"` first to find every remaining reference (including any `Asia/Muscat` display-formatting calls in this same file — fix those too while here, using `formatConferenceTime`/`formatConferenceDate` with an added import, since this file is already being opened and edited).

- [ ] **Step 2: Update `session-create-form.tsx`**

Replace line 7:
```typescript
import { muscatLocalInputValueToIso } from '../[id]/session-edit-form';
```
with:
```typescript
import { conferenceLocalInputValueToIso } from '@/lib/datetime/conference-time';
```

Replace all 4 call sites (lines 105, 106, 119, 120) from `muscatLocalInputValueToIso(...)` to `conferenceLocalInputValueToIso(...)`.

- [ ] **Step 3: Update `reschedule-and-reassign.tsx`**

Replace line 8:
```typescript
import { isoToMuscatLocalInputValue, muscatLocalInputValueToIso } from './session-edit-form';
```
with:
```typescript
import { isoToConferenceLocalInputValue, conferenceLocalInputValueToIso } from '@/lib/datetime/conference-time';
```

Replace call sites at lines 43, 44 (`isoToMuscatLocalInputValue` → `isoToConferenceLocalInputValue`) and lines 87, 88 (`muscatLocalInputValueToIso` → `conferenceLocalInputValueToIso`). Also run `grep -n "Asia/Muscat\|Asia/Istanbul" "src/app/[locale]/(admin)/agenda/sessions/[id]/reschedule-and-reassign.tsx"` to check for any separate display-formatting hardcode in this file and fix it the same way (import `formatConferenceTime`/`formatConferenceDate` as needed) — this file is in the "display call sites" list for Task 5, but since it's already open in this task, fix it now instead of reopening it later.

- [ ] **Step 4: Verify no remaining references to the deleted functions anywhere in the repo**

Run: `grep -rn "muscatLocalInputValueToIso\|isoToMuscatLocalInputValue\|MUSCAT_OFFSET_MS" src/ tests/`
Expected: no matches.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual smoke check**

Run: `npm run dev` (or confirm it's already running), then as a staff user navigate to an existing session's edit page and confirm the start/end/check-in time fields show a sensible Istanbul-local wall-clock time (not shifted by an extra hour, not blank). Also open the "create session" and "reschedule" forms and confirm the same. Stop the dev server when done if you started it.

- [ ] **Step 7: Commit**

```bash
git add "src/app/[locale]/(admin)/agenda/sessions/[id]/session-edit-form.tsx" "src/app/[locale]/(admin)/agenda/sessions/new/session-create-form.tsx" "src/app/[locale]/(admin)/agenda/sessions/[id]/reschedule-and-reassign.tsx"
git commit -m "refactor: session create/edit/reschedule forms use shared Europe/Istanbul conversion"
```

---

### Task 5: Remaining display call sites — Muscat and invalid-Istanbul sweep

**Context:** The remaining files hardcode `'Asia/Muscat'` or `'Asia/Istanbul'` purely for **display** (no write-path conversion involved — that was Task 4). Each one currently has its own local `Intl.DateTimeFormat`/`toLocaleTimeString`/`toLocaleDateString` call(s) with the wrong/invalid zone. This task replaces each with a call to `formatConferenceTime`/`formatConferenceDate` from the shared module, preserving each file's existing formatting options (locale selection, `hour12`, weekday/month/day granularity) exactly as they are today — only the timezone source changes.

**Files to modify** (process one at a time; each is independent and can be verified individually):
- `src/app/[locale]/(public)/conference-agenda/page.tsx` (lines 59-62 — note this file uses `hour12: false`, pass `{ hour12: false }`)
- `src/app/[locale]/(participant)/(shell)/my-application/page.tsx` (line 66)
- `src/components/schedule/time-marker.tsx` (line 6 — uses `hour12: false`, pass `{ hour12: false }`)
- `src/components/schedule/day-timeline.tsx` (lines 6, 31)
- `src/components/scanner/format-session-time.ts` (line 8 — uses the default 12-hour format, no `hour12` option needed; do NOT pass `{ hour12: false }` here — only `time-marker.tsx` and `conference-agenda/page.tsx` actually use 24-hour)
- `src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/page.tsx` (line 67)
- `src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/draft-review.tsx` (line 142)
- `src/app/[locale]/(admin)/allocation/schedules/run-list.tsx` (lines 63, 68, 104, 108)
- `src/app/[locale]/(admin)/allocation/schedules/participants/[applicationId]/revision-history.tsx` (line 39)
- `src/app/[locale]/(admin)/allocation/schedules/changed/changed-queue.tsx` (line 42)
- `src/app/[locale]/(admin)/allocation/runs/[id]/page.tsx` (lines 93, 96)
- `src/app/[locale]/(admin)/allocation/runs/[id]/export/route.ts` (lines 53, 54)
- `src/app/[locale]/(admin)/allocation/runs/run-list.tsx` (lines 124, 129, 160, 164)
- `src/app/[locale]/(admin)/allocation/extraction/rule-manager.tsx` (lines 309, 331)
- `src/app/[locale]/(admin)/allocation/clustering/cluster-list.tsx` (line 189)
- `src/app/[locale]/(admin)/agenda/sessions/page.tsx` (lines 214, 216, 250, 252)
- `src/app/[locale]/(participant)/(shell)/my-agenda/browse/page.tsx` (lines 111-116 — invalid `Asia/Istanbul`)
- `src/app/[locale]/(participant)/(shell)/my-agenda/agenda-day.tsx` (lines 60, 67 — invalid `Asia/Istanbul`)
- `src/app/[locale]/(admin)/participants/arrivals/page.tsx` (line 52 — invalid `Asia/Istanbul`)
- `src/app/[locale]/(participant)/(shell)/my-travel/travel-form.tsx` (line 124 — invalid `Asia/Istanbul`)

- [ ] **Step 1: For each file above, apply the same mechanical transform**

1. Add the import: `import { formatConferenceTime, formatConferenceDate } from '@/lib/datetime/conference-time';` (adjust the relative/alias path if the file doesn't already use `@/` aliasing — check an existing import in the same file for the correct alias convention).
2. Replace each inline `new Date(iso).toLocaleTimeString(...)` / `new Intl.DateTimeFormat(..., { timeZone: 'Asia/Muscat' | 'Asia/Istanbul', hour: ..., minute: ... }).format(new Date(iso))` call with `formatConferenceTime(iso, locale, { hour12: <preserve existing value> })` — read the existing `hour12` value from the call being replaced (default is `true` if the file didn't set it) and pass it explicitly only if it differs from the default, matching Task 1's module signature.
3. Replace each inline day/date-heading formatting call (`weekday`/`year`/`month`/`day` options) with `formatConferenceDate(iso, locale)`.
4. If the file's locale variable isn't literally named `locale` or isn't already typed as `'ar' | 'en'`, check how it's derived (e.g., `locale === 'ar' ? 'ar' : 'en-US'` inline) and pass the simpler `'ar' | 'en'` value through instead, since the shared module does that `'ar'`/`'en-US'` branching internally — do not pass `'en-US'` into `formatConferenceTime`'s `locale` parameter, it expects `'ar' | 'en'`.
5. Remove any now-unused local `formatDay`/`formatTime`/similar helper function the file had defined inline, if the only thing it did was wrap the now-removed `Intl.DateTimeFormat` call.

- [ ] **Step 2: After each file (or small batch of 3-4 similar files), run a verification grep**

Run: `grep -rn "Asia/Muscat\|Asia/Istanbul" src/`
Expected: the count of remaining matches decreases with each file/batch completed, trending to zero once all files in this task are done.

- [ ] **Step 3: Typecheck after the full sweep**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Final verification — zero hardcoded hits remain in application code**

Run: `grep -rn "Asia/Muscat\|Asia/Istanbul" src/ --include="*.ts" --include="*.tsx"`
Expected: no matches at all (the i18n label strings in `en.json` are handled separately in Task 6 and use plain-text labels like `"Asia/Muscat"` inside JSON values, not code — if this grep is scoped to `.ts`/`.tsx` only as shown, those won't appear here anyway). `ar.json` is deliberately excluded from both this grep and Task 6 — see Task 6's note on its pre-existing, unrelated encoding corruption.

- [ ] **Step 5: Manual smoke check**

With the dev server running, visit: the public conference agenda page, the participant's `/my-agenda` and `/my-agenda/browse` pages, the admin agenda sessions list, and the admin allocation schedule/run pages. Confirm every displayed session/run time looks like a sensible Istanbul-local time (no crash, no obviously-shifted-by-an-hour value) and that the previously-crashing `my-agenda/browse` and `my-agenda/agenda-day` pages now load without a `RangeError`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: replace remaining hardcoded Asia/Muscat and invalid Asia/Istanbul display call sites with shared Europe/Istanbul formatter"
```

(Using `git add -A` here is acceptable since Task 5's scope is exactly "every remaining display file listed above, nothing else" — confirm with `git status` before committing that no unrelated files are staged.)

---

### Task 6: i18n label strings

**Context:** `en.json` has label strings literally containing "Asia/Muscat" that are shown to users (form field labels, a timezone-label badge) but aren't themselves executable formatting calls.

**IMPORTANT — do not edit `ar.json` in this task.** `src/messages/ar.json` has a pre-existing, repo-wide encoding corruption unrelated to this sub-project: the file starts with a UTF-8 BOM, and every Arabic string in it is double-encoded UTF-8 (mojibake) — confirmed present since the repository's very first commit, long before any timezone work. Concretely: `grep -n "مسقط" src/messages/ar.json` returns **zero matches today**, not because the Arabic Muscat labels don't exist, but because the actual bytes on disk are garbled (e.g. the `timezoneLabel` value is literally the byte sequence that renders as `ØªÙˆÙ‚ÙŠØª Ù…Ø³Ù‚Ø·`, not `توقيت مسقط`). `JSON.parse` on this file also currently fails outright because of the leading BOM, independent of anything in this plan. The user has explicitly decided (2026-10-01) to fix this as a **separate, dedicated bug-fix effort** after sub-project 4a ships, not as a side effect of the timezone work — attempting a targeted mojibake-aware replacement here risks mis-repairing unrelated strings in a file this plan has no full visibility into. **Do not attempt to "fix" ar.json's encoding as part of this task.** If asked to touch `ar.json` at all here, stop and confirm with the user first.

**Files:**
- Modify: `src/messages/en.json`

- [ ] **Step 1: Update `en.json`**

Change these string values (keep the JSON keys unchanged):
- Line 680: `"timezoneLabel": "Asia/Muscat"` → `"timezoneLabel": "Europe/Istanbul"`
- Line 1127: `"startTime": "Start time (Asia/Muscat)"` → `"startTime": "Start time (Europe/Istanbul)"`
- Line 1128: `"endTime": "End time (Asia/Muscat)"` → `"endTime": "End time (Europe/Istanbul)"`
- Line 1141: `"checkinOpensAt": "Check-in opens (Asia/Muscat)"` → `"checkinOpensAt": "Check-in opens (Europe/Istanbul)"`
- Line 1142: `"checkinClosesAt": "Check-in closes (Asia/Muscat)"` → `"checkinClosesAt": "Check-in closes (Europe/Istanbul)"`
- Lines 1194-1195 (the reschedule form's duplicate start/end time labels — confirm exact key names by reading the surrounding JSON, same substitution pattern as lines 1127-1128)

Line 806 (`(public).agenda.timezoneLabel`) already correctly says `"Europe/Istanbul"` — leave unchanged.

- [ ] **Step 2: Validate `en.json`**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/messages/en.json', 'utf8')); console.log('en.json OK')"`
Expected: prints `OK` with no parse errors.

- [ ] **Step 3: Verify no stray Muscat references remain in `en.json`**

Run: `grep -n "Muscat" src/messages/en.json`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add src/messages/en.json
git commit -m "fix: update timezone labels from Asia/Muscat to Europe/Istanbul in en.json

ar.json is intentionally NOT touched here -- it has a pre-existing,
unrelated UTF-8 BOM + double-encoding corruption affecting every
Arabic string in the file, to be fixed as a separate dedicated effort."
```

---

### Task 7: Final sweep verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm zero remaining hardcoded references anywhere in the repo**

Run: `grep -rn "Asia/Muscat\|Asia/Istanbul" src/ supabase/migrations/ --include="*.ts" --include="*.tsx" --include="*.sql"`
Expected: no matches in `src/` or `supabase/migrations/`.

`supabase/combined_migrations.sql` is a manually-maintained snapshot, not generated by any script in this repo (confirmed — no build step references it). It still contains the old `'Asia/Muscat'` string at the lines noted in the spec. Apply the same one-line substitution there too (`at time zone 'Asia/Muscat'` → `at time zone 'Europe/Istanbul'`, in the `enforce_session_day_match` function body only — do not touch the exception message text), so the snapshot stays consistent with the real migration history. This file is not applied to any database directly (the real migrations in `supabase/migrations/` are what `db push` uses); it is documentation-only, so this edit carries no deployment risk.

Run: `grep -n "Asia/Muscat\|Asia/Istanbul" supabase/combined_migrations.sql`
Expected: no matches after the edit.

- [ ] **Step 2: Run the full relevant test suite**

Run: `npx vitest run tests/datetime/ tests/agenda/`
Expected: all pass.

- [ ] **Step 3: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Full lint**

Run: `npm run lint` (check `package.json` for the exact script name if this differs)
Expected: no new errors introduced by this branch's changes.

- [ ] **Step 5: Dispatch final code review**

Use a code-reviewer subagent to review the entire branch diff (`git diff master...HEAD`) against the spec at `docs/superpowers/specs/2026-10-01-timezone-unification-design.md`, confirming every file in the spec's "Files touched" list was actually touched, no unrelated changes crept in, and the exception-message-text contract noted in Task 2 was preserved.

- [ ] **Step 6: Proceed to superpowers:finishing-a-development-branch**
