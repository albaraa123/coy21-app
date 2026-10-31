'use client';

// Client wrapper for the admin Sessions page's zoomable agenda grid.
// Extracted out of page.tsx specifically to fix a real production bug:
// the first version of the zoom feature passed a FUNCTION (a render-prop)
// as a child/prop from page.tsx (a Server Component) into a 'use client'
// zoom component -- that is not legal RSC composition (React/Next.js's
// Flight serializer cannot serialize a function value crossing the
// server/client boundary), and it broke in production ("Something went
// wrong" on /agenda/sessions) despite passing local typecheck/eslint,
// since neither catches this specific RSC rule. Same class of mistake
// app-shell.tsx's own header comment documents and avoids ("no function
// prop ever needs to cross the server/client boundary").
//
// Fix: page.tsx (still a Server Component) does ALL data fetching and
// ALL next-intl t() calls, then passes this component only plain,
// JSON-serializable data (dayGroups already carrying each session's
// pre-resolved translated status label and badge variant -- see
// SessionBlockData below) plus a handful of plain strings for labels.
// This component owns the zoom `useState` itself and defines its own
// `renderBlock` function INSIDE this client module -- that's legal,
// since a function defined and consumed entirely within one client
// component's own render never crosses any boundary; only a function
// VALUE passed as a prop INTO a component FROM OUTSIDE it (the original
// bug) is the illegal case.
import { useState } from 'react';
import { Link } from '@/i18n/routing';
import { Card } from '@/components/ui/card';
import type { BadgeVariant } from '@/components/ui/badge';
import { AgendaTimeGrid, type AgendaTimeGridColumn } from '@/components/schedule/agenda-time-grid';
import { AgendaColorLegend, type AgendaLegendItem } from '@/components/schedule/agenda-color-legend';
import { AgendaViewToggle } from '@/components/schedule/agenda-view-toggle';
import type { AgendaView } from '@/components/schedule/agenda-view-storage';
import { AgendaTrackFilterPills } from '@/components/schedule/agenda-track-filter-pills';
import { AgendaSearchBar } from '@/components/schedule/agenda-search-bar';
import { AgendaTimeline } from '@/components/schedule/agenda-timeline';

const ADMIN_SESSIONS_VIEW_STORAGE_KEY = 'coy21-admin-sessions-view-v1';

const MIN_MINUTE_HEIGHT_PX = 0.8;
const MAX_MINUTE_HEIGHT_PX = 3.2;
const STEP_PX = 0.4;
const DEFAULT_MINUTE_HEIGHT_PX = 1.6;

export interface SessionBlockData {
  id: string;
  roomId: string;
  /** The session's track id -- threaded through separately from blockColor
      so Timeline view's track-filter pills can match sessions by id (Grid
      view keys its columns by roomId instead, see `trackId: s.roomId` below
      in the AgendaTimeGrid mapping -- an unrelated, pre-existing use of the
      name "trackId" scoped to that render-prop call only, same convention
      already established in browse-grid-client.tsx). */
  trackId: string;
  blockColor: string;
  startTime: string;
  endTime: string;
  sessionCode: string;
  titleEn: string;
  statusLabel: string;
  statusVariant: BadgeVariant;
  /** True for a break/plenary "session" (session_types.code === 'BRK') --
      Timeline view renders these in a muted style with no status chip,
      never expandable or navigable. */
  isBreak: boolean;
  /** Locale-aware speaker full names (non-null only) -- used by Timeline
      view's search bar to match sessions by speaker in addition to title. */
  speakerNames: string[];
}

export interface DayGroupData {
  dayId: string;
  label: string;
  rooms: AgendaTimeGridColumn[];
  sessions: SessionBlockData[];
}

