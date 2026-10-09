# Registration Form Visual Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing, functionally-complete self-registration form a real visual design (layout, spacing, step-progress circles, styled inputs/buttons/checkbox-cards) with zero changes to its logic, validation, or data flow.

**Architecture:** This is a single-file visual restyle. All work happens in `registration-form.tsx`, reusing the platform's existing `Button` component and the `inputClass` styling convention already established in `person-manager.tsx` and sibling admin forms. The surrounding `(bare)/layout.tsx` already supplies the bordered white box this form renders into — it is not touched. No new shared components are created; the checkbox-card pattern is implemented inline since this is the only place it's currently needed. No test framework for interactive DOM exists in this repo, so verification is: existing automated tests still pass + a manual/live visual walkthrough (explicitly called out as a Testing Requirement below, consistent with this project's practice of being explicit about what was/wasn't browser-verified).

**Tech Stack:** Next.js (App Router), React, react-hook-form + zodResolver, Tailwind CSS, TypeScript. No new dependencies.

---

## Context for the implementer

Read these first — they're short and everything in this plan depends on exact details from them:

- **Spec:** `docs/superpowers/specs/2026-10-09-registration-form-visual-design.md` — the full design, already approved and reviewed twice. This plan implements it; if anything here seems to contradict the spec, the spec wins and you should flag it rather than silently picking one.
- **Target file:** `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx` (244 lines) — the entire file is being restyled. Read it in full before starting; its exact current content is reproduced inline in Task 1-4 below only where needed for diffs, not in full.
- **Validation schema:** `src/lib/validation/registration.ts` — defines which fields are required (used to derive the `*` markers).
- **Step logic (unchanged):** `src/app/[locale]/(participant)/(bare)/register/registration-form-steps.ts` — `STEP_1_FIELDS`, `STEP_2_FIELDS`, `STEP_3_FIELDS`, `isStepValid`. Do not modify this file.
- **Layout (unchanged, do not touch):** `src/app/[locale]/(participant)/(bare)/layout.tsx` — already renders the centered column, logo, and the bordered/shadowed white box (`w-full max-w-md rounded-lg border border-charcoal/10 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900`) that `registration-form.tsx`'s output renders into as `{children}`. Do **not** wrap the form in a second `Card` — that would double-box it.
- **Button component:** `src/components/ui/button.tsx` — `variant` is `'primary' | 'secondary' | 'ghost' | 'destructive'`. **Important:** its native-button render branch hardcodes `type="button"` and then spreads `{...rest}` after it — so passing `type="submit"` explicitly through props DOES correctly override the default (verified by reading the source: `rest` spreads after the hardcoded attribute in JSX attribute order, so the later one wins). You must still pass `type="submit"` explicitly on the Step 3 submit button, or the default `"button"` applies and the form will not submit on click.
- **`inputClass` convention** (from `person-manager.tsx:82-83`): `'rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'`
- **Two-column grid convention** (from `person-manager.tsx:292`): `grid grid-cols-1 gap-3 sm:grid-cols-2`
- **No test framework for interactive DOM exists in this repo** (confirmed: no `@testing-library/react` usage anywhere in `tests/`). Do not introduce one. Verification for this plan is: (a) full existing test suite stays green, (b) a manual/live walkthrough of all 3 steps on `npm run dev`, confirmed and reported explicitly.

## File Structure

- **Modify:** `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx` — the only file whose logic/markup changes. Everything below happens here.
- **No new files.** The checkbox-card visual pattern and the step-progress circles are implemented directly inside this component (per spec: "implemented inline in this file, since this is the only place this exact pattern is needed right now").
- **No changes to:** `registration-form-steps.ts`, `registration.ts` (schema), `actions.ts`, `layout.tsx`, `messages/en.json`, `messages/ar.json`.

Because the whole file is being restyled in place, this plan breaks the work into ordered tasks by **step** (the natural seams in the existing code), plus one task each for the shared progress-indicator and a final whole-file polish/verification pass. Each task leaves the file in a working, renderable state.

---

### Task 1: Step-progress indicator (circles) + shared helper

**Files:**
- Modify: `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx:118` (the `progressIndicator` line, and everything that references it)

This replaces the single `const progressIndicator = <p>{t('stepProgress', { step, total: 3 })}</p>;` line with a real 3-circle visual indicator, per spec section "Step-progress indicator." The existing `t('stepProgress', ...)` call and its i18n key **stay in the code** — they move to an `sr-only` span rather than being dropped (this is a firm decision from the spec, not a judgment call).

- [ ] **Step 1: Replace the `progressIndicator` constant**

