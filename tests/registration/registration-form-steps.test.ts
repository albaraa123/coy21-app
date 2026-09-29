import { describe, it, expect } from 'vitest';
import { isStepValid, STEP_1_FIELDS, STEP_2_FIELDS, STEP_3_FIELDS } from '@/app/[locale]/(participant)/(bare)/register/registration-form-steps';
import type { z } from 'zod';
import type { registrationSchema } from '@/lib/validation/registration';

type FormValues = z.infer<typeof registrationSchema>;

describe('registration-form-steps', () => {
  it('STEP_1_FIELDS no longer includes organization (moved to step 3)', () => {
    expect(STEP_1_FIELDS).not.toContain('organization');
  });

  it('STEP_2_FIELDS is exactly interests, experience_level, participation_goals', () => {
    expect([...STEP_2_FIELDS].sort()).toEqual(['experience_level', 'interests', 'participation_goals'].sort());
  });

  it('STEP_3_FIELDS includes all 8 optional fields plus organization', () => {
    expect([...STEP_3_FIELDS].sort()).toEqual(
      [
        'organization', 'climate_experience', 'past_initiatives', 'topics_to_learn',
        'content_type_pref', 'track_interests', 'priority_sessions', 'special_needs',
      ].sort()
    );
  });

  it('isStepValid(1, values) is false when a required step-1 field is missing', () => {
    const values: Partial<FormValues> = { phone: '123', country: 'Oman' }; // missing nationality, city, field_of_work, preferred_language, birth_date/age_group
    expect(isStepValid(1, values)).toBe(false);
  });

  it('isStepValid(1, values) is true when all required step-1 fields are present (with age_group satisfying the birth_date-or-age_group refine)', () => {
    const values: Partial<FormValues> = {
      phone: '123456', country: 'Oman', nationality: 'Omani', city: 'Muscat',
      field_of_work: 'Climate', preferred_language: 'en', age_group: '25_34',
    };
    expect(isStepValid(1, values)).toBe(true);
  });

  it('isStepValid(3, values) is always true regardless of step-3 field contents (all optional — Skip is always available)', () => {
    expect(isStepValid(3, {})).toBe(true);
    expect(isStepValid(3, { organization: 'Some org' })).toBe(true);
  });
});