export function SessionsGridClient({
  dayGroups,
  showDayHeading,
  otherColumnLabel,
  zoomOutLabel,
  zoomInLabel,
  legendItems,
  gridViewLabel,
  timelineViewLabel,
  allTracksLabel,
  searchPlaceholder,
  resultCountSingularLabel,
  resultCountPluralLabel,
  timelineEmptyTitle,
  timelineEmptyDescription,
}: {
  dayGroups: DayGroupData[];
  /** True when more than one day group is present -- matches the original "only show the heading when there's more than one day" behavior. Grid view only; Timeline view always shows day tabs instead when more than one day group is present (see activeDayIndex below). */
  showDayHeading: boolean;
  otherColumnLabel: string;
  zoomOutLabel: string;
  zoomInLabel: string;
  /** Real track id/name/color triples, for the color-key legend explaining what each block color means (Grid view) and for Timeline view's track-filter pill options. */
  legendItems: AgendaLegendItem[];
  gridViewLabel: string;
  timelineViewLabel: string;
  allTracksLabel: string;
  searchPlaceholder: string;
  /** Pre-resolved noun strings ("session" / "sessions", locale-aware) --
      the count itself is only known client-side (post-filter), so this
      component composes the final "{n} {noun}" string itself, same
      resolved-strings-as-props shape as every other label on this page;
      t() itself (a function) can never cross into this 'use client'
      component. */
  resultCountSingularLabel: string;
  resultCountPluralLabel: string;
  /** Shown when Timeline view's track-filter/search narrows the active
      day's sessions to zero -- reuses the page's existing
      emptyTitle/emptyDescription i18n keys (already generically worded
      for "no sessions match the current filters", not "none exist at
      all") rather than adding new ones. Without this, filtering to
      zero on Timeline rendered nothing at all below the search bar --
      indistinguishable from a rendering bug (code review finding,
      2026-11-01). Mirrors AgendaTimeGrid's own emptyState prop /
      browse-grid-client.tsx's emptyDayLabel pattern. */
  timelineEmptyTitle: string;
  timelineEmptyDescription: string;
}) {
  const [minuteHeightPx, setMinuteHeightPx] = useState(DEFAULT_MINUTE_HEIGHT_PX);
  const [view, setView] = useState<AgendaView>('grid');
  const [activeDayIndex, setActiveDayIndex] = useState(0);
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Timeline-view-only state/derivation -- Grid view below keeps its
  // original unconditional .map() over every dayGroups entry, stacked,
  // completely untouched by any of this.
  const activeDayGroup = dayGroups[Math.min(activeDayIndex, dayGroups.length - 1)];

  const filteredSessions = activeDayGroup.sessions.filter((s) => {
    if (selectedTrackIds.size > 0 && !selectedTrackIds.has(s.trackId)) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const titleMatch = s.titleEn.toLowerCase().includes(q);
      const speakerMatch = s.speakerNames.some((n) => n.toLowerCase().includes(q));
      if (!titleMatch && !speakerMatch) return false;
    }
    return true;
  });

  const resultCountLabel = `${filteredSessions.length} ${filteredSessions.length === 1 ? resultCountSingularLabel : resultCountPluralLabel}`;

  return (
    <div className="flex flex-col gap-3">
      <AgendaColorLegend items={legendItems} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <AgendaViewToggle
          storageKey={ADMIN_SESSIONS_VIEW_STORAGE_KEY}
          view={view}
          onChange={setView}
          gridLabel={gridViewLabel}
          timelineLabel={timelineViewLabel}
        />

        {view === 'grid' ? (
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              aria-label={zoomOutLabel}
              disabled={minuteHeightPx <= MIN_MINUTE_HEIGHT_PX}
              onClick={() => setMinuteHeightPx((v) => Math.max(MIN_MINUTE_HEIGHT_PX, +(v - STEP_PX).toFixed(2)))}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-charcoal/20 text-sm font-semibold text-charcoal transition-colors hover:bg-charcoal/5 disabled:opacity-40 disabled:pointer-events-none dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              −
            </button>
            <button
              type="button"
              aria-label={zoomInLabel}
              disabled={minuteHeightPx >= MAX_MINUTE_HEIGHT_PX}
              onClick={() => setMinuteHeightPx((v) => Math.min(MAX_MINUTE_HEIGHT_PX, +(v + STEP_PX).toFixed(2)))}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-charcoal/20 text-sm font-semibold text-charcoal transition-colors hover:bg-charcoal/5 disabled:opacity-40 disabled:pointer-events-none dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              +
            </button>
          </div>
        ) : (
          <AgendaSearchBar
            value={query}
            onChange={setQuery}
            placeholder={searchPlaceholder}
            resultCountLabel={resultCountLabel}
          />
        )}
      </div>

      {view === 'timeline' && dayGroups.length > 1 && (
        <div role="tablist" className="flex gap-2 border-b border-charcoal/10 dark:border-gray-700">
          {dayGroups.map((dayGroup, i) => (
            <button
              key={dayGroup.dayId}
              type="button"
              role="tab"
              aria-selected={i === activeDayIndex}
              onClick={() => setActiveDayIndex(i)}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                i === activeDayIndex
                  ? 'border-b-2 border-turquoise text-turquoise'
                  : 'text-charcoal/60 hover:text-charcoal dark:text-gray-400'
              }`}
            >
              {dayGroup.label}
            </button>
          ))}
        </div>
      )}

      {view === 'timeline' && (
        <AgendaTrackFilterPills
          options={legendItems}
          selectedIds={selectedTrackIds}
          onToggle={(trackId) =>
            setSelectedTrackIds((cur) => {
              const next = new Set(cur);
              if (next.has(trackId)) next.delete(trackId);
              else next.add(trackId);
              return next;
            })
          }
          onClear={() => setSelectedTrackIds(new Set())}
          allLabel={allTracksLabel}
        />
      )}

      {view === 'timeline' ? (
        <AgendaTimeline
          sessions={filteredSessions.map((s) => ({
            id: s.id,
            startTime: s.startTime,
            endTime: s.endTime,
            isBreak: s.isBreak,
          }))}
          emptyState={
            <Card className="py-10 text-center text-sm text-charcoal/50 dark:text-gray-400">
              <p className="font-medium text-charcoal/70 dark:text-gray-300">{timelineEmptyTitle}</p>
              <p className="mt-1">{timelineEmptyDescription}</p>
            </Card>
          }
          renderCard={(sessionsInRow, isBreak) => {
            const bySessionId = new Map(filteredSessions.map((s) => [s.id, s]));
            return sessionsInRow.map((row) => {
              const s = bySessionId.get(row.id);
              if (!s) return null;
              const expanded = expandedId === s.id;
              return (
                <div
                  key={s.id}
                  role={isBreak ? undefined : 'button'}
                  tabIndex={isBreak ? undefined : 0}
                  onClick={isBreak ? undefined : () => setExpandedId((cur) => (cur === s.id ? null : s.id))}
                  className={
                    isBreak
                      ? 'flex-1 border-s-2 border-charcoal/20 py-1 ps-2 text-xs text-charcoal/50 dark:border-gray-700 dark:text-gray-500'
                      : 'flex min-w-[220px] flex-1 cursor-pointer flex-col gap-1 rounded-md border border-charcoal/10 bg-warm-white p-2 dark:border-gray-700 dark:bg-gray-900'
                  }
                >
                  {!isBreak && (
                    <span className="flex flex-wrap items-center justify-between gap-1">
                      <span className="flex items-center gap-1.5 text-[10px] font-medium text-charcoal/60 dark:text-gray-400">
                        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.blockColor }} />
                        {s.sessionCode}
                      </span>
                      {/* Fixed neutral chip, NOT pickReadableTextColor(blockColor) -- that function is correct for Grid
                          view's solid-track-colored blocks (a dark track color needs white text ON that color), but
                          this Timeline card has a light bg-warm-white background, not the track color. Reusing it
                          here produced near-invisible chips for dark tracks (e.g. Plenary's navy): the computed
                          white text paired with an 18%-white chip background both read as near-white-on-near-white
                          against the light card. A small status chip doesn't need per-track coloring -- fixed
                          neutral tokens (same family as Badge's 'neutral' variant) stay readable against every
                          track's card regardless of that track's color. */}
                      <span className="rounded bg-charcoal/10 px-1.5 py-0.5 text-[10px] font-medium text-charcoal/70 dark:bg-white/10 dark:text-gray-300">
                        {s.statusLabel}
                      </span>
                    </span>
                  )}
                  <span className="text-sm font-semibold">{s.titleEn}</span>
                  {expanded && !isBreak && s.speakerNames.length > 0 && (
                    <span className="text-xs text-charcoal/60 dark:text-gray-400">{s.speakerNames.join(', ')}</span>
                  )}
                </div>
              );
            });
          }}
        />
      ) : (
        <div className="flex flex-col gap-8">
          {dayGroups.map((dayGroup) => (
            <div key={dayGroup.dayId} className="flex flex-col gap-2">
              {showDayHeading && (
                <h2 className="text-sm font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{dayGroup.label}</h2>
              )}
              <AgendaTimeGrid
                minuteHeightPx={minuteHeightPx}
                columns={dayGroup.rooms}
                otherColumnLabel={otherColumnLabel}
                sessions={dayGroup.sessions.map((s) => ({
                  id: s.id,
                  trackId: s.roomId,
                  blockColor: s.blockColor,
                  startTime: s.startTime,
                  endTime: s.endTime,
                  sessionCode: s.sessionCode,
                  titleEn: s.titleEn,
                  statusLabel: s.statusLabel,
                  statusVariant: s.statusVariant,
                }))}
                renderBlock={(session, textColor) => (
                  <Link
                    href={`/agenda/sessions/${session.id}`}
                    className="flex h-full flex-col gap-1 p-1.5 text-start hover:brightness-95 focus-visible:outline-none focus-visible:ring-2"
                    style={{ color: textColor, outlineColor: textColor }}
                  >
                    <span className="flex flex-wrap items-center justify-between gap-1">
                      <span className="text-xs font-semibold">{session.sessionCode}</span>
                      {/* A small self-contained status chip instead of the shared Badge component: Badge's per-variant colors (e.g. neutral's charcoal-toned border/text) assume a light page background, not an arbitrary track color -- it would clash or go near-invisible on a dark block. This chip always derives its colors from the SAME computed textColor as the rest of the block, so it stays readable against any track color automatically. */}
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ backgroundColor: `color-mix(in srgb, ${textColor} 18%, transparent)`, color: textColor }}
                      >
                        {session.statusLabel}
                      </span>
                    </span>
                    {/* No `truncate` -- the full title always shows, wrapping
                        to multiple lines if needed, per explicit user
                        feedback that a cut-off title is worse than a taller
                        block (see agenda-time-grid.tsx's minHeightPx comment
                        for the matching layout-side change). */}
                    <span className="text-xs leading-snug">{session.titleEn}</span>
                  </Link>
                )}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
