// src/components/schedule/agenda-timeline.tsx
//
// Shared vertical-timeline chrome for the admin Sessions page and the
// participant Browse Sessions page, alongside AgendaTimeGrid (the original
// grid view). Pure presentational: groups sessions into timeline rows via
// computeTimelineLayout, renders the hour axis and row structure, never
// the business logic of what's INSIDE a card -- that's the `renderCard`
// render-prop, same separation of concerns as AgendaTimeGrid's
// `renderBlock`.
//
// No 'use client': positions/grouping are computed from plain data, same
// reasoning as AgendaTimeGrid and MountReveal -- nothing here is
// interactive or needs a browser API.
//
// RTL: hour labels sit at the inline-start edge via logical CSS properties
// (start-0, border-e, pe-2, text-end) -- NEVER left/right/ms-/me- physical
// utilities -- matching agenda-time-grid.tsx's own convention, since this
// app supports Arabic as a locale.
import { computeTimelineLayout, type TimelineInputSession } from '@/lib/schedule/timeline-layout';

// Caller-defined shape carried through untouched to renderCard -- this
// component never reads session fields beyond TimelineInputSession's
// id/startTime/endTime/isBreak.
export type AgendaTimelineSession = TimelineInputSession;

const HOUR_LABEL_WIDTH_PX = 56;

function defaultFormatHourLabel(minutesSinceMidnight: number): string {
  const h = Math.floor(minutesSinceMidnight / 60) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}${suffix}`;
}

export function AgendaTimeline<TSession extends AgendaTimelineSession>({
  sessions,
  renderCard,
  emptyState,
  formatHourLabel = defaultFormatHourLabel,
}: {
  /** Must already be scoped to a single conference day -- see
      timeline-layout.ts's header comment for why. */
  sessions: TSession[];
  /** `sessionsInRow` are the original (untouched) session objects sharing
      this row's start time, in input order -- a caller renders one card
      per entry, laid out side-by-side (flex-wrap) for concurrent sessions. */
  renderCard: (sessionsInRow: TSession[], isBreak: boolean) => React.ReactNode;
  emptyState?: React.ReactNode;
  formatHourLabel?: (minutesSinceMidnight: number) => string;
}) {
  if (sessions.length === 0) {
    return emptyState ?? null;
  }

  const rows = computeTimelineLayout(sessions);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  return (
    <div className="flex flex-col divide-y divide-charcoal/10 rounded-lg border border-charcoal/10 dark:divide-gray-700 dark:border-gray-700">
      {rows.map((row) => {
        const rowSessions = row.sessionIds.map((id) => sessionById.get(id)!).filter(Boolean);
        return (
          <div key={row.startMinutes} className="flex gap-3 p-3">
            <div className="shrink-0 text-end text-xs text-charcoal/50 dark:text-gray-500" style={{ width: HOUR_LABEL_WIDTH_PX, paddingInlineEnd: 8 }}>
              {formatHourLabel(row.startMinutes)}
            </div>
            <div className="flex flex-1 flex-wrap gap-2">
              {renderCard(rowSessions, row.isBreak)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
