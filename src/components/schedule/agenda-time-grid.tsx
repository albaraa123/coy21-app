// src/components/schedule/agenda-time-grid.tsx
//
// Shared time-grid chrome for the admin Sessions page and the participant
// Browse Sessions page (see docs/superpowers/plans/2026-10-31-agenda-time-
// grid-design.md). Pure presentational: owns the grid layout (hour ruler,
// column headers, block positioning via computeGridLayout), never the
// business logic of what's INSIDE a block -- that's the `renderBlock`
// render-prop, so each page keeps its own booking-deadline/capacity/edit-
// link logic entirely in its own file.
//
// Columns vs. color (2026-11-01 change): originally the column grouping
// key WAS the track (5 tracks = 5 columns), and a block's color was
// simply its column's color. Real usage feedback asked for columns to be
// ROOMS instead (13 rooms = 13 columns, matching the physical venue
// layout people actually think in) while still color-coding each block
// by its TRACK. computeGridLayout (grid-layout.ts) was always generic --
// it groups by an opaque `trackId: string` key with no semantic
// knowledge of what that key represents -- so no change was needed
// there; this component now takes a separate `columns` prop (the
// grouping/header dimension, generic `id`+`name`, no color of its own)
// and a per-session `blockColor` field (what tints that one block),
// decoupling "which column do I sit in" from "what color am I". Grid-
// layout's `trackId` field is fed `columnId` values now -- the name is a
// leftover from the track-only design and is intentionally NOT renamed
// in grid-layout.ts itself (a pure, already-tested, already-generic
// module -- renaming its one field is cosmetic churn with no behavior
// change, left alone to avoid touching tested code for no functional
// reason).
//
// No 'use client': positions are computed server-side from plain data,
// same reasoning as MountReveal -- nothing here is interactive or needs a
// browser API.
import { computeGridLayout, type GridInputSession } from '@/lib/schedule/grid-layout';
import { pickReadableTextColor } from '@/lib/schedule/readable-text-color';

export interface AgendaTimeGridColumn {
  id: string;
  name: string;
}

export interface AgendaTimeGridSession extends GridInputSession {
  /** Which column (e.g. room) this session's block sits in -- maps to grid-layout.ts's trackId grouping key, name unchanged there, see module header comment. */
  trackId: string;
  /** What color tints this block (e.g. the session's track color) -- independent of which column it's placed in. */
  blockColor: string;
}

// Pixel constants: one place to tune the grid's density. MINUTE_HEIGHT_PX
// chosen so the real data's tightest block (15 min, e.g. a coffee break)
// stays tall enough to read a title in -- see design doc's real-session
// table (several 15/45-min blocks exist).
const MINUTE_HEIGHT_PX = 1.6;
const HEADER_HEIGHT_PX = 44;
const HOUR_LABEL_WIDTH_PX = 56;