Replace:
```tsx
const progressIndicator = <p>{t('stepProgress', { step, total: 3 })}</p>;
```

With:
```tsx
const STEPS = [1, 2, 3] as const;

const progressIndicator = (
  <div className="mb-6">
    <span className="sr-only">{t('stepProgress', { step, total: 3 })}</span>
    <div className="flex items-center" aria-hidden="true">
      {STEPS.map((s, i) => (
        <div key={s} className="flex flex-1 items-center last:flex-none">
          <div
            className={
              s < step
                ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-turquoise text-white'
                : s === step
                ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-turquoise font-bold text-turquoise'
                : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-charcoal/20 text-charcoal/40 dark:border-gray-700 dark:text-gray-500'
            }
          >
            {s < step ? (
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path
                  fillRule="evenodd"
                  d="M16.704 5.29a1 1 0 010 1.415l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 111.414-1.415L8.5 12.085l6.79-6.79a1 1 0 011.414-.004z"
                  clipRule="evenodd"
                />
              </svg>
            ) : (
              s
            )}
          </div>
          {s !== 3 && (
            <div
              className={
                s < step
                  ? 'h-0.5 flex-1 bg-turquoise'
                  : 'h-0.5 flex-1 bg-charcoal/20 dark:bg-gray-700'
              }
            />
          )}
        </div>
      ))}
    </div>
  </div>
);
```

Note: `STEPS` and `progressIndicator` are both recomputed on every render (they already were, as a plain `const` inside the component body) — this is unchanged behavior, just more markup.

- [ ] **Step 2: Verify it renders without error**

Run: `npm run dev` (if not already running), navigate to `/en/register` (requires a logged-in participant account with a draft application — use `albaraak2002@gmail.com`, which already has a `draft`-status application row per the pre-launch checklist).

