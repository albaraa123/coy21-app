// Pure layout math for the agenda time-grid (admin Sessions page, participant
// Browse Sessions page). No DOM, no React -- takes raw session rows, returns
// plain numbers a presentational component turns into CSS. Kept here, not
// inside the component, so it's independently unit-testable (same
// extract-the-decision-logic convention as scan-state-machine.ts).
//
// Column dimension is TRACK, not room: the real COY21 data has 13 distinct
// rooms (too many/no color) but only 5 tracks, each with a real color in
// tracks.color -- see the design doc (2026-10-31) for the full reasoning.
// Same-track overlapping sessions (confirmed live: up to 7 SDE sessions at
// once, different rooms) are laid out side-by-side within their track's
// column via greedy interval partitioning into "lanes", not stacked.
//
// All minute values are Europe/Istanbul wall-clock time, NOT UTC -- the
// venue (Antalya, Türkiye) is a fixed UTC+3 year-round (Turkey abolished
// DST in 2016). Found as a live production bug on 2026-10-31: a session
// stored as 05:00 UTC (= 08:00 Istanbul) was rendering on the grid at
// "5AM" because this module read raw UTC hours with no offset. Reuses the
// same fixed-offset constant as src/lib/datetime/conference-time.ts
// rather than inventing a second timezone-conversion strategy.

import { CONFERENCE_TIMEZONE_OFFSET_MS } from '@/lib/datetime/conference-time';

export interface GridInputSession {
  id: string;
  trackId: string;
  startTime: string; // ISO
  endTime: string; // ISO
}

export interface GridBlock {
  id: string;
  columnIndex: number;
  lane: number;
  laneCount: number;
  /** Minutes since midnight of the session's own date, for vertical positioning. */
  startMinutes: number;
  endMinutes: number;
}

export interface GridTrackColumn {
  trackId: string;
  columnIndex: number;
}

export interface GridLayout {
  tracks: GridTrackColumn[];
  blocks: GridBlock[];
  /** Minutes since midnight -- the actual min start / max end across all input sessions, NOT a fixed window. Undefined (both 0) when there are no valid blocks. */
  rangeStartMinutes: number;
  rangeEndMinutes: number;
}

function minutesSinceMidnightConferenceLocal(iso: string): number {
  const istanbulMs = new Date(iso).getTime() + CONFERENCE_TIMEZONE_OFFSET_MS;
  const d = new Date(istanbulMs);
  // Read UTC getters on the shifted timestamp -- same technique as
  // isoToConferenceLocalInputValue in conference-time.ts -- so no
  // additional (browser-local) timezone conversion layers on top of the
  // Istanbul shift already applied.
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Greedy interval partitioning: sorts by start time, assigns each session
 * the lowest-numbered lane whose most-recent occupant has already ended.
 * Standard algorithm for "minimum number of overlapping tracks needed" --
 * produces the same lane count as the true overlap-clique size for this
 * use case (real conference sessions: no session properly nests inside
 * another's time range in this dataset, and the algorithm's output is a
 * reasonable layout even in a theoretical nesting case).
 */
function assignLanes(sessions: { id: string; startMinutes: number; endMinutes: number }[]): Map<string, number> {
  const sorted = [...sessions].sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id));
  const laneEndTimes: number[] = []; // laneEndTimes[i] = end time of the last session placed in lane i
  const laneOf = new Map<string, number>();

  for (const sess of sorted) {
    let placedLane = -1;
    for (let i = 0; i < laneEndTimes.length; i++) {
      if (laneEndTimes[i] <= sess.startMinutes) {
        placedLane = i;
        break;
      }
    }
    if (placedLane === -1) {
      placedLane = laneEndTimes.length;
      laneEndTimes.push(sess.endMinutes);
    } else {
      laneEndTimes[placedLane] = sess.endMinutes;
    }
    laneOf.set(sess.id, placedLane);
  }

  return laneOf;
}

export function computeGridLayout(sessions: GridInputSession[]): GridLayout {
  const valid = sessions
    .map((s) => ({ ...s, startMinutes: minutesSinceMidnightConferenceLocal(s.startTime), endMinutes: minutesSinceMidnightConferenceLocal(s.endTime) }))
    .filter((s) => s.endMinutes > s.startMinutes);

  if (valid.length === 0) {
    return { tracks: [], blocks: [], rangeStartMinutes: 0, rangeEndMinutes: 0 };
  }

  // Track column order = first-seen order in the input (stable, deterministic
  // -- NOT alphabetical by trackId, so callers control display order by the
  // order they pass sessions in, e.g. pre-sorted by a tracks.display_order
  // if one exists).
  const trackOrder: string[] = [];
  for (const s of valid) {
    if (!trackOrder.includes(s.trackId)) trackOrder.push(s.trackId);
  }
  const columnIndexOf = new Map(trackOrder.map((id, i) => [id, i]));

  const blocks: GridBlock[] = [];
  for (const trackId of trackOrder) {
    const inTrack = valid.filter((s) => s.trackId === trackId);
    const laneOf = assignLanes(inTrack);
    const laneCount = new Set(laneOf.values()).size;
    for (const s of inTrack) {
      blocks.push({
        id: s.id,
        columnIndex: columnIndexOf.get(trackId)!,
        lane: laneOf.get(s.id)!,
        laneCount,
        startMinutes: s.startMinutes,
        endMinutes: s.endMinutes,
      });
    }
  }

  const rangeStartMinutes = Math.min(...valid.map((s) => s.startMinutes));
  const rangeEndMinutes = Math.max(...valid.map((s) => s.endMinutes));

  return {
    tracks: trackOrder.map((trackId, columnIndex) => ({ trackId, columnIndex })),
    blocks,
    rangeStartMinutes,
    rangeEndMinutes,
  };
}
