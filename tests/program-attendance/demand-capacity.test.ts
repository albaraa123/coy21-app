// tests/program-attendance/demand-capacity.test.ts
//
// Pure-logic unit coverage for computeDemandCapacityRows
// (src/lib/program-attendance/demand-capacity.ts) — zero Supabase/network
// imports, same pattern as tests/allocation/paginated-fetch.test.ts. The
// live-fetch half (fetchDemandCapacityForCaller) is covered separately in
// tests/program-attendance/demand-capacity-live.test.ts.
import { describe, expect, it } from 'vitest';
import { computeDemandCapacityRows, type DemandCapacitySessionInput } from '@/lib/program-attendance/demand-capacity';

function session(overrides: Partial<DemandCapacitySessionInput> & { id: string }): DemandCapacitySessionInput {
  return {
    session_code: overrides.id,
    title_ar: 'جلسة',
    title_en: 'Session',
    capacity: 10,
    min_capacity: 0,
    priority_seats: null,
    admission_policy: 'open',
    ...overrides,
  };
}

describe('computeDemandCapacityRows', () => {
  it('returns zeroed metrics for a session with no attendance rows', () => {
    const rows = computeDemandCapacityRows([session({ id: 's1', capacity: 10 })], [], 'en');
    expect(rows).toEqual([
      {
        sessionId: 's1',
        code: 's1',
        title: 'Session',
        capacity: 10,
        minCapacity: 0,
        prioritySeats: null,
        admissionPolicy: 'open',
        admittedTotal: 0,
        admittedPriority: 0,
        admittedFlexible: 0,
        remaining: 10,
        atOrOverCapacity: false,
      },
    ]);
  });

  it('counts admitted rows by entry_type, matching scan-attempt.ts loadSessionCounts semantics', () => {
    const rows = computeDemandCapacityRows(
      [session({ id: 's1', capacity: 10 })],
      [
        { session_id: 's1', entry_type: 'priority' },
        { session_id: 's1', entry_type: 'priority' },
        { session_id: 's1', entry_type: 'flexible' },
      ],
      'en'
    );
    expect(rows[0].admittedTotal).toBe(3);
    expect(rows[0].admittedPriority).toBe(2);
    expect(rows[0].admittedFlexible).toBe(1);
    expect(rows[0].remaining).toBe(7);
  });

  it('marks atOrOverCapacity true when admitted equals capacity exactly, and clamps remaining at 0 (never negative)', () => {
    const rows = computeDemandCapacityRows(
      [session({ id: 's1', capacity: 2 })],
      [
        { session_id: 's1', entry_type: 'priority' },
        { session_id: 's1', entry_type: 'priority' },
        { session_id: 's1', entry_type: 'flexible' },
      ],
      'en'
    );
    expect(rows[0].admittedTotal).toBe(3);
    expect(rows[0].atOrOverCapacity).toBe(true);
    expect(rows[0].remaining).toBe(0);
  });

  it('marks atOrOverCapacity false when admitted is below capacity', () => {
    const rows = computeDemandCapacityRows([session({ id: 's1', capacity: 10 })], [{ session_id: 's1', entry_type: 'priority' }], 'en');
    expect(rows[0].atOrOverCapacity).toBe(false);
    expect(rows[0].remaining).toBe(9);
  });

  it('scopes attendance rows to their own session_id — no cross-session leakage', () => {
    const rows = computeDemandCapacityRows(
      [session({ id: 's1', capacity: 10 }), session({ id: 's2', capacity: 10 })],
      [{ session_id: 's1', entry_type: 'priority' }],
      'en'
    );
    const s1 = rows.find((r) => r.sessionId === 's1')!;
    const s2 = rows.find((r) => r.sessionId === 's2')!;
    expect(s1.admittedTotal).toBe(1);
    expect(s2.admittedTotal).toBe(0);
  });

  it('selects the Arabic title when locale is "ar" and the English title otherwise', () => {
    const s = session({ id: 's1', title_ar: 'عنوان', title_en: 'Title' });
    expect(computeDemandCapacityRows([s], [], 'ar')[0].title).toBe('عنوان');
    expect(computeDemandCapacityRows([s], [], 'en')[0].title).toBe('Title');
  });

  it('returns an empty array for an empty sessions input, even with non-empty attendance rows', () => {
    const rows = computeDemandCapacityRows([], [{ session_id: 'orphan', entry_type: 'priority' }], 'en');
    expect(rows).toEqual([]);
  });

  it('preserves minCapacity/prioritySeats/admissionPolicy passthrough unchanged', () => {
    const rows = computeDemandCapacityRows([session({ id: 's1', min_capacity: 3, priority_seats: 5, admission_policy: 'restricted' })], [], 'en');
    expect(rows[0].minCapacity).toBe(3);
    expect(rows[0].prioritySeats).toBe(5);
    expect(rows[0].admissionPolicy).toBe('restricted');
  });
});
