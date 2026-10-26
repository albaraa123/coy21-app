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
  else if birth_date is not null: age computed from birth_date < 18
  else: false (never both null per registrationSchema's .refine)
```

A small shared helper, `isApplicationMinor(application: { age_group: string | null; birth_date: string | null }): boolean`, added to `src/lib/participants/` (new file `minor.ts`), used identically by both the admin page and the My Profile page so the under-18 rule can't drift between the two surfaces.

## UI

**Admin — `src/app/[locale]/(admin)/participants/[applicationId]/page.tsx`:**
- New section/component `GuardianControls` (mirrors `ClassificationControls`'s shape: client component, local state, `run()` wrapper, `window.location.reload()` on success), rendered only when `isApplicationMinor(application)` is true.
- Two inputs: name (plain text), phone (reuse the `PhoneField`/`react-phone-number-input` pattern already shipped on My Profile for consistency — single E.164 string).
- New Server Action `updateGuardianInfoAction(applicationId, { guardianName, guardianPhone })` in `actions.ts`, following the existing `*ForCaller` / plain-wrapper split, using `requireParticipantCareStaffCaller`, with a `writeAuditLog` call (`action: 'guardian_info_updated'`).

**Participant — `src/app/[locale]/(participant)/(shell)/my-profile/page.tsx`:**
- New read-only card "Guardian / Companion", rendered only when `isApplicationMinor(application)` is true AND at least one of `guardian_name`/`guardian_phone` is set (don't show an empty card to a minor whose guardian info hasn't been entered yet).
- No new form component — plain display, no edit affordance (team is the source of truth).

## Testing

- Unit test for `isApplicationMinor` covering: `age_group = 'under_18'`, `age_group` = any other bucket, `age_group` null + `birth_date` under/over 18 years ago, both null (defensive — should not occur given the registration schema's refine, but the helper must not throw).
- Server action test: `super_admin` can write guardian info; plain `staff` is rejected (`Not authorized`), matching the existing pattern in `*ForCaller` tests for sibling actions in this file.
- Component/page test (or manual verification, matching this session's established pattern for small UI additions): guardian card only renders for `under_18` applications, never for others, and never when both guardian fields are empty.
