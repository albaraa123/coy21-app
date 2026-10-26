# Minor Guardian/Companion Info — Design

## Problem

The organizing team needs to record who is responsible for a participant under 18 years old (their guardian or companion), and have that visible to staff so it's known at a glance who to contact. Currently there is no such concept anywhere in the system: `applications` already captures `age_group` (`under_18 | 18_24 | 25_34 | 35_44 | 45_plus`) and/or `birth_date`, but nothing downstream uses that to flag a minor or collect a responsible-adult contact.

## Scope

In scope:
- A `super_admin`-editable guardian name + phone, entered manually per application.
- Shown on the admin participant-detail page, only for applications flagged as under-18.
- Shown read-only to the participant themselves on My Profile, only when they are under 18.

Out of scope (explicitly deferred, per team's own prioritization — manual entry first):
- Automatic population from the Excel import pipeline (`field-dictionary.ts`, mapping UI). A later iteration can add `guardian_name`/`guardian_phone` as recognized import columns once the manual path is proven.
- Participant self-service edit of their own guardian info (participant sees it read-only only; the organizing team is the source of truth, matching how emergency/health info is already staff-owned in this codebase).
- A dedicated legal "guardian" vs "companion" distinction — one generic "responsible person" field covers both, per team's own wording ("الواصي أو المرافق").

## Data Model

Two new nullable columns directly on `applications` (not `application_health_info`, despite that table's existing `emergency_contact_name/phone` precedent) — guardian info is about who's responsible for the attendee, not a medical/health concern, and `applications` is already the home for `age_group`/`birth_date`, so the under-18 flag and the guardian fields that depend on it live together.

```sql
alter table applications
  add column guardian_name text,
  add column guardian_phone text;
```

No new RLS policy is needed: `applications` already has participant-care-domain staff policies (`applications_staff_all` or equivalent) covering UPDATE for current staff-caller holders — the only gate that matters is the server action's auth check (service-role bypasses RLS entirely, same pattern documented throughout `src/lib/*/server-helpers.ts`).

## Who can write

`super_admin` only, via `requireParticipantCareStaffCaller` (`src/lib/participant-care/server-helpers.ts`) — this is the existing, correct domain helper for participant-contact-shaped data (it already governs health info and emergency contacts) and it already excludes plain `staff` per the 2026-10-25 staff-narrowing change. This is not a new policy decision for this feature; it's applying the rule the codebase already enforces everywhere adjacent.

## Under-18 detection

```
isMinor(application) =
  if age_group is not null: age_group === 'under_18'
  else if birth_date is not null: age as of the conference start date (2026-11-05) < 18
  else: false (never both null per registrationSchema's .refine for self-registered
        applications; imported applications can bypass that schema, so the
        all-null case must still resolve to false, not throw)
```

Reference date for the `birth_date` branch is the **conference start date**, not "today" — a minor who turns 18 between now and the conference is still a minor (and needs a contactable guardian) while physically attending. No existing `CONFERENCE_START_DATE`-style constant exists in the codebase today, so the new `src/lib/participants/minor.ts` helper defines its own local constant for this.

A small shared helper, `isApplicationMinor(application: { age_group: string | null; birth_date: string | null }): boolean`, added to `src/lib/participants/` (new file `minor.ts`), used identically by both the admin page and the My Profile page so the under-18 rule can't drift between the two surfaces.

## UI

**Admin — `src/app/[locale]/(admin)/participants/[applicationId]/page.tsx`:**
- Widen this page's existing service-role `applications` select (page.tsx:50) to add `guardian_name, guardian_phone` alongside the `age_group, birth_date` it already selects.
- New section/component `GuardianControls` (mirrors `ClassificationControls`'s UI shape only: client component, local state, `run()` wrapper, `window.location.reload()` on success), rendered only when `isApplicationMinor(application)` is true.
- Two inputs: name (plain text), phone (reuse the `PhoneField`/`react-phone-number-input` pattern already shipped on My Profile for consistency — single E.164 string).
- **Server action placement does NOT mirror `[applicationId]/actions.ts`'s existing actions** — every action in that file (`sendInvitationAction`, `updateParticipantTypeAction`, etc.) uses `requireAgendaStaffCaller`, not `requireParticipantCareStaffCaller`; introducing the latter there would be a new, unprecedented mix of two different staff-domain gates in one file. Instead, follow the real existing `requireParticipantCareStaffCaller` precedent: `src/app/[locale]/(admin)/participants/care/actions.ts` + `src/lib/participant-care/health-info-management.ts`. Concretely:
  - Add `updateGuardianInfoForCaller(caller: Caller, applicationId: string, input: GuardianUpdateInput)` to `src/lib/participant-care/health-info-management.ts` (or a sibling file in the same directory if it's cleaner to keep guardian logic separate from health info — implementer's call), writing `guardian_name`/`guardian_phone` on `applications` and calling `writeAuditLog` (imported from `@/lib/agenda/server-helpers`, matching `health-info-management.ts`'s own existing import — that module name is a historical artifact of where audit logging was first built, not a signal this is agenda-domain work) with `action: 'guardian_info_updated'`.
  - Add a one-line thin wrapper `updateGuardianInfo(applicationId, input)` to `src/app/[locale]/(admin)/participants/care/actions.ts`, calling `requireParticipantCareStaffCaller()` then `updateGuardianInfoForCaller(caller, ...)` — matching that file's existing `updateHealthInfo` wrapper exactly.
  - `GuardianControls` (rendered from the `[applicationId]` page) imports and calls this action from `participants/care/actions.ts`, not from its own local `actions.ts`. Cross-route-group server action imports are already normal Next.js App Router usage; no new pattern here, just importing a function from a different file.

**Participant — `src/app/[locale]/(participant)/(shell)/my-profile/page.tsx`:**
- Widen this page's existing RLS-respecting `applications` select (page.tsx:23-27, currently just `'id, status'`) to add `age_group, birth_date, guardian_name, guardian_phone`. Verified: `applications_select_own` RLS policy is a plain row-level policy with no column restriction and the `authenticated` grant is table-level, so this is a pure select-list change — no new RLS policy or grant needed.
- New read-only card "Guardian / Companion", rendered only when `isApplicationMinor(application)` is true AND at least one of `guardian_name`/`guardian_phone` is set (don't show an empty card to a minor whose guardian info hasn't been entered yet).
- No new form component — plain display, no edit affordance (team is the source of truth).

## Testing

- Unit test for `isApplicationMinor` covering: `age_group = 'under_18'`, `age_group` = any other bucket, `age_group` null + `birth_date` under/over 18 years old as of the conference start date, both null (defensive — should not occur for self-registered applications given the registration schema's refine, but imported applications can bypass that schema, so the helper must resolve this case to `false` rather than throw).
- `requireParticipantCareStaffCaller`'s rejection of plain `staff` is **not** currently covered by any direct-invocation test — `tests/participants/participant-care-live.test.ts` only ever constructs a caller manually (`{ userId, service: admin }`) and never exercises the auth check itself, and the real helper can't be invoked directly in a test anyway since it reaches `next/headers`' `cookies()` outside a request context. Do not write a test that expects `updateGuardianInfoForCaller` itself to throw on a `staff` caller — it won't, by design (the auth check lives one layer up, in the thin wrapper). Instead, mirror `tests/agenda/authorization.test.ts`'s **logic-replication** approach: a new test (or an addition to an existing participant-care test file) that re-implements the exact `isStaffRole(role) && role !== 'staff'` condition against real `profiles.role` values fetched from the live test database, asserting `staff` fails and `super_admin` passes the same boolean check `requireParticipantCareStaffCaller` performs.
- `updateGuardianInfoForCaller` itself: direct-call test (same style as the existing `updateHealthInfoForCaller` tests in `participant-care-live.test.ts`) verifying it writes `guardian_name`/`guardian_phone` onto the right `applications` row and calls `writeAuditLog`.
- Component/page test (or manual verification, matching this session's established pattern for small UI additions): guardian card only renders for `under_18` applications, never for others, and never when both guardian fields are empty.