// Default hour-label formatter: hardcoded English AM/PM. This component has
// no 'use client' and no next-intl dependency (next-intl's getTranslations
// is async, and this component is intentionally synchronous), so it cannot
// localize this itself -- callers that need locale-aware hour formatting
// should pass their own `formatHourLabel` prop (e.g. backed by next-intl's
// t() from their own Server Component scope).
function defaultFormatHourLabel(minutesSinceMidnight: number): string {
  const h = Math.floor(minutesSinceMidnight / 60) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}${suffix}`;
}

export function AgendaTimeGrid<TSession extends AgendaTimeGridSession>({
  columns,
  sessions,
  renderBlock,
  emptyState,
  otherColumnLabel = 'Other',
  formatHourLabel = defaultFormatHourLabel,
  minuteHeightPx = MINUTE_HEIGHT_PX,
}: {
  /** Every column (e.g. room) that should render, in display order -- even one with zero sessions (renders an empty column, not omitted), so the column set stays stable across filtering. */
  columns: AgendaTimeGridColumn[];
  sessions: TSession[];
  /** `textColor` is computed automatically from `session.blockColor` via real contrast math (readable-text-color.ts) -- white or dark, whichever is more readable against that exact background. Forward it into the block's text classes/inline style instead of hardcoding text-white, since only 1 of this project's 5 real track colors actually passes contrast with white text (see readable-text-color.ts's header comment). */
  renderBlock: (session: TSession, textColor: string) => React.ReactNode;
  /** Shown instead of the grid when `sessions` is empty. */
  emptyState?: React.ReactNode;
  /** Display name for the synthetic trailing column that catches sessions whose trackId isn't in `columns`. Defaults to English "Other"; pass a locale-aware string (e.g. via next-intl's t() in the caller's own Server Component scope) to localize it -- this component has no i18n library dependency of its own. */
  otherColumnLabel?: string;
  /** Formats a minutes-since-midnight value into an hour-ruler label. Defaults to a hardcoded English AM/PM implementation; pass a locale-aware formatter (e.g. backed by next-intl's t()) to override it. */
  formatHourLabel?: (minutesSinceMidnight: number) => string;
  /** Pixels of vertical space per minute -- the zoom/density dial. Defaults to the original constant; a caller wanting a user-adjustable zoom control (see AgendaTimeGridZoom) passes a state value here instead. */
  minuteHeightPx?: number;
}) {
  if (sessions.length === 0) {
    return emptyState ?? null;
  }

  // Plan-review fix (round 1, still applies after the columns-vs-track
  // split): a session whose trackId is NOT present in the `columns` prop
  // (stale/renamed id, or a race between the columns query and the
  // sessions query) must never silently vanish from the grid with no
  // column to render into -- that's a real correctness bug for an admin
  // page whose entire point is seeing every session. Partition up front
  // and render unknowns into a synthetic trailing "Other" column rather
  // than dropping them.
  const knownColumnIds = new Set(columns.map((c) => c.id));
  const knownSessions = sessions.filter((s) => knownColumnIds.has(s.trackId));
  const unknownSessions = sessions.filter((s) => !knownColumnIds.has(s.trackId));

  const UNKNOWN_COLUMN_ID = '__unknown__';
  const effectiveColumns: AgendaTimeGridColumn[] =
    unknownSessions.length > 0 ? [...columns, { id: UNKNOWN_COLUMN_ID, name: otherColumnLabel }] : columns;
  // IMPORTANT: this remapped-trackId array is used ONLY to drive
  // computeGridLayout's column/lane assignment -- originalSessionById
  // below maps back to the ORIGINAL (unmutated) session objects, so
  // renderBlock(s) always receives the caller's real data, never a
  // session with a fabricated trackId grafted onto it.
  const layoutInputSessions: TSession[] =
    unknownSessions.length > 0 ? [...knownSessions, ...unknownSessions.map((s) => ({ ...s, trackId: UNKNOWN_COLUMN_ID }))] : knownSessions;

  // Re-order sessions so first-seen column order in computeGridLayout
  // matches the CALLER's columns array order (not insertion order of
  // `sessions`), so column order is controlled by the explicit `columns`
  // prop, not by which session happens to appear first in the data.
  // indexOf is always >= 0 here now since layoutInputSessions only ever
  // contains ids present in effectiveColumns (the unknown bucket included).
  const columnIdOrder = effectiveColumns.map((c) => c.id);
  const orderedSessions = [...layoutInputSessions].sort((a, b) => columnIdOrder.indexOf(a.trackId) - columnIdOrder.indexOf(b.trackId));
  const columnsToRender = effectiveColumns;

  const layout = computeGridLayout(orderedSessions);
  const blockById = new Map(layout.blocks.map((b) => [b.id, b]));
  // Maps id -> the ORIGINAL session (from the `sessions` prop, pre-remap),
  // so renderBlock never sees the synthetic __unknown__ column id.
  const originalSessionById = new Map(sessions.map((s) => [s.id, s]));

  const totalMinutes = Math.max(layout.rangeEndMinutes - layout.rangeStartMinutes, 60);
  const gridHeightPx = totalMinutes * minuteHeightPx;

  // Hour marks at the top of every hour within range, plus the exact start.
  const hourMarks: number[] = [];
  const firstHour = Math.ceil(layout.rangeStartMinutes / 60) * 60;
  for (let m = firstHour; m <= layout.rangeEndMinutes; m += 60) hourMarks.push(m);

  return (
    <div className="overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `${HOUR_LABEL_WIDTH_PX}px repeat(${columnsToRender.length}, minmax(140px, 1fr))`,
        }}
      >
        {/* Header row: blank corner + one header per column (room name; plus a trailing "Other" column if any session had an unrecognized trackId -- see the knownColumnIds/unknownSessions split above). No color dot here -- color now lives on each block via its own blockColor, not on the column/header, since a column (room) can host sessions from several different-colored tracks. */}
        {/* `sticky top-0` here assumes vertical scroll happens on a page-level ancestor, not this div (which only scrolls horizontally via overflow-x-auto) -- if headers don't visually stick once rendered, check for an unexpected overflow-y constraint between this component and the page body. */}
        <div className="sticky top-0 z-10 border-b border-charcoal/10 bg-warm-white dark:border-gray-700 dark:bg-gray-900" style={{ height: HEADER_HEIGHT_PX }} />
        {columnsToRender.map((column) => (
          <div
            key={column.id}
            className="sticky top-0 z-10 flex items-center border-b border-s border-charcoal/10 bg-warm-white px-3 text-sm font-semibold text-charcoal dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            style={{ height: HEADER_HEIGHT_PX }}
          >
            <span className="truncate">{column.name}</span>
          </div>
        ))}

        {/* Hour-label column. */}
        <div className="relative border-e border-charcoal/10 dark:border-gray-700" style={{ height: gridHeightPx }}>
          {hourMarks.map((m) => (
            <div
              key={m}
              className="absolute start-0 w-full -translate-y-1/2 pe-2 text-end text-xs text-charcoal/50 dark:text-gray-500"
              style={{ top: (m - layout.rangeStartMinutes) * minuteHeightPx }}
            >
              {formatHourLabel(m)}
            </div>
          ))}
        </div>

        {/* One column per room, each holding its own absolutely-positioned blocks. */}
        {columnsToRender.map((column) => (
          <div key={column.id} className="relative border-s border-charcoal/10 dark:border-gray-700" style={{ height: gridHeightPx }}>
            {/* Hour gridlines, purely decorative. */}
            {hourMarks.map((m) => (
              <div
                key={m}
                aria-hidden="true"
                className="absolute start-0 w-full border-t border-charcoal/5 dark:border-gray-800"
                style={{ top: (m - layout.rangeStartMinutes) * minuteHeightPx }}
              />
            ))}

            {orderedSessions
              .filter((s) => s.trackId === column.id)
              .map((s) => {
                const block = blockById.get(s.id);
                if (!block) return null;
                const topPx = (block.startMinutes - layout.rangeStartMinutes) * minuteHeightPx;
                // minHeightPx (not a fixed height) + no overflow-hidden,
                // per explicit user feedback: a short time slot's block
                // must still show its FULL title even if that means
                // growing visually taller than its actual time-slot
                // duration (wrapping to 2+ lines), rather than truncating
                // with an ellipsis. z-index rises on hover so an
                // overgrown block's text is never clipped behind its
                // neighbor below it while being read.
                const minHeightPx = Math.max((block.endMinutes - block.startMinutes) * minuteHeightPx, 20);
                const widthPct = 100 / block.laneCount;
                const original = originalSessionById.get(s.id)!;
                const blockColor = original.blockColor ?? '#6b7280';
                const textColor = pickReadableTextColor(blockColor);
                return (
                  <div
                    key={s.id}
                    className="group absolute z-0 rounded-md shadow-sm hover:z-20 hover:shadow-md"
                    style={{
                      top: topPx,
                      minHeight: minHeightPx,
                      insetInlineStart: `${block.lane * widthPct}%`,
                      width: `calc(${widthPct}% - 2px)`,
                      backgroundColor: blockColor,
                    }}
                  >
                    {renderBlock(original, textColor)}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
