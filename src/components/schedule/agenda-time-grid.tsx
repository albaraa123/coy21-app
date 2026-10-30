// src/components/schedule/agenda-time-grid.tsx
//
// Shared time-grid chrome for the admin Sessions page and the participant
// Browse Sessions page (see docs/superpowers/plans/2026-10-31-agenda-time-
// grid-design.md). Pure presentational: owns the grid layout (hour ruler,
// track-colored column headers, block positioning via computeGridLayout),
// never the business logic of what's INSIDE a block -- that's the
// `renderBlock` render-prop, so each page keeps its own booking-deadline/
// capacity/edit-link logic entirely in its own file.
//
// No 'use client': positions are computed server-side from plain data,
// same reasoning as MountReveal -- nothing here is interactive or needs a
// browser API.
import { computeGridLayout, type GridInputSession } from '@/lib/schedule/grid-layout';

export interface AgendaTimeGridTrack {
  id: string;
  name: string;
  color: string;
}

export interface AgendaTimeGridSession extends GridInputSession {
  trackId: string;
}

// Pixel constants: one place to tune the grid's density. MINUTE_HEIGHT_PX
// chosen so the real data's tightest block (15 min, e.g. a coffee break)
// stays tall enough to read a title in -- see design doc's real-session
// table (several 15/45-min blocks exist).
const MINUTE_HEIGHT_PX = 1.6;
const HEADER_HEIGHT_PX = 44;
const HOUR_LABEL_WIDTH_PX = 56;

