// tests/allocation/scoring.test.ts
import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '@/lib/allocation/scoring';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const result = cosineSimilarity({ a: 1, b: 0.5 }, { a: 1, b: 0.5 });
    expect(result.score).toBeCloseTo(1.0, 5);
    expect(result.isZeroVector).toBe(false);
  });

  it('returns 0 for orthogonal (no-overlap) vectors', () => {
    const result = cosineSimilarity({ a: 1 }, { b: 1 });
    expect(result.score).toBe(0);
    expect(result.isZeroVector).toBe(false);
  });

  it('returns 0 and flags isZeroVector when the participant vector is empty', () => {
    const result = cosineSimilarity({}, { a: 1 });
    expect(result.score).toBe(0);
    expect(result.isZeroVector).toBe(true);
  });

  it('returns 0 and flags isZeroVector when the session vector is empty', () => {
    const result = cosineSimilarity({ a: 1 }, {});
    expect(result.score).toBe(0);
    expect(result.isZeroVector).toBe(true);
  });

  it('returns 0 and flags isZeroVector when both vectors are empty', () => {
    const result = cosineSimilarity({}, {});
    expect(result.score).toBe(0);
    expect(result.isZeroVector).toBe(true);
  });

  it('computes partial overlap correctly', () => {
    const result = cosineSimilarity({ a: 1, b: 1 }, { a: 1 });
    expect(result.score).toBeCloseTo(1 / Math.sqrt(2), 5);
  });

  it('score is always within [0, 1]', () => {
    const result = cosineSimilarity({ a: 0.3, b: 0.9, c: 0.1 }, { a: 0.8, c: 0.5, d: 0.2 });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
