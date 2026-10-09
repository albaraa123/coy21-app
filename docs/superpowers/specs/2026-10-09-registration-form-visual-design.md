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
- Styled inputs, selects, textareas, checkbox groups, buttons, error messages — using this codebase's existing design-system primitives (`Card`, `Button`) and the same input-styling convention already used elsewhere in the admin surface (`inputClass` pattern from `person-manager.tsx` and similar admin forms).
- Required-field markers.
- Mobile-responsive layout.

**Explicitly out of scope:**
- Arabic translation / i18n (confirmed with the user: English-only, deliberately, not a phase-1 gap).
- Any change to `registration-form-steps.ts`'s step-gating logic, `registration.ts`'s Zod schema, the autosave mechanism, or `actions.ts`'s `submitApplication` Server Action.
- Adding, removing, or reordering any field.
- Changing the 3-step structure (confirmed with the user: keep 3 steps, not collapsed to one page).

## Design

### Layout

A single centered column (`max-w-xl` or similar, consistent with other single-form admin pages in this codebase), vertically centered within the page, on the existing `warm-white` background `(bare)` layout already provides (no site chrome/sidebar on this route — confirmed via `(participant)/(bare)/layout.tsx`, unchanged).

The COY21 logo (already rendered above the form per the current `page.tsx`/layout, unchanged) sits above a single `Card` containing:
1. The step-progress indicator.
2. The step's heading (new — e.g. "Personal Information", "Your Interests", "Tell Us More" — one short, human title per step, not present in the current unstyled version).
3. The step's fields.
4. The step's action buttons (Back / Next / Submit / Skip), right-aligned or full-width depending on step (Step 1 has no Back).

### Step-progress indicator

Three numbered circles connected by a horizontal line, replacing the current `{t('stepProgress', { step, total: 3 })}` plain text (that i18n key and its call site stay — the indicator renders *in addition to*, or restyles, not removes, the semantic step/total info already available to screen readers via the existing text, which can move to an `sr-only` span if visually redundant once circles are added).

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

Checkbox groups (`interests` in Step 2, `track_interests` in Step 3) render as a responsive grid of small toggle-able cards (border + background change on check, using `turquoise`/`charcoal` tokens) rather than a plain vertical list of native checkboxes — clearer on both desktop and mobile, and matches the "selectable chip" pattern already familiar from `Badge`-style UI elsewhere in the app, without requiring a new shared component (implemented inline in this file, since this is the only place this exact pattern is needed right now).

Error messages (`errors.<field>.message`) render in red text directly below their field, not styled as plain paragraphs floating in the layout.

The `birth_date`/`age_group` "at least one required" rule (enforced by `personalInfoSchema`'s `.refine`, attached to the `birth_date` path) is explained with a short helper line under those two fields — e.g. "Provide either your birth date or an age range" — so the requirement is visible before a user hits the validation error, not only after.

### Buttons

- `Next` / `Submit Application`: `Button` component, `variant="primary"`.
- `Back`: `Button` component, `variant="secondary"`.
- `Skip` (Step 3 only): `Button` component, `variant="ghost"`.
- Disabled state (Next, when `isStepValid` is false) uses the `Button` component's existing `disabled` styling (already visually distinct — opacity + no pointer events — no new disabled treatment needed).
- Submit error (`submitError`) renders as a visible alert banner above the buttons (red-toned, `role="alert"` already present in the code — just needs visual treatment), not a bare paragraph.

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
