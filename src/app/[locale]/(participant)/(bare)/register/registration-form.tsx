'use client';

import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslations } from 'next-intl';
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

  const progressIndicator = <p>{t('stepProgress', { step, total: 3 })}</p>;

  if (step === 1) {
    return (
      <div>
        {progressIndicator}
        <input {...register('phone')} placeholder="Phone" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        {errors.phone && <p>{errors.phone.message}</p>}
        <input {...register('country')} placeholder="Country" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        {errors.country && <p>{errors.country.message}</p>}
        <input {...register('nationality')} placeholder="Nationality" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        {errors.nationality && <p>{errors.nationality.message}</p>}
        <input {...register('birth_date')} type="date" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        <select {...register('age_group')} onBlur={() => autosaveStep(STEP_1_FIELDS)}>
          <option value="">Age group</option>
          {AGE_GROUP_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        {errors.birth_date && <p>{errors.birth_date.message}</p>}
        <input {...register('city')} placeholder="City" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        {errors.city && <p>{errors.city.message}</p>}
        <input {...register('field_of_work')} placeholder="Field of work" onBlur={() => autosaveStep(STEP_1_FIELDS)} />
        {errors.field_of_work && <p>{errors.field_of_work.message}</p>}
        <select {...register('preferred_language')} onBlur={() => autosaveStep(STEP_1_FIELDS)}>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
        <button
          type="button"
          disabled={!isStepValid(1, watchedValues)}
          onClick={() => {
            void autosaveStep(STEP_1_FIELDS);
            setStep(2);
          }}
        >
          Next
        </button>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div>
        {progressIndicator}
        <fieldset>
          <legend>Interests (select at least one)</legend>
          {INTEREST_OPTIONS.map((option) => (
            <label key={option}>
              <input
                type="checkbox"
                value={option}
                {...register('interests')}
                onBlur={() => autosaveStep(STEP_2_FIELDS)}
              />
              {option}
            </label>
          ))}
          {errors.interests && <p>{errors.interests.message}</p>}
        </fieldset>
        <select {...register('experience_level')} onBlur={() => autosaveStep(STEP_2_FIELDS)}>
          <option value="none">None</option>
          <option value="beginner">Beginner</option>
          <option value="intermediate">Intermediate</option>
          <option value="expert">Expert</option>
        </select>
        {errors.experience_level && <p>{errors.experience_level.message}</p>}
        <textarea {...register('participation_goals')} placeholder="Participation goals" onBlur={() => autosaveStep(STEP_2_FIELDS)} />
        {errors.participation_goals && <p>{errors.participation_goals.message}</p>}
        <button type="button" onClick={() => setStep(1)}>Back</button>
        <button
          type="button"
          disabled={!isStepValid(2, watchedValues)}
          onClick={() => {
            void autosaveStep(STEP_2_FIELDS);
            setStep(3);
          }}
        >
          Next
        </button>
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
