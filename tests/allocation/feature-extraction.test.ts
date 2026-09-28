// tests/allocation/feature-extraction.test.ts
import { describe, expect, it } from 'vitest';
import { extractFeatures, type ExtractionRule, type ApplicationForExtraction } from '@/lib/allocation/feature-extraction';

const rules: ExtractionRule[] = [
  { id: 'rule-1', sourceField: 'interests', matchType: 'array_value', matchValue: 'climate-policy', tagId: 'tag-climate', weight: 0.6 },
  { id: 'rule-2', sourceField: 'topics_to_learn', matchType: 'keyword_substring', matchValue: 'policy', tagId: 'tag-climate', weight: 0.5 },
  { id: 'rule-3', sourceField: 'topics_to_learn', matchType: 'keyword_substring', matchValue: 'renewable', tagId: 'tag-energy', weight: 0.7 },
];

// Phase B: ApplicationForExtraction grew 6 new fields (session languages,
// track 1-3 focus areas, primary/secondary track). Every test below only
// cares about interests/topicsToLearn, so a shared all-null base keeps each
// test focused on what it actually varies rather than repeating the full
// field list.
const BASE_APPLICATION: ApplicationForExtraction = {
  interests: [],
  trackInterests: [],
  topicsToLearn: null,
  participationGoals: null,
  pastInitiatives: null,
  sessionLanguages: null,
  track1FocusAreas: null,
  track2FocusAreas: null,
  track3FocusAreas: null,
  primaryTrack: null,
  secondaryTrack: null,
};

describe('extractFeatures', () => {
  it('matches an array_value rule exactly', () => {
    const app: ApplicationForExtraction = { ...BASE_APPLICATION, interests: ['climate-policy'] };
    const result = extractFeatures(app, rules);
    expect(result).toEqual([{ tagId: 'tag-climate', weight: 0.6 }]);
  });

  it('matches a keyword_substring rule case-insensitively', () => {
    const app: ApplicationForExtraction = { ...BASE_APPLICATION, topicsToLearn: 'I want to learn about RENEWABLE energy' };
    const result = extractFeatures(app, rules);
    expect(result).toEqual([{ tagId: 'tag-energy', weight: 0.7 }]);
  });

  it('sums weights from distinct matching rules for the same tag, clamped to 1.0', () => {
    const app: ApplicationForExtraction = {
      ...BASE_APPLICATION,
      interests: ['climate-policy'],
      topicsToLearn: 'more about policy please',
    };
    const result = extractFeatures(app, rules);
    // rule-1 (0.6) + rule-2 (0.5) = 1.1, clamped to 1.0
    expect(result).toEqual([{ tagId: 'tag-climate', weight: 1.0 }]);
  });

  it('does not double-count a rule matching multiple times in one field', () => {
    const dupRules: ExtractionRule[] = [
      { id: 'rule-4', sourceField: 'topics_to_learn', matchType: 'keyword_substring', matchValue: 'policy', tagId: 'tag-climate', weight: 0.4 },
    ];
    const app: ApplicationForExtraction = { ...BASE_APPLICATION, topicsToLearn: 'policy policy policy' };
    const result = extractFeatures(app, dupRules);
    expect(result).toEqual([{ tagId: 'tag-climate', weight: 0.4 }]);
  });

  it('produces no rows for zero-weight (no match) tags', () => {
    const result = extractFeatures(BASE_APPLICATION, rules);
    expect(result).toEqual([]);
  });

  it('ignores inactive rules', () => {
    const inactiveRules: ExtractionRule[] = [
      { id: 'rule-5', sourceField: 'interests', matchType: 'array_value', matchValue: 'climate-policy', tagId: 'tag-climate', weight: 0.6, isActive: false },
    ];
    const app: ApplicationForExtraction = { ...BASE_APPLICATION, interests: ['climate-policy'] };
    const result = extractFeatures(app, inactiveRules);
    expect(result).toEqual([]);
  });

  // Phase B (design doc section 13.10, scenario 6): feature extraction reads
  // the 4 new structured allocation columns exactly like the pre-existing
  // ones — same array_value/keyword_substring matching, same weight-summing
  // and clamping behavior.
  it('matches an array_value rule against session_languages', () => {
    const sessionLanguageRules: ExtractionRule[] = [
      { id: 'rule-6', sourceField: 'session_languages', matchType: 'array_value', matchValue: 'Arabic', tagId: 'tag-arabic', weight: 0.8 },
    ];
    const app: ApplicationForExtraction = { ...BASE_APPLICATION, sessionLanguages: ['Arabic', 'English'] };
    const result = extractFeatures(app, sessionLanguageRules);
    expect(result).toEqual([{ tagId: 'tag-arabic', weight: 0.8 }]);
  });

  it('matches an array_value rule against each of track_1/2/3_focus_areas independently', () => {
    const trackRules: ExtractionRule[] = [
      { id: 'rule-7', sourceField: 'track_1_focus_areas', matchType: 'array_value', matchValue: 'Adaptation', tagId: 'tag-adaptation', weight: 0.5 },
      { id: 'rule-8', sourceField: 'track_2_focus_areas', matchType: 'array_value', matchValue: 'Green Economy', tagId: 'tag-green-economy', weight: 0.5 },
      { id: 'rule-9', sourceField: 'track_3_focus_areas', matchType: 'array_value', matchValue: 'Climate Finance', tagId: 'tag-finance', weight: 0.5 },
    ];
    const app: ApplicationForExtraction = {
      ...BASE_APPLICATION,
      track1FocusAreas: ['Adaptation'],
      track2FocusAreas: ['Green Economy'],
      track3FocusAreas: ['Climate Finance'],
    };
    const result = extractFeatures(app, trackRules);
    expect(result).toEqual(
      expect.arrayContaining([
        { tagId: 'tag-adaptation', weight: 0.5 },
        { tagId: 'tag-green-economy', weight: 0.5 },
        { tagId: 'tag-finance', weight: 0.5 },
      ])
    );
    expect(result).toHaveLength(3);
  });

  it('matches a keyword_substring rule against primary_track/secondary_track (scalar fields)', () => {
    const trackScalarRules: ExtractionRule[] = [
      { id: 'rule-10', sourceField: 'primary_track', matchType: 'keyword_substring', matchValue: 'Adaptation', tagId: 'tag-adaptation', weight: 0.9 },
    ];
    const app: ApplicationForExtraction = { ...BASE_APPLICATION, primaryTrack: 'Track 1: Adaptation, Resilience, and Human Well-being' };
    const result = extractFeatures(app, trackScalarRules);
    expect(result).toEqual([{ tagId: 'tag-adaptation', weight: 0.9 }]);
  });

  it('does not match an array_value rule against a scalar field like primary_track', () => {
    const invalidRule: ExtractionRule[] = [
      { id: 'rule-11', sourceField: 'primary_track', matchType: 'array_value', matchValue: 'Adaptation', tagId: 'tag-adaptation', weight: 0.9 },
    ];
    const app: ApplicationForExtraction = { ...BASE_APPLICATION, primaryTrack: 'Adaptation' };
    const result = extractFeatures(app, invalidRule);
    expect(result).toEqual([]);
  });
});
