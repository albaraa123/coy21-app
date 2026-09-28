// tests/validation/allocation.test.ts
import { describe, expect, it } from 'vitest';
import {
  ALTERNATIVES_COUNT,
  LOW_CONFIDENCE_THRESHOLD,
  extractionRuleSchema,
  overrideAssignmentSchema,
} from '@/lib/validation/allocation';

describe('allocation constants', () => {
  it('has the fixed constants from the spec', () => {
    expect(ALTERNATIVES_COUNT).toBe(5);
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.4);
  });
});

describe('extractionRuleSchema', () => {
  it('accepts a valid array_value rule', () => {
    const result = extractionRuleSchema.parse({
      sourceField: 'interests',
      matchType: 'array_value',
      matchValue: 'climate-policy',
      tagId: '00000000-0000-0000-0000-000000000001',
      weight: 0.5,
    });
    expect(result.weight).toBe(0.5);
  });

  it('rejects weight out of range', () => {
    expect(() =>
      extractionRuleSchema.parse({
        sourceField: 'interests',
        matchType: 'array_value',
        matchValue: 'x',
        tagId: '00000000-0000-0000-0000-000000000001',
        weight: 1.5,
      })
    ).toThrow();
  });

  it('rejects an unrecognized source field', () => {
    expect(() =>
      extractionRuleSchema.parse({
        sourceField: 'special_needs',
        matchType: 'array_value',
        matchValue: 'x',
        tagId: '00000000-0000-0000-0000-000000000001',
        weight: 0.5,
      })
    ).toThrow();
  });
});

describe('overrideAssignmentSchema', () => {
  it('requires a non-empty override reason', () => {
    expect(() =>
      overrideAssignmentSchema.parse({
        sessionId: '00000000-0000-0000-0000-000000000002',
        overrideReason: '',
      })
    ).toThrow();
  });
});
