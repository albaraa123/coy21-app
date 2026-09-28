import { describe, it, expect } from 'vitest';
import { personalInfoSchema, conferenceInfoSchema } from '@/lib/validation/registration';

describe('personalInfoSchema', () => {
  it('requires either birth_date or age_group', () => {
    const result = personalInfoSchema.safeParse({
      phone: '+1234567890',
      country: 'Jordan',
      nationality: 'Jordanian',
      city: 'Amman',
      field_of_work: 'Environment',
      preferred_language: 'ar',
    });
    expect(result.success).toBe(false);
  });

  it('accepts age_group without birth_date', () => {
    const result = personalInfoSchema.safeParse({
      phone: '+1234567890',
      country: 'Jordan',
      nationality: 'Jordanian',
      age_group: '25_34',
      city: 'Amman',
      field_of_work: 'Environment',
      preferred_language: 'ar',
    });
    expect(result.success).toBe(true);
  });
});

describe('conferenceInfoSchema', () => {
  it('requires at least one interest', () => {
    const result = conferenceInfoSchema.safeParse({
      interests: [],
      experience_level: 'beginner',
      participation_goals: 'Learn about climate policy',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid submission', () => {
    const result = conferenceInfoSchema.safeParse({
      interests: ['policy'],
      experience_level: 'beginner',
      participation_goals: 'Learn about climate policy',
    });
    expect(result.success).toBe(true);
  });
});
