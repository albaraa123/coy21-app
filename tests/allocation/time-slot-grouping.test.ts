// tests/allocation/time-slot-grouping.test.ts
import { describe, expect, it } from 'vitest';
import { groupSessionsIntoTimeSlots, computeTimeSlotGroupKey, type SessionForGrouping } from '@/lib/allocation/time-slot-grouping';

function s(id: string, day: string, start: string, end: string, mandatory = false): SessionForGrouping {
  return { id, conferenceDayId: day, startTime: start, endTime: end, isMandatory: mandatory };
}

describe('computeTimeSlotGroupKey', () => {
  it('is order-independent (same set, different input order -> same key)', () => {
    const k1 = computeTimeSlotGroupKey(['b', 'a', 'c']);
    const k2 = computeTimeSlotGroupKey(['c', 'b', 'a']);
    expect(k1).toBe(k2);
  });

  it('is deterministic and produces a hex string', () => {
    const k = computeTimeSlotGroupKey(['session-1']);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different keys for different sets', () => {
    expect(computeTimeSlotGroupKey(['a'])).not.toBe(computeTimeSlotGroupKey(['a', 'b']));
  });
});

describe('groupSessionsIntoTimeSlots', () => {
  it('groups two overlapping sessions on the same day into one component', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      s('s2', 'day-1', '2026-08-01T09:30:00Z', '2026-08-01T10:30:00Z'),
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionIds.sort()).toEqual(['s1', 's2']);
  });

  it('keeps non-overlapping sessions on the same day as separate groups', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      s('s2', 'day-1', '2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z'), // half-open: touching, not overlapping
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(2);
  });

  it('never groups sessions across different conference days', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      s('s2', 'day-2', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(2);
  });

  it('transitively links three sessions via a chain of overlaps into one component', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      s('s2', 'day-1', '2026-08-01T09:30:00Z', '2026-08-01T10:30:00Z'),
      s('s3', 'day-1', '2026-08-01T10:15:00Z', '2026-08-01T11:00:00Z'),
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionIds.sort()).toEqual(['s1', 's2', 's3']);
  });

  it('produces a valid singleton group key for a session with no overlap partners', () => {
    const sessions = [s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z')];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].timeSlotGroupKey).toBe(computeTimeSlotGroupKey(['s1']));
  });

  it('includes mandatory sessions in grouping on the same basis as elective sessions', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z', true),
      s('s2', 'day-1', '2026-08-01T09:30:00Z', '2026-08-01T10:30:00Z', false),
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionIds.sort()).toEqual(['s1', 's2']);
  });
});
