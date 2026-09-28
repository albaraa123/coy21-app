// src/lib/validation/allocation.ts
import { z } from 'zod';

// Fixed constants per the spec's "Allocation Algorithm" step on alternatives
// and low-confidence flagging — not admin-configurable, not stored per-run.
export const ALTERNATIVES_COUNT = 5;
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

export const EXTRACTABLE_SOURCE_FIELDS = [
  'interests',
  'track_interests',
  'topics_to_learn',
  'participation_goals',
  'past_initiatives',
] as const;

export const MATCH_TYPES = ['array_value', 'keyword_substring'] as const;

export const ARRAY_SOURCE_FIELDS = ['interests', 'track_interests'] as const;
export const FREE_TEXT_SOURCE_FIELDS = ['topics_to_learn', 'participation_goals', 'past_initiatives'] as const;

// Shared UUID-shaped-string validator. Standardized on `.guid()` (zod v4's
// more permissive "UUID-shaped string" check) rather than `.uuid()`
// (requires a valid version nibble) — `.guid()` accepts real v4 UUIDs too,
// so production values validate fine either way, but `.guid()` is the one
// that also accepts the placeholder UUIDs used in this repo's tests.
export const idSchema = z.string().guid();

export const extractionRuleSchema = z.object({
  sourceField: z.enum(EXTRACTABLE_SOURCE_FIELDS),
  matchType: z.enum(MATCH_TYPES),
  matchValue: z.string().min(1),
  tagId: idSchema,
  weight: z.number().min(0).max(1),
});

export const overrideAssignmentSchema = z.object({
  sessionId: idSchema,
  overrideReason: z.string().min(1, 'Override reason is required'),
});

export const triggerClusteringSchema = z.object({
  featureExtractionRunId: idSchema,
  k: z.number().int().positive(),
  randomSeed: z.number().int(),
});

export const triggerAllocationRunSchema = z.object({
  featureExtractionRunId: idSchema,
});
