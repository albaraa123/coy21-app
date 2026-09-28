// src/lib/allocation/time-slot-grouping.ts
import { createHash } from 'crypto';

export interface SessionForGrouping {
  id: string;
  conferenceDayId: string;
  startTime: string; // ISO timestamptz
  endTime: string;
  isMandatory: boolean;
}

export interface TimeSlotGroup {
  timeSlotGroupKey: string;
  sessionIds: string[];
}

// Spec: Allocation Algorithm step 2. Sort session ids lexicographically,
// join with ',', SHA-256, hex-encode. Pure and order-independent so the
// same session-id set always yields the same key regardless of discovery
// order — required for reproducibility and for safety as the unique-
// constraint key in allocation_assignments.
export function computeTimeSlotGroupKey(sessionIds: string[]): string {
  const sorted = [...sessionIds].sort();
  return createHash('sha256').update(sorted.join(','), 'utf8').digest('hex');
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  // Half-open [start, end) overlap, matching sessions_room_no_overlap's
  // tstzrange(start_time, end_time, '[)') semantics.
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

// Connected components over time-overlap, scoped per conference_day_id.
// Includes mandatory sessions on the same basis as elective ones — grouping
// only needs day + time range, not the mandatory flag (spec step 2).
export function groupSessionsIntoTimeSlots(sessions: SessionForGrouping[]): TimeSlotGroup[] {
  const byDay = new Map<string, SessionForGrouping[]>();
  for (const s of sessions) {
    if (!byDay.has(s.conferenceDayId)) byDay.set(s.conferenceDayId, []);
    byDay.get(s.conferenceDayId)!.push(s);
  }

  const groups: TimeSlotGroup[] = [];

  for (const daySessions of byDay.values()) {
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
      return parent.get(id)!;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const s of daySessions) parent.set(s.id, s.id);

    for (let i = 0; i < daySessions.length; i++) {
      for (let j = i + 1; j < daySessions.length; j++) {
        if (rangesOverlap(daySessions[i].startTime, daySessions[i].endTime, daySessions[j].startTime, daySessions[j].endTime)) {
          union(daySessions[i].id, daySessions[j].id);
        }
      }
    }

    const componentMembers = new Map<string, string[]>();
    for (const s of daySessions) {
      const root = find(s.id);
      if (!componentMembers.has(root)) componentMembers.set(root, []);
      componentMembers.get(root)!.push(s.id);
    }

    for (const sessionIds of componentMembers.values()) {
      groups.push({ timeSlotGroupKey: computeTimeSlotGroupKey(sessionIds), sessionIds });
    }
  }

  return groups;
}
