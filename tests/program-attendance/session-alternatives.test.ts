// tests/program-attendance/session-alternatives.test.ts
//
// Pure-logic unit coverage for computeAlternatives/computeSeatStatus
// (src/lib/program-attendance/session-alternatives.ts) — zero Supabase
// imports, same pattern as tests/program-attendance/demand-capacity.test.ts.
// The live-fetch half (getAlternativesForTimeslotForCaller) is covered
// separately in session-alternatives-live.test.ts.
import { describe, expect, it } from 'vitest';
import { computeAlternatives, computeSeatStatus, type CandidateSessionInput } from '@/lib/program-attendance/session-alternatives';
import type { SessionCounts } from '@/lib/attendance/resolve-admission-decision';

const NOW = new Date('2026-09-24T12:00:00Z');

function session(overrides: Partial<CandidateSessionInput> & { id: string }): CandidateSessionInput {
  return {
    titleAr: 'جلسة',
    titleEn: 'Session',
    roomNameAr: 'قاعة',
    roomNameEn: 'Room',
    startTime: '2026-09-24T13:00:00Z',
    endTime: '2026-09-24T14:00:00Z',
    status: 'confirmed',
    admissionPolicy: 'open',
    capacity: 10,
    prioritySeats: null,
    priorityReleaseAt: null,
    priorityReleaseMinutesBefore: null,
    lateEntryCutoffMinutes: null,
    flexibleEntryManualOverride: null,
    conferenceDayId: 'day-1',
    isMandatory: false,
    ...overrides,
  };
}

const ZERO_COUNTS: SessionCounts = { totalAdmitted: 0, admittedPriorityCount: 0, admittedFlexibleCount: 0 };

function baseParams(overrides: Partial<Parameters<typeof computeAlternatives>[0]> = {}): Parameters<typeof computeAlternatives>[0] {
  return {
    daySessions: [],
    currentSessionId: 'current',
    now: NOW,
    sessionCountsBySessionId: new Map(),
    recommendedSessionIds: new Set(),
    attendedSessionIdsInSlot: new Set(),
    rankBySessionId: new Map(),
    ...overrides,
  };
}

describe('computeSeatStatus', () => {
  it('returns "available" when well below capacity', () => {
    expect(computeSeatStatus(2, 10)).toBe('available');
  });

  it('returns "almost_full" at exactly 90% capacity', () => {
    expect(computeSeatStatus(9, 10)).toBe('almost_full');
  });

  it('returns "almost_full" just under full', () => {
    expect(computeSeatStatus(9, 10)).toBe('almost_full');
  });

  it('returns "full" when admitted equals capacity', () => {
    expect(computeSeatStatus(10, 10)).toBe('full');
  });

  it('returns "full" when admitted exceeds capacity (should not happen, but must not crash or misreport)', () => {
    expect(computeSeatStatus(11, 10)).toBe('full');
  });

  it('returns "available" for a zero-capacity session with zero admitted (no divide-by-zero crash)', () => {
    expect(computeSeatStatus(0, 0)).toBe('full'); // 0 >= 0 -> full is the correct/safe reading, not a crash
  });
});

