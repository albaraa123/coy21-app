'use client';

// Client wrapper for the participant Browse Sessions page's day-tabs +
// zoomable agenda grid. Extracted out of page.tsx specifically to fix a
// real production bug found on the admin Sessions page's own equivalent
// (see sessions-grid-client.tsx's header comment for the full story):
// a function value (a render-prop) can never be passed as a prop from a
// Server Component into a 'use client' component -- it is not legal RSC
// composition and breaks in production despite passing local typecheck.
//
// This bug also existed, unexercised, in the original DayTabs component
// (children: (activeDay) => ReactNode, called from this Server Component
// page) -- it never actually fired in production because all real
// sessions are currently status='draft' and this page only shows
// published/confirmed ones, so byDay was always empty and DayTabs never
// rendered its function-children against real data. Found and fixed here
// alongside the zoom bug rather than left as a landmine for the day real
// sessions get confirmed.
//
// Fix: page.tsx (still a Server Component) does ALL data fetching and
// precomputes every per-session boolean/value these controls need
// (isFull, isPastDeadline, isWaitlisted, bookedCount, etc. -- all of
// which only depend on data already available server-side: countMap,
// globalDeadline, now), then hands this component only plain,
// JSON-serializable data (BrowseDayData[] with pre-resolved
// SessionBlockData per session). This component owns BOTH the active-
// day-tab state and the zoom state itself, and defines its own
// renderBlock function INSIDE this client module (legal -- see
// sessions-grid-client.tsx's header comment for why a function defined
// and consumed entirely within one client component's own render never
// crosses any boundary).
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { BookButton, WaitlistButton } from '../booking-button';
import { AgendaTimeGrid, type AgendaTimeGridColumn } from '@/components/schedule/agenda-time-grid';

const MIN_MINUTE_HEIGHT_PX = 0.8;
const MAX_MINUTE_HEIGHT_PX = 3.2;
const STEP_PX = 0.4;
const DEFAULT_MINUTE_HEIGHT_PX = 1.6;

export interface BrowseSessionBlockData {
  id: string;
  roomId: string;
  blockColor: string;
  startTime: string;
  endTime: string;
  title: string;
  /** True when this session is already booked by the caller -- renders a static "Booked" state, no button. */
  alreadyBooked: boolean;
  /** True when the caller should see a WaitlistButton instead of a BookButton (full + waitlist-enabled + (already on the waitlist OR still before deadline) -- see the original inline comment this precomputation replaces, preserved below at the render-prop call site). */
  showWaitlistButton: boolean;
  isWaitlisted: boolean;
  isFull: boolean;
  isPastDeadline: boolean;
}

export interface BrowseDayData {
  date: string;
  labelEn: string;
  labelAr: string;
  rooms: AgendaTimeGridColumn[];
  sessions: BrowseSessionBlockData[];
}

export function BrowseGridClient({
  days,
  locale,
  emptyDayLabel,
  otherColumnLabel,
  zoomOutLabel,
  zoomInLabel,
}: {
  days: BrowseDayData[];
  locale: string;
  /** Shown when the active day has zero sessions (e.g. after filtering) -- mirrors AgendaTimeGrid's own emptyState prop, but resolved to a plain string here since JSX built server-side can't cross into this client component either. */
  emptyDayLabel: string;
  otherColumnLabel: string;
  zoomOutLabel: string;
  zoomInLabel: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [minuteHeightPx, setMinuteHeightPx] = useState(DEFAULT_MINUTE_HEIGHT_PX);

  if (days.length === 0) return null;
  const activeDay = days[Math.min(activeIndex, days.length - 1)];

  return (
    <div className="flex flex-col gap-4">
      {days.length > 1 && (
        <div role="tablist" className="flex gap-2 border-b border-charcoal/10 dark:border-gray-700">
          {days.map((day, i) => (
            <button
              key={day.date}
              type="button"
              role="tab"
              aria-selected={i === activeIndex}
              onClick={() => setActiveIndex(i)}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                i === activeIndex
                  ? 'border-b-2 border-turquoise text-turquoise'
                  : 'text-charcoal/60 hover:text-charcoal dark:text-gray-400'
              }`}
            >
              {locale === 'ar' ? day.labelAr : day.labelEn}
            </button>
          ))}
        </div>
      )}

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

      <AgendaTimeGrid
        minuteHeightPx={minuteHeightPx}
        columns={activeDay.rooms}
        otherColumnLabel={otherColumnLabel}
        sessions={activeDay.sessions.map((s) => ({
          id: s.id,
          trackId: s.roomId,
          blockColor: s.blockColor,
          startTime: s.startTime,
          endTime: s.endTime,
          title: s.title,
          alreadyBooked: s.alreadyBooked,
          showWaitlistButton: s.showWaitlistButton,
          isWaitlisted: s.isWaitlisted,
          isFull: s.isFull,
          isPastDeadline: s.isPastDeadline,
        }))}
        emptyState={
          <Card className="py-10 text-center text-sm text-charcoal/50 dark:text-gray-400">{emptyDayLabel}</Card>
        }
        renderBlock={(s) => (
          <div className="flex h-full flex-col gap-0.5 overflow-hidden p-1.5 text-white">
            <span className="truncate text-xs font-semibold">{s.title}</span>
            <div className="mt-auto">
              {s.alreadyBooked ? (
                <span className="text-[10px] font-medium">✓ Booked</span>
              ) : s.showWaitlistButton ? (
                // `compact` here renders a small underlined-text control
                // instead of the full <Button size="sm"> (px-3/py-1.5,
                // 32px+ tall) -- see booking-button.tsx's `compact` doc.
                // The grid block this lives inside can be as short as
                // ~20px (a 15-minute slot), too short for the roomy
                // card-era button.
                <WaitlistButton sessionId={s.id} isWaitlisted={s.isWaitlisted} isPastDeadline={s.isPastDeadline} compact />
              ) : (
                <BookButton sessionId={s.id} isFull={s.isFull} isPastDeadline={s.isPastDeadline} compact />
              )}
            </div>
          </div>
        )}
      />
    </div>
  );
}
