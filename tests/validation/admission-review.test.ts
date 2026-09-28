import { describe, it, expect } from 'vitest';
import { statusTransitionSchema, noteBodySchema, VALID_TRANSITIONS } from '@/lib/validation/admission-review';

describe('statusTransitionSchema', () => {
  it('accepts a valid transition', () => {
    const result = statusTransitionSchema.safeParse({ from: 'submitted', to: 'under_review' });
    expect(result.success).toBe(true);
  });

  it('rejects a transition not in the state machine', () => {
    const result = statusTransitionSchema.safeParse({ from: 'submitted', to: 'accepted' });
    expect(result.success).toBe(false);
  });

  it('rejects draft as a target status', () => {
    const result = statusTransitionSchema.safeParse({ from: 'submitted', to: 'draft' });
    expect(result.success).toBe(false);
  });
});

describe('VALID_TRANSITIONS state machine', () => {
  it('allows all three decision states to reach each other directly', () => {
    expect(VALID_TRANSITIONS.accepted).toContain('rejected');
    expect(VALID_TRANSITIONS.accepted).toContain('waitlisted');
    expect(VALID_TRANSITIONS.rejected).toContain('accepted');
    expect(VALID_TRANSITIONS.rejected).toContain('waitlisted');
    expect(VALID_TRANSITIONS.waitlisted).toContain('accepted');
    expect(VALID_TRANSITIONS.waitlisted).toContain('rejected');
  });

  it('allows submitted and under_review to reach each other', () => {
    expect(VALID_TRANSITIONS.submitted).toContain('under_review');
    expect(VALID_TRANSITIONS.under_review).toContain('submitted');
  });

  it('never lists draft or withdrawn as a reachable target from any state', () => {
    for (const targets of Object.values(VALID_TRANSITIONS)) {
      expect(targets).not.toContain('draft');
      expect(targets).not.toContain('withdrawn');
    }
  });
});

describe('noteBodySchema', () => {
  it('rejects an empty body', () => {
    const result = noteBodySchema.safeParse({ body: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only body', () => {
    const result = noteBodySchema.safeParse({ body: '   \n  ' });
    expect(result.success).toBe(false);
  });

  it('accepts a real note', () => {
    const result = noteBodySchema.safeParse({ body: 'Looks good, strong policy background.' });
    expect(result.success).toBe(true);
  });
});
