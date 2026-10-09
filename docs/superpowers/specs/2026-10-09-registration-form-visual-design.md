# Self-Registration Form — Visual Design

Date: 2026-10-09

## Context

The participant self-registration form (`src/app/[locale]/(participant)/(bare)/register/`) was built as part of an earlier sub-project of the COY21 platform. It is functionally complete — 3-step flow, autosave per step, Zod validation (`src/lib/validation/registration.ts`), Server Action submission (`submitApplication`) — but was never given a visual design pass: every field renders as a bare, unstyled HTML `<input>`/`<select>`/`<textarea>`/`<button>` with no layout, spacing, or visual hierarchy.

This gap was found live, 2026-10-09, during a production walkthrough: the form was confirmed genuinely unusable — fields visually run together with no clear boundaries, a user could not tell which field needed filling to enable "Next."

Participant import is the primary onboarding path for the real conference; this form is a secondary/fallback path (someone registering themselves, not pre-imported by staff). It was deliberately deprioritized for the initial launch push but is now being addressed directly.

## Goal

Give the existing, working form logic a real visual design, matching the rest of the platform's established look (the admin dashboard, Settings, Announcements pages already confirmed working well in production). No logic changes, no new fields, no step restructuring, no i18n — English-only, exactly as it is today.

## Scope

**In scope:**
- Visual layout and styling of all 3 existing steps.
- A step-progress indicator (replacing the current plain "Step 1 of 3" text).
- Styled inputs, selects, textareas, checkbox groups, buttons, error messages — using this codebase's existing `Button` component and the same input-styling convention already used elsewhere in the admin surface (`inputClass` pattern from `person-manager.tsx` and similar admin forms). (No `Card` component is used here — see Layout section: the surrounding `(bare)` layout already supplies an equivalent bordered box.)
- Required-field markers.
- Mobile-responsive layout.

**Explicitly out of scope:**
- Arabic translation / i18n (confirmed with the user: English-only, deliberately, not a phase-1 gap).
- Any change to `registration-form-steps.ts`'s step-gating logic, `registration.ts`'s Zod schema, the autosave mechanism, or `actions.ts`'s `submitApplication` Server Action.
- Adding, removing, or reordering any field.
- Changing the 3-step structure (confirmed with the user: keep 3 steps, not collapsed to one page).

## Design

### Layout

**Correction from spec review:** `(participant)/(bare)/layout.tsx` (unchanged by this work) already renders the centered column, the COY21 logo, and a bordered/shadowed white box wrapping `{children}` (`w-full max-w-md rounded-lg border border-charcoal/10 bg-white p-6 shadow-sm`). This box already functions as the form's outer card. `registration-form.tsx` must render its content **directly** into that existing box — it must NOT wrap itself in a second `<Card>`, which would double-box the form (two nested borders/shadows). The layout's `max-w-md` is the real width constraint; there is no `max-w-xl` override to apply. This keeps the Non-goals promise of "no change to the `(bare)` layout chrome" literally true — the layout file is not touched at all.

Inside that existing box, `registration-form.tsx` renders, top to bottom:
1. The step-progress indicator.
2. The step's heading (new — e.g. "Personal Information", "Your Interests", "Tell Us More" — one short, human title per step, not present in the current unstyled version). Hardcoded English text, like all other new copy on this page (see "Copy" note at the end of this section).
3. The step's fields.
4. The step's action buttons (Back / Next / Submit / Skip), right-aligned or full-width depending on step (Step 1 has no Back).

### Step-progress indicator

Three numbered circles connected by a horizontal line, replacing the current `{t('stepProgress', { step, total: 3 })}` plain text visually. That i18n key and its call site stay in the code, but move to an `sr-only` span — the circles are now the visible, visual indicator; the existing translated text becomes the accessible-only equivalent read by screen readers, rather than rendering twice (once as visible text, once as circles) or being dropped entirely. This is a firm decision, not left to implementation judgment.

- Completed step: turquoise-filled circle with a checkmark.
- Current step: turquoise-outlined circle with the step number, bold.
- Upcoming step: charcoal/20-outlined circle with the step number, muted.
- Connecting line between circles: turquoise for the completed portion, charcoal/20 for the rest.

### Fields

Every field gets:
- A `<label>` above the input (not a bare `placeholder` as the only text, which disappears once the user starts typing — the current version relies entirely on placeholders for some fields).
- A red `*` immediately after the label text for required fields (derived directly from `registrationSchema` — `phone`, `country`, `nationality`, `city`, `field_of_work`, `preferred_language` always required in Step 1 (`birth_date`/`age_group` -- at least one required, handled as described below); `interests` (non-empty array) and `experience_level`/`participation_goals` required in Step 2; nothing required in Step 3).
- Consistent spacing between fields (vertical rhythm via a `flex flex-col gap-4` or similar wrapper, not ad-hoc).

