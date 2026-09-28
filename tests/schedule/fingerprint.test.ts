import { describe, expect, it } from 'vitest';
import { computeAssignmentSetFingerprint, computeSessionStateFingerprint } from '@/lib/schedule/fingerprint';

describe('computeAssignmentSetFingerprint', () => {
  it('is stable for identical input regardless of array order', () => {
    const a = [
      { applicationId: 'app-2', sessionId: 's1', suitabilityScore: 0.5, status: 'proposed', isManualOverride: false },
      { applicationId: 'app-1', sessionId: 's2', suitabilityScore: 0.8, status: 'proposed', isManualOverride: false },
    ];
    const b = [...a].reverse();
    expect(computeAssignmentSetFingerprint(a, [])).toBe(computeAssignmentSetFingerprint(b, []));
  });

  it('changes when any assignment field changes', () => {
    const base = [{ applicationId: 'app-1', sessionId: 's1', suitabilityScore: 0.5, status: 'proposed', isManualOverride: false }];
    const changed = [{ ...base[0], suitabilityScore: 0.6 }];
    expect(computeAssignmentSetFingerprint(changed, [])).not.toBe(computeAssignmentSetFingerprint(base, []));
  });

  it('changes when the issue set changes, even if assignments are identical', () => {
    const assignments = [{ applicationId: 'app-1', sessionId: 's1', suitabilityScore: 0.5, status: 'proposed', isManualOverride: false }];
    const noIssues = computeAssignmentSetFingerprint(assignments, []);
    const withIssue = computeAssignmentSetFingerprint(assignments, [{ issueType: 'low_confidence', applicationId: 'app-1', sessionId: 's1' }]);
    expect(noIssues).not.toBe(withIssue);
  });
});

describe('computeSessionStateFingerprint', () => {
  it('reflects both session fields and session_people, regardless of which changed', () => {
    const sessionOnly = computeSessionStateFingerprint(
      [{ sessionId: 's1', startTime: '2026-09-15T09:00:00Z', endTime: '2026-09-15T10:00:00Z', roomId: 'r1', status: 'confirmed' }],
      [{ sessionId: 's1', personId: 'p1', role: 'speaker', displayOrder: 0 }]
    );
    const speakersChanged = computeSessionStateFingerprint(
      [{ sessionId: 's1', startTime: '2026-09-15T09:00:00Z', endTime: '2026-09-15T10:00:00Z', roomId: 'r1', status: 'confirmed' }],
      [{ sessionId: 's1', personId: 'p2', role: 'speaker', displayOrder: 0 }]
    );
    expect(sessionOnly).not.toBe(speakersChanged);
  });
});
