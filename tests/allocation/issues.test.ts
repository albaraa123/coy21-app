// tests/allocation/issues.test.ts
import { describe, expect, it } from 'vitest';
import { deriveIssues, type IssueDerivationInput } from '@/lib/allocation/issues';

describe('deriveIssues', () => {
  it('produces an unassigned issue for a participant with no assignment in a slot group', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: ['s1'] } }],
      assignments: [],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 5 },
      assignedCountBySession: {},
      allParticipantIds: ['p1'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'unassigned' && i.applicationId === 'p1')).toBe(true);
  });

  it('produces a no_eligible_sessions issue when a participant has zero eligible sessions in a slot', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: [] } }],
      assignments: [],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: {},
      assignedCountBySession: {},
      allParticipantIds: ['p1'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'no_eligible_sessions' && i.applicationId === 'p1')).toBe(true);
  });

  it('produces a low_confidence issue for an assignment scoring below threshold', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: ['s1'] } }],
      assignments: [{ id: 'a1', applicationId: 'p1', sessionId: 's1', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.1 }],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 5 },
      assignedCountBySession: { s1: 1 },
      allParticipantIds: ['p1'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'low_confidence' && i.applicationId === 'p1')).toBe(true);
  });

  it('does not flag low_confidence exactly at the threshold boundary (threshold itself is not "below")', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: ['s1'] } }],
      assignments: [{ id: 'a1', applicationId: 'p1', sessionId: 's1', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.4 }],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 5 },
      assignedCountBySession: { s1: 1 },
      allParticipantIds: ['p1'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'low_confidence')).toBe(false);
  });

  it('produces a capacity_bottleneck issue when a session filled to capacity with eligible participants remaining unmatched', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: ['s1'], p2: ['s1'] } }],
      assignments: [{ id: 'a1', applicationId: 'p1', sessionId: 's1', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.9 }],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 1 },
      assignedCountBySession: { s1: 1 },
      allParticipantIds: ['p1', 'p2'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'capacity_bottleneck' && i.sessionId === 's1')).toBe(true);
  });

  it('produces a schedule_conflict issue when a participant holds two overlapping assignments, carrying conference_day_id', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [],
      assignments: [
        { id: 'a1', applicationId: 'p1', sessionId: 's1', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.9 },
        { id: 'a2', applicationId: 'p1', sessionId: 's2', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.9 },
      ],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 5, s2: 5 },
      assignedCountBySession: { s1: 1, s2: 1 },
      allParticipantIds: ['p1'],
      scheduleConflictPairs: [{ assignmentIds: ['a1', 'a2'], conferenceDayId: 'day-1' }],
    };
    const issues = deriveIssues(input);
    const conflict = issues.find((i) => i.issueType === 'schedule_conflict' && i.applicationId === 'p1');
    expect(conflict).toBeDefined();
    expect(conflict!.details.conference_day_id).toBe('day-1');
  });

  it('populates failed_constraints_summary on a no_eligible_sessions issue when the orchestrator supplies it', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: [] } }],
      assignments: [],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: {},
      assignedCountBySession: {},
      allParticipantIds: ['p1'],
      failedConstraintsSummary: { 'p1:slot-1': { language: 3, difficulty: 5, capacity: 0 } },
    };
    const issues = deriveIssues(input);
    const issue = issues.find((i) => i.issueType === 'no_eligible_sessions' && i.applicationId === 'p1');
    expect(issue!.details.failed_constraints_summary).toEqual({ language: 3, difficulty: 5, capacity: 0 });
  });
});
