// src/lib/allocation/feature-extraction.ts
// Phase B (design doc section 13.4): session_languages and the 3 track
// focus-area columns are the only new allowed sourceField values —
// deliberately NOT an open-ended extension to arbitrary application_answers
// keys. primary_track/secondary_track are plain scalar text columns
// (single selection each), unlike the array-typed fields below.
export interface ExtractionRule {
  id: string;
  sourceField:
    | 'interests' | 'track_interests' | 'topics_to_learn' | 'participation_goals' | 'past_initiatives'
    | 'session_languages' | 'track_1_focus_areas' | 'track_2_focus_areas' | 'track_3_focus_areas'
    | 'primary_track' | 'secondary_track';
  matchType: 'array_value' | 'keyword_substring';
  matchValue: string;
  tagId: string;
  weight: number;
  isActive?: boolean;
}

export interface ApplicationForExtraction {
  interests: string[] | null;
  trackInterests: string[] | null;
  topicsToLearn: string | null;
  participationGoals: string | null;
  pastInitiatives: string | null;
  sessionLanguages: string[] | null;
  track1FocusAreas: string[] | null;
  track2FocusAreas: string[] | null;
  track3FocusAreas: string[] | null;
  primaryTrack: string | null;
  secondaryTrack: string | null;
}

export interface ExtractedFeature {
  tagId: string;
  weight: number;
}

const ARRAY_FIELDS = new Set([
  'interests', 'track_interests',
  'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
]);

function fieldValue(app: ApplicationForExtraction, field: ExtractionRule['sourceField']): string[] | string | null {
  switch (field) {
    case 'interests':
      return app.interests;
    case 'track_interests':
      return app.trackInterests;
    case 'topics_to_learn':
      return app.topicsToLearn;
    case 'participation_goals':
      return app.participationGoals;
    case 'past_initiatives':
      return app.pastInitiatives;
    case 'session_languages':
      return app.sessionLanguages;
    case 'track_1_focus_areas':
      return app.track1FocusAreas;
    case 'track_2_focus_areas':
      return app.track2FocusAreas;
    case 'track_3_focus_areas':
      return app.track3FocusAreas;
    case 'primary_track':
      return app.primaryTrack;
    case 'secondary_track':
      return app.secondaryTrack;
  }
}

function ruleMatches(app: ApplicationForExtraction, rule: ExtractionRule): boolean {
  const value = fieldValue(app, rule.sourceField);
  if (value == null) return false;

  if (rule.matchType === 'array_value') {
    if (!ARRAY_FIELDS.has(rule.sourceField) || !Array.isArray(value)) return false;
    return value.includes(rule.matchValue);
  }

  // keyword_substring: case-insensitive substring match on a free-text field.
  if (typeof value !== 'string') return false;
  return value.toLowerCase().includes(rule.matchValue.toLowerCase());
}

// Sums weight per distinct matching rule id per tag (a rule contributes its
// weight at most once, regardless of how many times its keyword occurs
// within a field), across all source fields, then clamps to 1.0. Matches
// spec section "Feature Extraction Rules".
export function extractFeatures(app: ApplicationForExtraction, rules: ExtractionRule[]): ExtractedFeature[] {
  const weightByTag = new Map<string, number>();

  for (const rule of rules) {
    if (rule.isActive === false) continue;
    if (!ruleMatches(app, rule)) continue;
    weightByTag.set(rule.tagId, (weightByTag.get(rule.tagId) ?? 0) + rule.weight);
  }

  return Array.from(weightByTag.entries())
    .map(([tagId, weight]) => ({ tagId, weight: Math.min(weight, 1.0) }))
    .filter((f) => f.weight > 0);
}
