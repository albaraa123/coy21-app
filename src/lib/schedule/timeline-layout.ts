// Pure layout logic for the agenda vertical-timeline view (admin Sessions
// page, participant Browse Sessions page). Mirrors grid-layout.ts's
// conventions (no DOM, no React, independently unit-testable) but produces
// rows for a vertical list instead of pixel-positioned blocks -- this view
// has no lane-packing/overlap concern since rows aren't positioned by
// duration, only grouped by identical start time and ordered.
//
// PRECONDITION: callers MUST pre-filter input to a single conference day
// before calling this function. minutesSinceMidnightConferenceLocal
// (reused from grid-layout.ts's already-fixed Europe/Istanbul conversion)
// returns minutes-since-midnight with NO date component -- two sessions on
// DIFFERENT days at the same wall-clock time (e.g. both at 08:00 Istanbul)
// would produce identical startMinutes and incorrectly group into one row
// if passed together. Both real call sites (sessions-grid-client.tsx,
// browse-grid-client.tsx) already scope their Timeline input to one active
// day via activeDayIndex/activeIndex state before calling this function.
// This function has no day/date field in its input shape and cannot detect
// a caller's mistake, so this precondition is enforced by caller
// discipline, not runtime validation.

import { CONFERENCE_TIMEZONE_OFFSET_MS } from '@/lib/datetime/conference-time';

export interface TimelineInputSession {
  id: string;
  startTime: string; // ISO
  endTime: string; // ISO
  isBreak: boolean;
}

export interface TimelineRow {
  /** Minutes since midnight, Europe/Istanbul wall-clock time. */
  startMinutes: number;
  /** Session ids sharing this exact start time, in input order. */
  sessionIds: string[];
  /** True when every session in this row is a break. */
  isBreak: boolean;
}

function minutesSinceMidnightConferenceLocal(iso: string): number {
  // Fixed +3h UTC offset -- see conference-time.ts for the full
  // "Turkey has no DST since 2016" rationale. Imported, not redeclared, so a
  // future DST/offset change only needs one edit.
  const istanbulMs = new Date(iso).getTime() + CONFERENCE_TIMEZONE_OFFSET_MS;
  const d = new Date(istanbulMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function computeTimelineLayout(sessions: TimelineInputSession[]): TimelineRow[] {
  const valid = sessions
    .map((s) => ({ ...s, startMinutes: minutesSinceMidnightConferenceLocal(s.startTime), endMinutes: minutesSinceMidnightConferenceLocal(s.endTime) }))
    .filter((s) => s.endMinutes > s.startMinutes);

  const byStart = new Map<number, typeof valid>();
  for (const s of valid) {
    if (!byStart.has(s.startMinutes)) byStart.set(s.startMinutes, []);
    byStart.get(s.startMinutes)!.push(s);
  }

  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startMinutes, group]) => ({
      startMinutes,
      sessionIds: group.map((s) => s.id),
      isBreak: group.every((s) => s.isBreak),
    }));
}
