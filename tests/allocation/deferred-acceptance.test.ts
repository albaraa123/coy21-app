// tests/allocation/deferred-acceptance.test.ts
import { describe, expect, it } from 'vitest';
import { runDeferredAcceptance, type ParticipantPreferences, type SessionCapacity } from '@/lib/allocation/deferred-acceptance';

describe('runDeferredAcceptance', () => {
  it('assigns each participant to their top eligible choice when capacity allows', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'p1', rankedSessionIds: ['s1', 's2'], scores: { s1: 0.9, s2: 0.5 } },
      { applicationId: 'p2', rankedSessionIds: ['s2'], scores: { s2: 0.8 } },
    ];
    const sessions: SessionCapacity[] = [
      { sessionId: 's1', capacity: 5 },
      { sessionId: 's2', capacity: 5 },
    ];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.assignments.find((a) => a.applicationId === 'p1')?.sessionId).toBe('s1');
    expect(result.assignments.find((a) => a.applicationId === 'p2')?.sessionId).toBe('s2');
    expect(result.unmatched).toEqual([]);
  });

  it('respects capacity: bumps the lower-scored participant when a higher scorer proposes late', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'low', rankedSessionIds: ['s1'], scores: { s1: 0.2 } },
      { applicationId: 'high', rankedSessionIds: ['s1'], scores: { s1: 0.9 } },
    ];
    const sessions: SessionCapacity[] = [{ sessionId: 's1', capacity: 1 }];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.assignments.find((a) => a.applicationId === 'high')?.sessionId).toBe('s1');
    expect(result.assignments.find((a) => a.applicationId === 'low')).toBeUndefined();
    expect(result.unmatched).toContain('low');
  });

  it('moves a bumped participant to their next-ranked choice', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'low', rankedSessionIds: ['s1', 's2'], scores: { s1: 0.2, s2: 0.6 } },
      { applicationId: 'high', rankedSessionIds: ['s1'], scores: { s1: 0.9 } },
    ];
    const sessions: SessionCapacity[] = [
      { sessionId: 's1', capacity: 1 },
      { sessionId: 's2', capacity: 1 },
    ];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.assignments.find((a) => a.applicationId === 'low')?.sessionId).toBe('s2');
    expect(result.unmatched).toEqual([]);
  });

  it('leaves a participant unmatched once their eligible set is exhausted', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'p1', rankedSessionIds: ['s1'], scores: { s1: 0.1 } },
      { applicationId: 'p2', rankedSessionIds: ['s1'], scores: { s1: 0.9 } },
    ];
    const sessions: SessionCapacity[] = [{ sessionId: 's1', capacity: 1 }];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.unmatched).toEqual(['p1']);
  });

  it('is deterministic given fixed scores', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'p1', rankedSessionIds: ['s1', 's2'], scores: { s1: 0.5, s2: 0.5 } },
      { applicationId: 'p2', rankedSessionIds: ['s1', 's2'], scores: { s1: 0.5, s2: 0.5 } },
    ];
    const sessions: SessionCapacity[] = [
      { sessionId: 's1', capacity: 1 },
      { sessionId: 's2', capacity: 1 },
    ];
    const a = runDeferredAcceptance(participants, sessions);
    const b = runDeferredAcceptance(participants, sessions);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never exceeds a session capacity', () => {
    const participants: ParticipantPreferences[] = Array.from({ length: 10 }, (_, i) => ({
      applicationId: `p${i}`,
      rankedSessionIds: ['s1'],
      scores: { s1: i / 10 },
    }));
    const sessions: SessionCapacity[] = [{ sessionId: 's1', capacity: 3 }];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.assignments.filter((a) => a.sessionId === 's1')).toHaveLength(3);
  });
});
