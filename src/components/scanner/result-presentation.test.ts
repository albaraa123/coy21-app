// src/components/scanner/result-presentation.test.ts
//
// Verifies the exhaustiveness guarantee getResultPresentation is meant
// to provide: every live scan_attempts.result value maps to a defined
// presentation, and no unrecognized value silently falls through to a
// success/neutral look.
import { describe, expect, it } from 'vitest';
import { LIVE_RESULT_KINDS, getResultPresentation } from './result-presentation';

describe('getResultPresentation', () => {
  it('has exactly the 9 live result kinds', () => {
    expect(LIVE_RESULT_KINDS).toHaveLength(9);
    expect(new Set(LIVE_RESULT_KINDS).size).toBe(9);
  });

  it.each(LIVE_RESULT_KINDS)('returns a non-null presentation for %s', (kind) => {
    const presentation = getResultPresentation(kind);
    expect(presentation).not.toBeNull();
    expect(presentation?.headlineKey).toBe(`result.${kind}.headline`);
    expect(presentation?.instructionKey).toBe(`result.${kind}.instruction`);
  });

  it('classifies the admitted family as success', () => {
    for (const kind of ['admitted', 'flexible_admitted', 'override_admitted'] as const) {
      expect(getResultPresentation(kind)?.severity).toBe('success');
      expect(getResultPresentation(kind)?.admitted).toBe(true);
    }
  });

  it('classifies recoverable/informational outcomes as attention, not denied', () => {
    for (const kind of ['priority_hold', 'duplicate', 'timeslot_conflict'] as const) {
      expect(getResultPresentation(kind)?.severity).toBe('attention');
      expect(getResultPresentation(kind)?.admitted).toBe(false);
    }
  });

  it('classifies hard rejections as denied', () => {
    for (const kind of ['full', 'restricted_denied', 'invalid_qr'] as const) {
      expect(getResultPresentation(kind)?.severity).toBe('denied');
      expect(getResultPresentation(kind)?.admitted).toBe(false);
    }
  });

  it('returns null for an unrecognized result value instead of a default/success look', () => {
    expect(getResultPresentation('some_future_result_value')).toBeNull();
    expect(getResultPresentation('')).toBeNull();
    expect(getResultPresentation('ADMITTED')).toBeNull();
  });
});
