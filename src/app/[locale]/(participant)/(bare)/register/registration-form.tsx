'use client';

import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { registrationSchema } from '@/lib/validation/registration';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from '@/i18n/routing';
import { submitApplication } from './actions';
import { STEP_1_FIELDS, STEP_2_FIELDS, STEP_3_FIELDS, isStepValid } from './registration-form-steps';
import type { Tables, TablesUpdate } from '@/types/database';

type ApplicationDraft = Tables<'applications'>;

// Derived directly from the schema (rather than hand-duplicated) so the form's
// types can never drift from registrationSchema's field domains — e.g. age_group
// is a specific enum union in the schema, not a bare `string`.
type FormValues = z.infer<typeof registrationSchema>;

const INTEREST_OPTIONS = ['policy', 'technology', 'media', 'community', 'finance'] as const;
const TRACK_OPTIONS = ['policy', 'technology', 'media', 'community', 'finance'] as const;

const AGE_GROUP_OPTIONS = ['under_18', '18_24', '25_34', '35_44', '45_plus'] as const;

const inputClass =
  'rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

// The DB row models "not yet filled in" as `null` for nullable columns, while the
// form schema models the same absence as `undefined` (via zod `.optional()`). Convert
// at the boundary so a fresh/partial draft row can populate react-hook-form's
// defaultValues without a type (or runtime) mismatch between the two representations.
function draftToDefaultValues(draft: ApplicationDraft): Partial<FormValues> {
  return {
    phone: draft.phone ?? undefined,
    country: draft.country ?? undefined,
    nationality: draft.nationality ?? undefined,
    birth_date: draft.birth_date ?? undefined,
    age_group: (draft.age_group as FormValues['age_group']) ?? undefined,
    city: draft.city ?? undefined,
    organization: draft.organization ?? undefined,
    field_of_work: draft.field_of_work ?? undefined,
    preferred_language: (draft.preferred_language as FormValues['preferred_language']) ?? undefined,
    // A fresh draft row has interests/track_interests as `null` (no DB default), not `[]`.
    // react-hook-form's checkbox-array collection needs an array default to behave correctly,
    // so normalize both array fields here regardless of what the draft row contains.
    interests: draft.interests ?? [],
    climate_experience: draft.climate_experience ?? undefined,
    experience_level: (draft.experience_level as FormValues['experience_level']) ?? undefined,
    past_initiatives: draft.past_initiatives ?? undefined,
    participation_goals: draft.participation_goals ?? undefined,
    topics_to_learn: draft.topics_to_learn ?? undefined,
    content_type_pref: draft.content_type_pref ?? undefined,
    track_interests: draft.track_interests ?? [],
    priority_sessions: draft.priority_sessions ?? undefined,
    special_needs: draft.special_needs ?? undefined,
  };
}

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
          ? 'flex cursor-pointer items-center justify-center rounded-md border border-turquoise bg-turquoise/10 px-3 py-2 text-center text-sm font-medium text-turquoise focus-within:ring-2 focus-within:ring-turquoise focus-within:ring-offset-1'
          : 'flex cursor-pointer items-center justify-center rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-center text-sm text-charcoal hover:border-charcoal/40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 focus-within:ring-2 focus-within:ring-turquoise focus-within:ring-offset-1'
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

export default function RegistrationForm({ draft }: { draft: ApplicationDraft }) {
  const t = useTranslations('register');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { register, handleSubmit, getValues, control, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(registrationSchema),
    defaultValues: draftToDefaultValues(draft),
  });

  // Subscribes to live form state so step-gating re-renders as the user types.
  // register(...)-bound inputs are uncontrolled, so a getValues() snapshot taken
  // during render would otherwise freeze at whatever the values were at mount.
  const watchedValues = useWatch({ control });

  // Only writes the fields belonging to the step being edited, so autosaving step 1
  // never overwrites step-2/3 fields (e.g. required `interests`) with their empty defaults
  // before the user has reached that step.
  async function autosaveStep(fields: readonly (keyof FormValues)[]) {
    const supabase = createClient();
    const values = getValues();
    const payload: TablesUpdate<'applications'> = Object.fromEntries(
      fields.map((f) => [f, values[f]])
    );
    await supabase.from('applications').update(payload).eq('id', draft.id);
  }

  const router = useRouter();

  // Shared by both the "Submit Application" and "Skip" actions: persists step-3's
  // current values (whatever they are — all optional) and finalizes the application.
  // "Submit Application" reaches this via handleSubmit(onSubmit), which first
  // re-validates the ENTIRE registrationSchema (step-1/2 required fields included) and
  // only invokes this function if that passes. "Skip" calls this function directly,
  // bypassing that full-schema re-validation — by design, step 1/2 are already gated
  // valid by their own Next buttons (see isStepValid), and step 3's fields are all
  // optional, so Skip genuinely means "finalize with whatever step 3 currently holds"
  // rather than duplicating Submit's validation gate.
  async function finalizeSubmission() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await autosaveStep(STEP_3_FIELDS);
      await submitApplication(draft.id);
      router.push('/my-application');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  // react-hook-form's handleSubmit always calls this with the validated values as the
  // first argument; this handler doesn't need them (autosaveStep already persisted the
  // current values via getValues()), but the parameter must stay to match SubmitHandler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function onSubmit(_values: FormValues) {
    await finalizeSubmission();
  }

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

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {progressIndicator}
      <input {...register('organization')} placeholder="Organization" onBlur={() => autosaveStep(STEP_3_FIELDS)} />
      <textarea {...register('climate_experience')} placeholder="Climate experience" onBlur={() => autosaveStep(STEP_3_FIELDS)} />
      <textarea {...register('past_initiatives')} placeholder="Past initiatives" onBlur={() => autosaveStep(STEP_3_FIELDS)} />
      <textarea {...register('topics_to_learn')} placeholder="Topics to learn" onBlur={() => autosaveStep(STEP_3_FIELDS)} />
      <input {...register('content_type_pref')} placeholder="Content type preference" onBlur={() => autosaveStep(STEP_3_FIELDS)} />
      <fieldset>
        <legend>Track interests</legend>
        {TRACK_OPTIONS.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              value={option}
              {...register('track_interests')}
              onBlur={() => autosaveStep(STEP_3_FIELDS)}
            />
            {option}
          </label>
        ))}
      </fieldset>
      <textarea {...register('priority_sessions')} placeholder="Priority sessions" onBlur={() => autosaveStep(STEP_3_FIELDS)} />
      <textarea {...register('special_needs')} placeholder="Special needs" onBlur={() => autosaveStep(STEP_3_FIELDS)} />
      <button type="button" onClick={() => setStep(2)}>Back</button>
      <button type="submit" disabled={submitting}>Submit Application</button>
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
      <button type="button" disabled={submitting} onClick={() => void finalizeSubmission()}>Skip</button>
      {submitError && <p role="alert">{submitError}</p>}
    </form>
  );
}
