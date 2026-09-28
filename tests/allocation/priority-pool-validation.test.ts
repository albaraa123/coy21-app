import { describe, expect, it } from 'vitest';
import { derivePriorityPoolIssues } from '@/lib/allocation/priority-pool-validation';

describe('derivePriorityPoolIssues', () => {
  it('flags a session where recommended count exceeds priority_seats', () => {
    const issues = derivePriorityPoolIssues({
      recommendedCountBySession: { 'session-a': 12 },
      prioritySeatsBySession: { 'session-a': 8 },
      capacityBySession: { 'session-a': 15 },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ issueType: 'priority_pool_exceeded', sessionId: 'session-a' });
    expect(issues[0].details).toMatchObject({ recommended_count: 12, priority_seats: 8 });
  });

  it('treats a null priority_seats as capacity (never flags in that case unless recommended exceeds capacity itself)', () => {
    const issues = derivePriorityPoolIssues({
      recommendedCountBySession: { 'session-a': 10 },
      prioritySeatsBySession: { 'session-a': null },
      capacityBySession: { 'session-a': 15 },
    });
    expect(issues).toHaveLength(0);
  });

  it('does not flag a session at or under its priority pool', () => {
    const issues = derivePriorityPoolIssues({
      recommendedCountBySession: { 'session-a': 8 },
      prioritySeatsBySession: { 'session-a': 8 },
      capacityBySession: { 'session-a': 15 },
    });
    expect(issues).toHaveLength(0);
  });
});
