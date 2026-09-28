// tests/validation/schedule.test.ts
import { describe, expect, it } from 'vitest';
import { reassignSchema, overridePublishWithGapSchema, stagePublicationSchema } from '@/lib/validation/schedule';

describe('reassignSchema', () => {
  it('accepts a valid reassignment', () => {
    const result = reassignSchema.parse({
      draftItemId: '00000000-0000-0000-0000-000000000001',
      newSessionId: '00000000-0000-0000-0000-000000000002',
    });
    expect(result.newSessionId).toBe('00000000-0000-0000-0000-000000000002');
  });
});

describe('overridePublishWithGapSchema', () => {
  it('requires a non-empty override reason', () => {
    expect(() =>
      overridePublishWithGapSchema.parse({
        draftItemId: '00000000-0000-0000-0000-000000000001',
        overrideReason: '',
      })
    ).toThrow();
  });

  it('accepts a documented reason', () => {
    const result = overridePublishWithGapSchema.parse({
      draftItemId: '00000000-0000-0000-0000-000000000001',
      overrideReason: 'Participant confirmed attendance offline; mandatory session unavailable this run.',
    });
    expect(result.overrideReason.length).toBeGreaterThan(0);
  });
});

describe('stagePublicationSchema', () => {
  it('accepts a run-source stage request', () => {
    const result = stagePublicationSchema.parse({ allocationRunId: '00000000-0000-0000-0000-000000000001' });
    expect(result.allocationRunId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('accepts a change-event-source stage request', () => {
    const result = stagePublicationSchema.parse({ changeEventIds: ['00000000-0000-0000-0000-000000000001'] });
    expect(result.changeEventIds).toHaveLength(1);
  });

  it('rejects a request with neither source', () => {
    expect(() => stagePublicationSchema.parse({})).toThrow();
  });

  it('rejects a request with both sources', () => {
    expect(() =>
      stagePublicationSchema.parse({
        allocationRunId: '00000000-0000-0000-0000-000000000001',
        changeEventIds: ['00000000-0000-0000-0000-000000000002'],
      })
    ).toThrow();
  });
});