Expected: page loads, step 1 of 3 shows a filled/outlined circle for step 1 (outlined, since it's current) and two muted circles for steps 2/3, connected by lines. No console errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/\[locale\]/\(participant\)/\(bare\)/register/registration-form.tsx
git commit -m "feat: add visual step-progress circles to registration form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Step 1 (Personal Information) — layout, labels, required markers

**Files:**
- Modify: `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx` (the `if (step === 1) { ... }` block, currently lines 120-158)

Per spec: add a step heading, wrap in `flex flex-col gap-4`, add real `<label>`s (not placeholder-only), red `*` for required fields, two-column pairing for `country`+`nationality` and `city`+`field_of_work`, everything else full-width, a helper line under `birth_date`/`age_group`, styled `Button` for Next, error messages styled in red.

Required fields in Step 1 (from `personalInfoSchema`): `phone`, `country`, `nationality`, `city`, `field_of_work`, `preferred_language` are always required. `birth_date`/`age_group` require *at least one* (handled via the helper line, not a `*` on either — neither field alone is strictly required).

- [ ] **Step 1: Add the `Button` import**

At the top of the file, alongside the other imports:
```tsx
import { Button } from '@/components/ui/button';
```

- [ ] **Step 2: Replace the Step 1 render block**

Replace the entire `if (step === 1) { return ( ... ); }` block with:

```tsx
if (step === 1) {
  return (
    <div className="flex flex-col gap-4">
      {progressIndicator}
      <h2 className="text-lg font-semibold text-charcoal dark:text-gray-100">Personal Information</h2>

      <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
        Phone <span className="text-red-600">*</span>
        <input
          {...register('phone')}
          placeholder="Phone"
          onBlur={() => autosaveStep(STEP_1_FIELDS)}
          className={inputClass}
        />
        {errors.phone && <p className="text-sm text-red-600">{errors.phone.message}</p>}
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          Country <span className="text-red-600">*</span>
          <input
            {...register('country')}
            placeholder="Country"
            onBlur={() => autosaveStep(STEP_1_FIELDS)}
            className={inputClass}
          />
          {errors.country && <p className="text-sm text-red-600">{errors.country.message}</p>}
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          Nationality <span className="text-red-600">*</span>
          <input
            {...register('nationality')}
            placeholder="Nationality"
            onBlur={() => autosaveStep(STEP_1_FIELDS)}
            className={inputClass}
          />
          {errors.nationality && <p className="text-sm text-red-600">{errors.nationality.message}</p>}
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          Birth date
          <input
            {...register('birth_date')}
            type="date"
            onBlur={() => autosaveStep(STEP_1_FIELDS)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          Age group
          <select {...register('age_group')} onBlur={() => autosaveStep(STEP_1_FIELDS)} className={inputClass}>
            <option value="">Age group</option>
            {AGE_GROUP_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <p className="text-xs text-charcoal/60 dark:text-gray-400">Provide either your birth date or an age range.</p>
        {errors.birth_date && <p className="text-sm text-red-600">{errors.birth_date.message}</p>}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          City <span className="text-red-600">*</span>
          <input
            {...register('city')}
            placeholder="City"
            onBlur={() => autosaveStep(STEP_1_FIELDS)}
            className={inputClass}
          />
          {errors.city && <p className="text-sm text-red-600">{errors.city.message}</p>}
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          Field of work <span className="text-red-600">*</span>
          <input
            {...register('field_of_work')}
            placeholder="Field of work"
            onBlur={() => autosaveStep(STEP_1_FIELDS)}
            className={inputClass}
          />
          {errors.field_of_work && <p className="text-sm text-red-600">{errors.field_of_work.message}</p>}
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
        Preferred language <span className="text-red-600">*</span>
        <select {...register('preferred_language')} onBlur={() => autosaveStep(STEP_1_FIELDS)} className={inputClass}>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
      </label>

      <div className="flex justify-end">
        <Button
          type="button"
          disabled={!isStepValid(1, watchedValues)}
          onClick={() => {
            void autosaveStep(STEP_1_FIELDS);
            setStep(2);
          }}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the `inputClass` constant**

Add near the top of the file, after the existing `const AGE_GROUP_OPTIONS = ...` line:
```tsx
const inputClass =
  'rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';
```

- [ ] **Step 4: Verify Step 1 renders and behaves correctly**

Run: `npm run dev`, navigate to `/en/register`.

Expected: Step 1 shows labeled fields with red asterisks on required ones, `country`/`nationality` side-by-side on desktop width (stacked on narrow/mobile width — resize to verify), the birth-date/age-group helper text visible, "Next" disabled until required fields are filled, then enabled. No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/\[locale\]/\(participant\)/\(bare\)/register/registration-form.tsx
git commit -m "feat: style registration form step 1 (personal information)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Checkbox-card helper + Step 2 (Your Interests)

**Files:**
- Modify: `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx` (the `if (step === 2) { ... }` block, currently lines 160-201)

Per spec: checkbox groups render as a responsive grid of toggle-able cards (1 col mobile, 2 at `sm:`, 3 at `md:`+), with the real `<input type="checkbox">` still present (visually hidden) and still bound via `{...register('interests')}` — react-hook-form's registration and `watchedValues`-driven validation must keep working unchanged.

This task introduces one small inline helper component, `CheckboxCard`, used by both Step 2 (`interests`) and Step 3 (`track_interests`) — defined once, used twice, to avoid duplicating the card markup (DRY), but kept in this same file per the spec's explicit instruction not to create a new shared component for this.

- [ ] **Step 1: Add the `CheckboxCard` helper component**

Add this near the top of the file, after the `AGE_GROUP_OPTIONS`/`inputClass` constants and before the main `RegistrationForm` function:

```tsx
function CheckboxCard({
  option,
  checked,
  registerProps,
  onBlur,
}: {
  option: string;
  checked: boolean;
  registerProps: ReturnType<ReturnType<typeof useForm<FormValues>>['register']>;
  onBlur: () => void;
}) {
  return (
    <label
      className={
        checked
          ? 'flex cursor-pointer items-center justify-center rounded-md border border-turquoise bg-turquoise/10 px-3 py-2 text-center text-sm font-medium text-turquoise'
          : 'flex cursor-pointer items-center justify-center rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-center text-sm text-charcoal hover:border-charcoal/40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
      }
    >
      <input
        type="checkbox"
        value={option}
        className="sr-only"
        {...registerProps}
        onBlur={onBlur}
      />
      {option}
    </label>
  );
}
```

Note: this needs `FormValues` to be in scope — it already is, imported/derived at the top of `registration-form.tsx` (`type FormValues = z.infer<typeof registrationSchema>;`). `useForm` needs to be imported, which it already is.

- [ ] **Step 2: Replace the Step 2 render block**

Replace the entire `if (step === 2) { return ( ... ); }` block with:

```tsx
if (step === 2) {
  return (
    <div className="flex flex-col gap-4">
      {progressIndicator}
      <h2 className="text-lg font-semibold text-charcoal dark:text-gray-100">Your Interests</h2>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm text-charcoal dark:text-gray-100">
          Interests (select at least one) <span className="text-red-600">*</span>
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
          {INTEREST_OPTIONS.map((option) => (
            <CheckboxCard
              key={option}
              option={option}
              checked={(watchedValues.interests ?? []).includes(option)}
              registerProps={register('interests')}
              onBlur={() => autosaveStep(STEP_2_FIELDS)}
            />
          ))}
        </div>
        {errors.interests && <p className="text-sm text-red-600">{errors.interests.message}</p>}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
        Experience level <span className="text-red-600">*</span>
        <select {...register('experience_level')} onBlur={() => autosaveStep(STEP_2_FIELDS)} className={inputClass}>
          <option value="none">None</option>
          <option value="beginner">Beginner</option>
          <option value="intermediate">Intermediate</option>
          <option value="expert">Expert</option>
        </select>
        {errors.experience_level && <p className="text-sm text-red-600">{errors.experience_level.message}</p>}
      </label>

      <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
        Participation goals <span className="text-red-600">*</span>
        <textarea
          {...register('participation_goals')}
          placeholder="Participation goals"
          onBlur={() => autosaveStep(STEP_2_FIELDS)}
          className={inputClass}
        />
        {errors.participation_goals && <p className="text-sm text-red-600">{errors.participation_goals.message}</p>}
      </label>

      <div className="flex justify-between">
        <Button type="button" variant="secondary" onClick={() => setStep(1)}>Back</Button>
        <Button
          type="button"
          disabled={!isStepValid(2, watchedValues)}
          onClick={() => {
            void autosaveStep(STEP_2_FIELDS);
            setStep(3);
          }}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify Step 2 renders and behaves correctly**

Run: `npm run dev`, navigate through Step 1 → Step 2.

Expected: interest options render as a grid of cards (3 columns on a wide desktop window, 2 on tablet-width, 1 on mobile-width — resize to verify each), clicking a card toggles its visual checked state (turquoise border/background) and actually updates form state (confirm "Next" becomes enabled only once at least one is checked, matching `isStepValid(2, ...)`), "Back" returns to Step 1 with previously-entered data intact (autosave).

- [ ] **Step 4: Commit**

```bash
git add src/app/\[locale\]/\(participant\)/\(bare\)/register/registration-form.tsx
git commit -m "feat: style registration form step 2 (interests) with checkbox cards

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Step 3 (Tell Us More) — layout, Skip/Submit buttons, submit-type fix

**Files:**
- Modify: `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx` (the final `return (<form>...)` block, currently lines 203-243)

Per spec: no required fields in Step 3 (all optional), reuse `CheckboxCard` for `track_interests`, style the submit-error alert banner, and — critically — pass `type="submit"` explicitly to the `Button` used for "Submit Application" (see the Button-default note in the Context section above).

- [ ] **Step 1: Replace the Step 3 render block**

Replace the final `return (<form onSubmit={handleSubmit(onSubmit)}> ... </form>);` block with:

```tsx
return (
  <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
    {progressIndicator}
    <h2 className="text-lg font-semibold text-charcoal dark:text-gray-100">Tell Us More</h2>

    <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
      Organization
      <input
        {...register('organization')}
        placeholder="Organization"
        onBlur={() => autosaveStep(STEP_3_FIELDS)}
        className={inputClass}
      />
    </label>

    <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
      Climate experience
      <textarea
        {...register('climate_experience')}
        placeholder="Climate experience"
        onBlur={() => autosaveStep(STEP_3_FIELDS)}
        className={inputClass}
      />
    </label>

    <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
      Past initiatives
      <textarea
        {...register('past_initiatives')}
        placeholder="Past initiatives"
        onBlur={() => autosaveStep(STEP_3_FIELDS)}
        className={inputClass}
      />
    </label>

    <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
      Topics to learn
      <textarea
        {...register('topics_to_learn')}
        placeholder="Topics to learn"
        onBlur={() => autosaveStep(STEP_3_FIELDS)}
        className={inputClass}
      />
    </label>

    <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
      Content type preference
      <input
        {...register('content_type_pref')}
        placeholder="Content type preference"
        onBlur={() => autosaveStep(STEP_3_FIELDS)}
        className={inputClass}
      />
    </label>

    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm text-charcoal dark:text-gray-100">Track interests</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
        {TRACK_OPTIONS.map((option) => (
          <CheckboxCard
            key={option}
            option={option}
            checked={(watchedValues.track_interests ?? []).includes(option)}
            registerProps={register('track_interests')}
            onBlur={() => autosaveStep(STEP_3_FIELDS)}
          />
        ))}
      </div>
    </fieldset>

    <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
      Priority sessions
      <textarea
        {...register('priority_sessions')}
        placeholder="Priority sessions"
        onBlur={() => autosaveStep(STEP_3_FIELDS)}
        className={inputClass}
      />
    </label>

    <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
      Special needs
      <textarea
        {...register('special_needs')}
        placeholder="Special needs"
        onBlur={() => autosaveStep(STEP_3_FIELDS)}
        className={inputClass}
      />
    </label>

    {submitError && (
      <p role="alert" className="rounded-md border border-red-600 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
        {submitError}
      </p>
    )}

    <div className="flex items-center justify-between">
      <Button type="button" variant="secondary" onClick={() => setStep(2)}>Back</Button>
      <div className="flex gap-2">
        {/*
          Skip intentionally does NOT go through handleSubmit(onSubmit): handleSubmit
          re-validates the full registrationSchema (all step-1/2 required fields), which
          would make Skip functionally identical to Submit and — if validation somehow
          failed here — silently do nothing (handleSubmit only invokes its callback on
          success, and step 3 renders no error messages for step-1/2 fields). Skip calls
          finalizeSubmission directly so it genuinely bypasses that gate, trusting that
          step 1/2 are already valid by construction (enforced by the Next buttons'
          isStepValid checks), while still submitting via the same autosave + submitApplication
          path as Submit.
        */}
        <Button type="button" variant="ghost" disabled={submitting} onClick={() => void finalizeSubmission()}>
          Skip
        </Button>
        <Button type="submit" disabled={submitting}>Submit Application</Button>
      </div>
    </div>
  </form>
);
```

- [ ] **Step 2: Verify Step 3 renders and submits correctly**

Run: `npm run dev`, navigate through all 3 steps to Step 3, fill in at least nothing (all optional) and click "Submit Application".

Expected: the button actually submits (this is the critical check — confirms the `type="submit"` override works as documented) and the app navigates to `/my-application`. Separately, test "Skip" on a fresh draft (if available) and confirm it also finalizes correctly. Confirm the submit-error banner renders with red/alert styling if you can trigger a failure case (e.g. temporarily disconnect network, or just visually inspect the JSX — functional trigger is optional if impractical).

- [ ] **Step 3: Commit**

```bash
git add src/app/\[locale\]/\(participant\)/\(bare\)/register/registration-form.tsx
git commit -m "feat: style registration form step 3 (tell us more) and submit/skip buttons

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full existing test suite**

Run: `npm test` (or the project's exact test command — check `package.json`'s `scripts.test` if unsure)

Expected: all tests that passed before this work still pass (this is a pure visual change to a component with no existing render tests — `registration-form-steps.ts`'s own tests, and everything else, should be completely unaffected). If anything fails, it indicates an accidental logic change — stop and investigate before proceeding.

- [ ] **Step 2: Run the linter/typechecker**

Run: `npm run lint` and `npm run build` (or `tsc --noEmit` if a faster typecheck-only command exists — check `package.json`)

Expected: no new errors. The `CheckboxCard` helper's `registerProps` type (`ReturnType<ReturnType<typeof useForm<FormValues>>['register']>`) is slightly unusual — if TypeScript complains about it, the simplest fix is to inline the type from `react-hook-form`'s own `UseFormRegisterReturn<...>` export instead; check what's actually available before spending more than one attempt on this.

- [ ] **Step 3: Full manual walkthrough on a real draft**

Using `npm run dev`, log in as `albaraak2002@gmail.com` (has an existing `draft`-status application per the pre-launch checklist) and walk through all 3 steps end-to-end:
- Step 1: verify labels, required asterisks, two-column pairing collapses to one column on mobile width, birth-date/age-group helper text, Next disabled→enabled transition.
- Step 2: verify checkbox cards render, toggle correctly, responsive column counts (1/2/3) at different widths, Back preserves Step 1 data.
- Step 3: verify all fields render, Back preserves Step 2 data, Submit actually submits (type="submit" fix), Skip also works independently (if a second draft is available to test it without re-using the already-submitted one from the Submit test).
- Check dark mode if the platform supports a dark-mode toggle (classes include `dark:` variants throughout — confirm they're not broken).

Report the walkthrough result explicitly (what was and wasn't visually/functionally verified), per this project's standing practice.

- [ ] **Step 4: Update the pre-launch checklist**

Modify `docs/pre-launch-checklist.md`'s existing self-registration-form bullet (currently reads "**Self-registration form (`/register`) is functionally complete but has zero visual styling**...") to reflect that the visual design is now complete, dated 2026-10-09, referencing this plan/spec.

- [ ] **Step 5: Commit**

```bash
git add docs/pre-launch-checklist.md
git commit -m "docs: mark registration form visual design complete in pre-launch checklist

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## After all tasks

Once all 5 tasks are complete and verified, use **superpowers:finishing-a-development-branch** to merge `feature/registration-form-design` back and clean up the worktree.
