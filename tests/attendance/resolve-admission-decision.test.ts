import { describe, expect, it } from 'vitest';
import { resolveAdmissionDecision, type AdmissionDecisionInput } from '@/lib/attendance/resolve-admission-decision';

const baseSession = {
  status: 'confirmed' as const,
  admissionPolicy: 'priority_then_open' as const,
  capacity: 10,
  prioritySeats: 6,
  priorityReleaseAt: null,
  priorityReleaseMinutesBefore: null,
  lateEntryCutoffMinutes: null,
  flexibleEntryManualOverride: null,
  startTime: '2026-09-19T09:00:00Z',
};

const baseCounts = { totalAdmitted: 0, admittedPriorityCount: 0, admittedFlexibleCount: 0 };

function input(overrides: Partial<AdmissionDecisionInput> = {}): AdmissionDecisionInput {
  return {
    now: new Date('2026-09-19T08:55:00Z'),
    session: baseSession,
    isRecommended: false,
    hasActiveAttendanceForThisSession: false,
    hasActiveAttendanceForConflictingSession: false,
    sessionCounts: baseCounts,
    isOverrideCaller: false,
    ...overrides,
  };
}

describe('resolveAdmissionDecision', () => {
  it('returns duplicate when already admitted to this exact session', () => {
    expect(resolveAdmissionDecision(input({ hasActiveAttendanceForThisSession: true })).result).toBe('duplicate');
  });

  it('returns timeslot_conflict when admitted to a different session in the same slot', () => {
    expect(resolveAdmissionDecision(input({ hasActiveAttendanceForConflictingSession: true })).result).toBe('timeslot_conflict');
  });

  it('duplicate takes precedence over timeslot_conflict when both are somehow true', () => {
    expect(
      resolveAdmissionDecision(input({ hasActiveAttendanceForThisSession: true, hasActiveAttendanceForConflictingSession: true })).result
    ).toBe('duplicate');
  });

  it('rejects when the session is not confirmed', () => {
    // Collapses to 'invalid_qr' — matches scan_attempts.result's check
    // constraint (Task 4) and the RPC (Task 11), which has no separate
    // "not open" code; the design spec's 7-color table has no distinct
    // color for this case either.
    expect(resolveAdmissionDecision(input({ session: { ...baseSession, status: 'draft' } })).result).toBe('invalid_qr');
  });

  it('blocks a normal scan past the late-entry cutoff', () => {
    // Also collapses to 'invalid_qr', for the same reason.
    const session = { ...baseSession, lateEntryCutoffMinutes: 15 };
    const now = new Date('2026-09-19T09:20:00Z'); // 20 min after start_time
    expect(resolveAdmissionDecision(input({ session, now })).result).toBe('invalid_qr');
  });

  it('an override caller bypasses the late-entry cutoff entirely', () => {
    const session = { ...baseSession, lateEntryCutoffMinutes: 15 };
    const now = new Date('2026-09-19T09:20:00Z');
    expect(resolveAdmissionDecision(input({ session, now, isOverrideCaller: true, isRecommended: true })).result).toBe('admitted');
  });

  it('returns full when total_admitted has reached capacity, even for a recommended participant', () => {
    const sessionCounts = { ...baseCounts, totalAdmitted: 10 };
    expect(resolveAdmissionDecision(input({ isRecommended: true, sessionCounts })).result).toBe('full');
  });

  describe('restricted policy', () => {
    it('denies a non-recommended participant', () => {
      const session = { ...baseSession, admissionPolicy: 'restricted' as const };
      expect(resolveAdmissionDecision(input({ session, isRecommended: false })).result).toBe('restricted_denied');
    });

    it('admits a recommended participant with entry_type priority', () => {
      const session = { ...baseSession, admissionPolicy: 'restricted' as const };
      const decision = resolveAdmissionDecision(input({ session, isRecommended: true }));
      expect(decision.result).toBe('admitted');
      expect(decision.entryType).toBe('priority');
    });
  });

  describe('plenary / open / cross_cutting policies', () => {
    for (const policy of ['plenary', 'open', 'cross_cutting'] as const) {
      it(`admits any participant with entry_type flexible under ${policy}`, () => {
        const session = { ...baseSession, admissionPolicy: policy };
        const decision = resolveAdmissionDecision(input({ session, isRecommended: false }));
        expect(decision.result).toBe('flexible_admitted');
        expect(decision.entryType).toBe('flexible');
      });
    }
  });

  describe('priority_then_open policy', () => {
    it('admits a recommended participant with entry_type priority regardless of release timing', () => {
      const decision = resolveAdmissionDecision(input({ isRecommended: true }));
      expect(decision.result).toBe('admitted');
      expect(decision.entryType).toBe('priority');
    });

    it('holds a non-recommended participant before release timing when priority seats are not exhausted-flexible-pool', () => {
      // capacity=10, prioritySeats=6 -> flexible pool pre-release = 10-6 = 4.
      // 4 flexible already admitted -> pool exhausted -> hold, even pre-release.
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4 };
      expect(resolveAdmissionDecision(input({ isRecommended: false, sessionCounts })).result).toBe('priority_hold');
    });

    it('flexibly admits a non-recommended participant before release timing while the flexible pool has room', () => {
      const sessionCounts = { ...baseCounts, totalAdmitted: 2, admittedFlexibleCount: 2 };
      const decision = resolveAdmissionDecision(input({ isRecommended: false, sessionCounts }));
      expect(decision.result).toBe('flexible_admitted');
      expect(decision.entryType).toBe('flexible');
    });

    it('holds a non-recommended participant when the flexible pool is exhausted and priority seats are not yet released', () => {
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4, admittedPriorityCount: 0 };
      expect(resolveAdmissionDecision(input({ isRecommended: false, sessionCounts })).result).toBe('priority_hold');
    });

    it('flexibly admits a non-recommended participant into a released-but-unused priority seat after release timing', () => {
      const session = { ...baseSession, priorityReleaseAt: '2026-09-19T08:50:00Z' }; // already past
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4, admittedPriorityCount: 2 };
      // effective_priority_pool=6, priority_used=2 -> 4 released seats join the 4-seat flexible pool = 8 total flexible capacity, 4 used -> room.
      const decision = resolveAdmissionDecision(input({ session, isRecommended: false, sessionCounts }));
      expect(decision.result).toBe('flexible_admitted');
    });

    it('manual override (flexibleEntryManualOverride=true) opens flexible entry even before the automatic release time', () => {
      const session = { ...baseSession, priorityReleaseAt: '2026-09-20T00:00:00Z', flexibleEntryManualOverride: true };
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4, admittedPriorityCount: 1 };
      const decision = resolveAdmissionDecision(input({ session, isRecommended: false, sessionCounts }));
      expect(decision.result).toBe('flexible_admitted');
    });

    it('manual override (flexibleEntryManualOverride=false) keeps flexible entry closed even after the automatic release time', () => {
      const session = { ...baseSession, priorityReleaseAt: '2026-09-19T08:50:00Z', flexibleEntryManualOverride: false };
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4, admittedPriorityCount: 0 };
      expect(resolveAdmissionDecision(input({ session, isRecommended: false, sessionCounts })).result).toBe('priority_hold');
    });

    it('treats a null priority_seats as "all seats are priority" (effective_priority_pool = capacity)', () => {
      const session = { ...baseSession, prioritySeats: null };
      // flexible pool pre-release = capacity - capacity = 0 -> immediate hold for non-recommended.
      expect(resolveAdmissionDecision(input({ session, isRecommended: false })).result).toBe('priority_hold');
    });
  });
});