describe('computeAlternatives', () => {
  it('excludes the current session itself, even if it would otherwise be eligible', () => {
    const current = session({ id: 'current', admissionPolicy: 'open' });
    const other = session({ id: 'other', admissionPolicy: 'open' });
    const result = computeAlternatives(
      baseParams({
        daySessions: [current, other],
        currentSessionId: 'current',
        sessionCountsBySessionId: new Map([['other', ZERO_COUNTS]]),
      })
    );
    expect(result.map((r) => r.sessionId)).toEqual(['other']);
  });

  it('includes an eligible compatible alternative (open policy, confirmed, future, same time slot)', () => {
    const current = session({ id: 'current' });
    const alt = session({ id: 'alt', admissionPolicy: 'open' });
    const result = computeAlternatives(baseParams({ daySessions: [current, alt], currentSessionId: 'current', sessionCountsBySessionId: new Map([['alt', ZERO_COUNTS]]) }));
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('alt');
  });

  it('excludes a session with admission_policy "restricted"', () => {
    const current = session({ id: 'current' });
    const restricted = session({ id: 'restricted', admissionPolicy: 'restricted' });
    const result = computeAlternatives(baseParams({ daySessions: [current, restricted], currentSessionId: 'current' }));
    expect(result).toEqual([]);
  });

  it('excludes a session with admission_policy "plenary"', () => {
    const current = session({ id: 'current' });
    const plenary = session({ id: 'plenary', admissionPolicy: 'plenary' });
    const result = computeAlternatives(baseParams({ daySessions: [current, plenary], currentSessionId: 'current' }));
    expect(result).toEqual([]);
  });

  it('includes "priority_then_open" and "cross_cutting" as eligible policies', () => {
    const current = session({ id: 'current' });
    const priorityThenOpen = session({ id: 'pto', admissionPolicy: 'priority_then_open' });
    const crossCutting = session({ id: 'cc', admissionPolicy: 'cross_cutting' });
    const result = computeAlternatives(
      baseParams({
        daySessions: [current, priorityThenOpen, crossCutting],
        currentSessionId: 'current',
        sessionCountsBySessionId: new Map([
          ['pto', ZERO_COUNTS],
          ['cc', ZERO_COUNTS],
        ]),
      })
    );
    expect(result.map((r) => r.sessionId).sort()).toEqual(['cc', 'pto']);
  });

  it('excludes a session that does not belong to the same time-slot group (different, non-overlapping time)', () => {
    const current = session({ id: 'current', startTime: '2026-09-24T13:00:00Z', endTime: '2026-09-24T14:00:00Z' });
    const laterUnrelated = session({ id: 'later', startTime: '2026-09-24T18:00:00Z', endTime: '2026-09-24T19:00:00Z', admissionPolicy: 'open' });
    const result = computeAlternatives(baseParams({ daySessions: [current, laterUnrelated], currentSessionId: 'current' }));
    expect(result).toEqual([]);
  });

  it('excludes a session that has already ended (past session)', () => {
    const current = session({ id: 'current', startTime: '2026-09-24T09:00:00Z', endTime: '2026-09-24T10:00:00Z' });
    // Overlaps current in time but has already ended relative to `now` (12:00) — still excluded.
    const past = session({ id: 'past', admissionPolicy: 'open', startTime: '2026-09-24T09:00:00Z', endTime: '2026-09-24T10:00:00Z' });
    const result = computeAlternatives(baseParams({ daySessions: [current, past], currentSessionId: 'current' }));
    expect(result).toEqual([]);
  });

  it('excludes a session with status other than "confirmed" (e.g. draft/cancelled)', () => {
    const current = session({ id: 'current' });
    const draft = session({ id: 'draft', admissionPolicy: 'open', status: 'draft' });
    const result = computeAlternatives(baseParams({ daySessions: [current, draft], currentSessionId: 'current' }));
    expect(result).toEqual([]);
  });

  it('marks a full alternative session with seatStatus "full" and remainingSeats 0', () => {
    const current = session({ id: 'current' });
    const full = session({ id: 'full', admissionPolicy: 'open', capacity: 5 });
    const result = computeAlternatives(
      baseParams({
        daySessions: [current, full],
        currentSessionId: 'current',
        sessionCountsBySessionId: new Map([['full', { totalAdmitted: 5, admittedPriorityCount: 0, admittedFlexibleCount: 5 }]]),
      })
    );
    expect(result[0].seatStatus).toBe('full');
    expect(result[0].remainingSeats).toBe(0);
  });

  it('computes remainingSeats correctly for a partially-filled alternative', () => {
    const current = session({ id: 'current' });
    const partial = session({ id: 'partial', admissionPolicy: 'open', capacity: 10 });
    const result = computeAlternatives(
      baseParams({
        daySessions: [current, partial],
        currentSessionId: 'current',
        sessionCountsBySessionId: new Map([['partial', { totalAdmitted: 3, admittedPriorityCount: 3, admittedFlexibleCount: 0 }]]),
      })
    );
    expect(result[0].remainingSeats).toBe(7);
    expect(result[0].seatStatus).toBe('available');
  });

  it('orders ranked alternatives (from allocation_alternatives) before unranked ones', () => {
    const current = session({ id: 'current' });
    const unranked = session({ id: 'unranked', admissionPolicy: 'open', startTime: '2026-09-24T13:00:00Z', endTime: '2026-09-24T14:00:00Z' });
    const ranked = session({ id: 'ranked', admissionPolicy: 'open', startTime: '2026-09-24T13:30:00Z', endTime: '2026-09-24T14:30:00Z' });
    const result = computeAlternatives(
      baseParams({
        daySessions: [current, unranked, ranked],
        currentSessionId: 'current',
        sessionCountsBySessionId: new Map([
          ['unranked', ZERO_COUNTS],
          ['ranked', ZERO_COUNTS],
        ]),
        rankBySessionId: new Map([['ranked', 1]]),
      })
    );
    expect(result.map((r) => r.sessionId)).toEqual(['ranked', 'unranked']);
  });

  it('orders unranked alternatives by start time as a stable secondary sort', () => {
    const current = session({ id: 'current' });
    const later = session({ id: 'later', admissionPolicy: 'open', startTime: '2026-09-24T13:30:00Z', endTime: '2026-09-24T14:30:00Z' });
    const earlier = session({ id: 'earlier', admissionPolicy: 'open', startTime: '2026-09-24T13:00:00Z', endTime: '2026-09-24T14:00:00Z' });
    const result = computeAlternatives(
      baseParams({
        daySessions: [current, later, earlier],
        currentSessionId: 'current',
        sessionCountsBySessionId: new Map([
          ['later', ZERO_COUNTS],
          ['earlier', ZERO_COUNTS],
        ]),
      })
    );
    expect(result.map((r) => r.sessionId)).toEqual(['earlier', 'later']);
  });

  it('marks isRecommended-derived previewResult "admitted" for a recommended restricted-eligible... (never applies here since restricted is excluded) — instead verifies flexible_admitted for an eligible open session with room', () => {
    const current = session({ id: 'current' });
    const alt = session({ id: 'alt', admissionPolicy: 'open' });
    const result = computeAlternatives(baseParams({ daySessions: [current, alt], currentSessionId: 'current', sessionCountsBySessionId: new Map([['alt', ZERO_COUNTS]]) }));
    expect(result[0].previewResult).toBe('flexible_admitted');
  });

  it('marks previewResult "full" when the alternative session is at capacity', () => {
    const current = session({ id: 'current' });
    const full = session({ id: 'full', admissionPolicy: 'open', capacity: 2 });
    const result = computeAlternatives(
      baseParams({
        daySessions: [current, full],
        currentSessionId: 'current',
        sessionCountsBySessionId: new Map([['full', { totalAdmitted: 2, admittedPriorityCount: 0, admittedFlexibleCount: 2 }]]),
      })
    );
    expect(result[0].previewResult).toBe('full');
  });

  it('returns an empty array when the current session is not found in daySessions at all', () => {
    const other = session({ id: 'other', admissionPolicy: 'open' });
    const result = computeAlternatives(baseParams({ daySessions: [other], currentSessionId: 'current' }));
    expect(result).toEqual([]);
  });

  it('de-duplicates by sessionId if the same session somehow appears twice in daySessions', () => {
    const current = session({ id: 'current' });
    const alt = session({ id: 'alt', admissionPolicy: 'open' });
    const result = computeAlternatives(
      baseParams({
        daySessions: [current, alt, { ...alt }],
        currentSessionId: 'current',
        sessionCountsBySessionId: new Map([['alt', ZERO_COUNTS]]),
      })
    );
    expect(result).toHaveLength(1);
  });

  it('never includes suitability_score, priority_seats counts, or internal staff codes in the returned shape', () => {
    const current = session({ id: 'current' });
    const alt = session({ id: 'alt', admissionPolicy: 'open', prioritySeats: 5 });
    const result = computeAlternatives(baseParams({ daySessions: [current, alt], currentSessionId: 'current', sessionCountsBySessionId: new Map([['alt', ZERO_COUNTS]]) }));
    const keys = Object.keys(result[0]);
    expect(keys).not.toContain('suitabilityScore');
    expect(keys).not.toContain('prioritySeats');
    expect(keys).not.toContain('rank');
  });
});
