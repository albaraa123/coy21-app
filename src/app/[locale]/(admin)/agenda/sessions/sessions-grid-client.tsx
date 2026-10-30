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
import type { BadgeVariant } from '@/components/ui/badge';
import { AgendaTimeGrid, type AgendaTimeGridColumn } from '@/components/schedule/agenda-time-grid';
import { AgendaColorLegend, type AgendaLegendItem } from '@/components/schedule/agenda-color-legend';

const MIN_MINUTE_HEIGHT_PX = 0.8;
const MAX_MINUTE_HEIGHT_PX = 3.2;
const STEP_PX = 0.4;
const DEFAULT_MINUTE_HEIGHT_PX = 1.6;

export interface SessionBlockData {
  id: string;
  roomId: string;
  blockColor: string;
  startTime: string;
  endTime: string;
  sessionCode: string;
  titleEn: string;
  statusLabel: string;
  statusVariant: BadgeVariant;
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
}: {
  dayGroups: DayGroupData[];
  /** True when more than one day group is present -- matches the original "only show the heading when there's more than one day" behavior. */
  showDayHeading: boolean;
  otherColumnLabel: string;
  zoomOutLabel: string;
  zoomInLabel: string;
  /** Real track id/name/color triples, for the color-key legend explaining what each block color means. */
  legendItems: AgendaLegendItem[];
}) {
  const [minuteHeightPx, setMinuteHeightPx] = useState(DEFAULT_MINUTE_HEIGHT_PX);

  return (
    <div className="flex flex-col gap-3">
      <AgendaColorLegend items={legendItems} />
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
    </div>
  );
}
