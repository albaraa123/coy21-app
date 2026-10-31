// tests/schedule/timeline-layout.test.ts
import { describe, expect, it } from 'vitest';
import { computeTimelineLayout, type TimelineInputSession } from '@/lib/schedule/timeline-layout';
import { CONFERENCE_TIMEZONE_OFFSET_MS } from '@/lib/datetime/conference-time';

// start/end written as Europe/Istanbul wall-clock time, converted to the
// UTC instant actually stored in the DB -- same helper convention as
// tests/schedule/grid-layout.test.ts.
const s = (id: string, start: string, end: string, isBreak = false): TimelineInputSession => {
  const toUtcIso = (hhmm: string) => new Date(new Date(`2026-11-05T${hhmm}:00Z`).getTime() - CONFERENCE_TIMEZONE_OFFSET_MS).toISOString();
  return { id, startTime: toUtcIso(start), endTime: toUtcIso(end), isBreak };
};

describe('computeTimelineLayout', () => {
  it('returns an empty array for an empty session list', () => {
    expect(computeTimelineLayout([])).toEqual([]);
  });

  it('sorts sessions into ascending-start-time rows', () => {
    const rows = computeTimelineLayout([s('b', '10:00', '11:00'), s('a', '08:00', '09:00')]);
    expect(rows.map((r) => r.startMinutes)).toEqual([8 * 60, 10 * 60]);
    expect(rows[0].sessionIds).toEqual(['a']);
    expect(rows[1].sessionIds).toEqual(['b']);
  });

  it('groups sessions sharing the exact same start time into one row', () => {
    const rows = computeTimelineLayout([
      s('a', '10:00', '10:45'),
      s('b', '10:00', '10:30'),
      s('c', '10:15', '11:00'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].startMinutes).toBe(10 * 60);
    expect(new Set(rows[0].sessionIds)).toEqual(new Set(['a', 'b']));
    expect(rows[1].startMinutes).toBe(10 * 60 + 15);
    expect(rows[1].sessionIds).toEqual(['c']);
  });

  it('converts UTC input to Europe/Istanbul wall-clock minutes (regression for the grid-layout.ts timezone fix, same bug class)', () => {
    const rows = computeTimelineLayout([
      { id: 'reg', startTime: '2026-11-05T05:00:00+00:00', endTime: '2026-11-05T06:00:00+00:00', isBreak: false },
    ]);
    expect(rows[0].startMinutes).toBe(8 * 60);
  });

  it('marks a row isBreak=true only when every session in it is a break (real data never mixes break + non-break at the same start time, but the function must have a defined rule)', () => {
    const rows = computeTimelineLayout([s('brk', '10:00', '10:15', true)]);
    expect(rows[0].isBreak).toBe(true);
  });

  it('a zero-duration or inverted session (end <= start) is dropped, not NaN-crashed', () => {
    const rows = computeTimelineLayout([s('a', '10:00', '10:00'), s('b', '11:00', '10:30')]);
    expect(rows).toEqual([]);
  });
});
