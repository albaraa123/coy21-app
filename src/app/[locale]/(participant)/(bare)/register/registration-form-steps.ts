// src/app/[locale]/(participant)/(bare)/register/registration-form-steps.ts
//
// Pure, directly-unit-testable step definitions and per-step validity
// checks for registration-form.tsx's 3-step flow. Extracted from the
// component so step-gating logic can be tested without simulating DOM
// interaction (this codebase has no interactive-DOM test setup — see
// tests/registration/registration-form-steps.test.ts for the full rationale).
import { personalInfoSchema, conferenceInfoSchema } from '@/lib/validation/registration';
import type { z } from 'zod';

type PersonalInfo = z.infer<typeof personalInfoSchema>;
type ConferenceInfo = z.infer<typeof conferenceInfoSchema>;
export type FormValues = PersonalInfo & ConferenceInfo;

export const STEP_1_FIELDS: readonly (keyof FormValues)[] = [
  'phone', 'country', 'nationality', 'birth_date', 'age_group',
  'city', 'field_of_work', 'preferred_language',
];

export const STEP_2_FIELDS: readonly (keyof FormValues)[] = [
  'interests', 'experience_level', 'participation_goals',
];

export const STEP_3_FIELDS: readonly (keyof FormValues)[] = [
  'organization', 'climate_experience', 'past_initiatives', 'topics_to_learn',
  'content_type_pref', 'track_interests', 'priority_sessions', 'special_needs',
];

/**
 * Whether the given step's own required fields are present in `values`.
 *
 * personalInfoSchema and conferenceInfoSchema are separate Zod schemas
 * combined into registrationSchema only via `.and()` (see
 * src/lib/validation/registration.ts) — each validates independently
 * without requiring the other's fields, so step 1 can be checked against
 * personalInfoSchema alone (including its birth_date-OR-age_group .refine)
 * and step 2 against conferenceInfoSchema alone, with no cross-schema
 * leakage requiring step-3-only fields.
 *
 * Step 3 is always valid (every STEP_3_FIELDS entry is .optional() in
 * conferenceInfoSchema) — this is what makes "Skip" always available.
 */
export function isStepValid(step: 1 | 2 | 3, values: Partial<FormValues>): boolean {
  if (step === 3) return true;
  const schema = step === 1 ? personalInfoSchema : conferenceInfoSchema;
  const result = schema.safeParse(values);
  return result.success;
}