function formatHourLabel(minutesSinceMidnight: number): string {
  const h = Math.floor(minutesSinceMidnight / 60) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}${suffix}`;
}

export function AgendaTimeGrid<TSession extends AgendaTimeGridSession>({
  tracks,
  sessions,
  renderBlock,
  emptyState,
}: {
  /** Every track that should get a column, in display order -- even one with zero sessions (renders an empty column, not omitted), so the grid's column set stays stable across filtering. */
  tracks: AgendaTimeGridTrack[];
  sessions: TSession[];
  renderBlock: (session: TSession) => React.ReactNode;
  /** Shown instead of the grid when `sessions` is empty. */
  emptyState?: React.ReactNode;
}) {
  if (sessions.length === 0) {
    return emptyState ?? null;
  }

  // Plan-review fix (round 1): a session whose trackId is NOT present in
  // the `tracks` prop (stale/renamed track_id, or a race between the
  // tracks query and the sessions query) must never silently vanish from
  // the grid with no column to render into -- that's a real correctness
  // bug for an admin page whose entire point is seeing every session.
  // Partition up front and render unknowns into a synthetic trailing
  // "Other" column rather than dropping them.
  const knownTrackIds = new Set(tracks.map((t) => t.id));
  const knownSessions = sessions.filter((s) => knownTrackIds.has(s.trackId));
  const unknownSessions = sessions.filter((s) => !knownTrackIds.has(s.trackId));

  const UNKNOWN_TRACK_ID = '__unknown__';
  const effectiveTracks: AgendaTimeGridTrack[] =
    unknownSessions.length > 0 ? [...tracks, { id: UNKNOWN_TRACK_ID, name: 'Other', color: '#6b7280' }] : tracks;
  // IMPORTANT: this remapped-trackId array is used ONLY to drive
  // computeGridLayout's column/lane assignment -- sessionById below maps
  // back to the ORIGINAL (unmutated) session objects, so renderBlock(s)
  // always receives the caller's real data, never a session with a
  // fabricated trackId grafted onto it.
  const layoutInputSessions: TSession[] =
    unknownSessions.length > 0 ? [...knownSessions, ...unknownSessions.map((s) => ({ ...s, trackId: UNKNOWN_TRACK_ID }))] : knownSessions;

  // Re-order sessions so first-seen track order in computeGridLayout matches
  // the CALLER's tracks array order (not insertion order of `sessions`),
  // so column order is controlled by the explicit `tracks` prop, not by
  // which session happens to appear first in the data. indexOf is always
  // >= 0 here now since layoutInputSessions only ever contains trackIds
  // present in effectiveTracks (the unknown bucket included).
  const trackIdOrder = effectiveTracks.map((t) => t.id);
  const orderedSessions = [...layoutInputSessions].sort((a, b) => trackIdOrder.indexOf(a.trackId) - trackIdOrder.indexOf(b.trackId));
  const tracksToRender = effectiveTracks;

  const layout = computeGridLayout(orderedSessions);
  const blockById = new Map(layout.blocks.map((b) => [b.id, b]));
  // Maps id -> the ORIGINAL session (from the `sessions` prop, pre-remap),
  // so renderBlock never sees the synthetic __unknown__ trackId.
  const originalSessionById = new Map(sessions.map((s) => [s.id, s]));
  const trackById = new Map(effectiveTracks.map((t) => [t.id, t]));

  const totalMinutes = Math.max(layout.rangeEndMinutes - layout.rangeStartMinutes, 60);
  const gridHeightPx = totalMinutes * MINUTE_HEIGHT_PX;

  // Hour marks at the top of every hour within range, plus the exact start.
  const hourMarks: number[] = [];
  const firstHour = Math.ceil(layout.rangeStartMinutes / 60) * 60;
  for (let m = firstHour; m <= layout.rangeEndMinutes; m += 60) hourMarks.push(m);

  return (
    <div className="overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `${HOUR_LABEL_WIDTH_PX}px repeat(${tracksToRender.length}, minmax(180px, 1fr))`,
        }}
      >
        {/* Header row: blank corner + one colored header per track (plus a trailing "Other" column if any session had an unrecognized trackId -- see the knownTrackIds/unknownSessions split above). */}
        <div className="sticky top-0 z-10 border-b border-charcoal/10 bg-warm-white dark:border-gray-700 dark:bg-gray-900" style={{ height: HEADER_HEIGHT_PX }} />
        {tracksToRender.map((track) => (
          <div
            key={track.id}
            className="sticky top-0 z-10 flex items-center gap-2 border-b border-s border-charcoal/10 bg-warm-white px-3 text-sm font-semibold text-charcoal dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            style={{ height: HEADER_HEIGHT_PX }}
          >
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: track.color }} />
            <span className="truncate">{track.name}</span>
          </div>
        ))}

        {/* Hour-label column. */}
        <div className="relative border-e border-charcoal/10 dark:border-gray-700" style={{ height: gridHeightPx }}>
          {hourMarks.map((m) => (
            <div
              key={m}
              className="absolute start-0 w-full -translate-y-1/2 pe-2 text-end text-xs text-charcoal/50 dark:text-gray-500"
              style={{ top: (m - layout.rangeStartMinutes) * MINUTE_HEIGHT_PX }}
            >
              {formatHourLabel(m)}
            </div>
          ))}
        </div>

        {/* One column per track, each holding its own absolutely-positioned blocks. */}
        {tracksToRender.map((track) => (
          <div key={track.id} className="relative border-s border-charcoal/10 dark:border-gray-700" style={{ height: gridHeightPx }}>
            {/* Hour gridlines, purely decorative. */}
            {hourMarks.map((m) => (
              <div
                key={m}
                aria-hidden="true"
                className="absolute start-0 w-full border-t border-charcoal/5 dark:border-gray-800"
                style={{ top: (m - layout.rangeStartMinutes) * MINUTE_HEIGHT_PX }}
              />
            ))}

            {orderedSessions
              .filter((s) => s.trackId === track.id)
              .map((s) => {
                const block = blockById.get(s.id);
                if (!block) return null;
                const topPx = (block.startMinutes - layout.rangeStartMinutes) * MINUTE_HEIGHT_PX;
                const heightPx = Math.max((block.endMinutes - block.startMinutes) * MINUTE_HEIGHT_PX, 20);
                const widthPct = 100 / block.laneCount;
                return (
                  <div
                    key={s.id}
                    className="absolute overflow-hidden rounded-md"
                    style={{
                      top: topPx,
                      height: heightPx,
                      insetInlineStart: `${block.lane * widthPct}%`,
                      width: `calc(${widthPct}% - 2px)`,
                      backgroundColor: trackById.get(s.trackId)?.color ?? '#6b7280',
                    }}
                  >
                    {renderBlock(originalSessionById.get(s.id)!)}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