Inputs/selects/textareas reuse the established `inputClass` string (`rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100`) already used by `person-manager.tsx` and sibling admin forms, so this page is visually indistinguishable in input styling from the rest of the platform.

In Step 1's two-column grid (`grid grid-cols-1 gap-3 sm:grid-cols-2`, matching `person-manager.tsx`'s exact pattern), pair `country`+`nationality` and `city`+`field_of_work`. Every other Step 1 field (`phone`, the `birth_date`/`age_group` pair, `preferred_language`) renders full-width, one per row — not paired with anything.

Checkbox groups (`interests` in Step 2, `track_interests` in Step 3) render as a responsive grid of small toggle-able cards (border + background change on check, using `turquoise`/`charcoal` tokens) rather than a plain vertical list of native checkboxes — clearer on both desktop and mobile, and matches the "selectable chip" pattern already familiar from `Badge`-style UI elsewhere in the app, without requiring a new shared component (implemented inline in this file, since this is the only place this exact pattern is needed right now). The real `<input type="checkbox">` that `{...register('interests')}`/`{...register('track_interests')}` binds to stays in the DOM, visually hidden (e.g. `sr-only` or `appearance-none` positioned under the card), with the card itself acting as its `<label>` — react-hook-form's registration, change handling, and `watchedValues`-driven validation must keep working exactly as today; only the checkbox's visual presentation changes, not its presence or binding. Grid breakpoints: 1 column on mobile, 2 columns at `sm:`, 3 columns at `md:` and above — consistent with the rest of this spec's mobile-first approach.

Error messages (`errors.<field>.message`) render in red text directly below their field, not styled as plain paragraphs floating in the layout.

The `birth_date`/`age_group` "at least one required" rule (enforced by `personalInfoSchema`'s `.refine`, attached to the `birth_date` path) is explained with a short helper line under those two fields — e.g. "Provide either your birth date or an age range" — so the requirement is visible before a user hits the validation error, not only after.

### Buttons

- `Next` / `Submit Application`: `Button` component, `variant="primary"`.
- `Back`: `Button` component, `variant="secondary"`.
- `Skip` (Step 3 only): `Button` component, `variant="ghost"`.
- Disabled state (Next, when `isStepValid` is false) uses the `Button` component's existing `disabled` styling (already visually distinct — opacity + no pointer events — no new disabled treatment needed).
- Submit error (`submitError`) renders as a visible alert banner above the buttons (red-toned, `role="alert"` already present in the code — just needs visual treatment), not a bare paragraph.
- **Important implementation detail (found during spec review):** `Button` defaults to `type="button"` internally. The current Step 3 submit control is a raw `<button type="submit">` inside `<form onSubmit={handleSubmit(onSubmit)}>` — when it's swapped for `<Button variant="primary">`, `type="submit"` must be passed explicitly, or the form will silently stop submitting on click (the click would no longer trigger `handleSubmit`).

### Copy

All new text introduced by this redesign — step headings ("Personal Information", etc.), the `birth_date`/`age_group` helper line, any other new label/hint text — is hardcoded English, exactly like the rest of this page's existing copy (placeholders, labels, button text), none of which goes through `next-intl`'s `t()` today except the single `register.stepProgress` key. Do not add new keys to `messages/en.json` or `messages/ar.json` for this work — that would be i18n work, explicitly out of scope per this spec's Non-goals.

### Responsive behavior

- Single-column field layout on mobile (default).
- Two-column grid for naturally paired short fields on larger screens where it reads cleanly (e.g. `country` + `nationality`, `city` + `field_of_work`) — using the same `grid grid-cols-1 sm:grid-cols-2` pattern already used in `person-manager.tsx`'s own form, for consistency.
- Checkbox-card grids similarly collapse to fewer columns on narrow viewports.

### Non-goals (explicit)

- No Arabic/i18n.
- No new validation rules.
- No change to what data is collected or how it's persisted.
- No change to the `(bare)` layout chrome around this form.

## Testing

This is a pure visual/markup change to an already-logic-tested component (`registration-form-steps.ts` has its own existing unit tests, unchanged). No new automated test is expected to be meaningful here beyond confirming the component still renders and existing tests still pass — this will be verified by running the existing test suite and a manual visual check (screenshot or live walkthrough) described as a Testing Requirement in the implementation plan, consistent with this project's standing practice of being explicit about what was/wasn't browser-verified.
