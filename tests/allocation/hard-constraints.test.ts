// tests/allocation/hard-constraints.test.ts
import { describe, expect, it } from 'vitest';
import { checkStaticHardConstraints, type ParticipantForConstraints, type SessionForConstraints } from '@/lib/allocation/hard-constraints';

const baseSession: SessionForConstraints = {
  id: 'session-1',
  status: 'confirmed',
  includeInAllocation: true,
  language: 'ar',
  difficultyLevel: 'beginner',
  isMandatory: false,
};

const baseParticipant: ParticipantForConstraints = {
  applicationId: 'app-1',
  preferredLanguage: 'ar',
  experienceLevel: 'beginner',
};

describe('checkStaticHardConstraints', () => {
  it('passes when every constraint matches', () => {
    const result = checkStaticHardConstraints(baseParticipant, baseSession);
    expect(result.eligible).toBe(true);
  });

  it('fails when session is not confirmed', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, status: 'draft' });
    expect(result.eligible).toBe(false);
    expect(result.checks.find((c) => c.constraintType === 'confirmed_status')?.passed).toBe(false);
  });

  it('fails when include_in_allocation is false', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, includeInAllocation: false });
    expect(result.eligible).toBe(false);
  });

  it('passes on bilingual session regardless of participant language', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, preferredLanguage: 'en' }, { ...baseSession, language: 'bilingual' });
    expect(result.checks.find((c) => c.constraintType === 'language_match')?.passed).toBe(true);
  });

  it('fails on a language mismatch', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, preferredLanguage: 'en' }, { ...baseSession, language: 'ar' });
    expect(result.checks.find((c) => c.constraintType === 'language_match')?.passed).toBe(false);
  });

  it('treats null preferred_language as matching any language', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, preferredLanguage: null }, { ...baseSession, language: 'en' });
    expect(result.checks.find((c) => c.constraintType === 'language_match')?.passed).toBe(true);
  });

  it('treats an out-of-vocabulary preferred_language as matching any language', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, preferredLanguage: 'fr' }, { ...baseSession, language: 'en' });
    expect(result.checks.find((c) => c.constraintType === 'language_match')?.passed).toBe(true);
  });

  it('allows adjacent-tier difficulty (beginner participant eligible for intermediate session)', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, difficultyLevel: 'intermediate' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(true);
  });

  it('rejects non-adjacent-tier difficulty (beginner participant not eligible for advanced session)', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, difficultyLevel: 'advanced' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(false);
  });

  it('all_levels sessions are always difficulty-eligible', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, experienceLevel: 'expert' }, { ...baseSession, difficultyLevel: 'all_levels' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(true);
  });

  it('treats null experience_level as beginner tier (most inclusive)', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, experienceLevel: null }, { ...baseSession, difficultyLevel: 'intermediate' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(true);
  });

  it('treats an out-of-vocabulary experience_level as beginner tier', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, experienceLevel: 'guru' }, { ...baseSession, difficultyLevel: 'advanced' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(false);
  });

  it('mandatory sessions are flagged as excluded from this pipeline', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, isMandatory: true });
    expect(result.excludedAsMandatory).toBe(true);
  });
});
