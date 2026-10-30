'use client';

// Small zoom (+/-) control for AgendaTimeGrid's vertical density, added
// 2026-11-01 per direct user feedback on the shipped grid ("I want to be
// able to widen/narrow the time grid so it's clearer"). AgendaTimeGrid
// itself stays a plain, hookless, server-renderable component (see its
// own header comment) -- this wrapper owns the one piece of client state
// (the current minuteHeightPx) and passes it down as a prop, same split
// as MobileDrawerTrigger/MobileDrawer or DayTabs elsewhere in this
// codebase: a small client shell around an otherwise-server-safe tree.
//
// AgendaTimeGrid has no 'use client' of its own and does no client-only
// work, so rendering it as a child of this client component is legal
// RSC composition (a Server Component instantiated and passed down, not
// a function imported and called across the boundary) -- same pattern
// already established by AppShell passing MobileDrawerTrigger down, just
// inverted (here the client shell wraps the server-safe child, which is
// also legal: a 'use client' component can freely render any other
// component passed as `children`/composed in its own render, since
// AgendaTimeGrid takes no server-only props like a raw Supabase client).
import { useState, type ReactNode } from 'react';

const MIN_MINUTE_HEIGHT_PX = 0.8;
const MAX_MINUTE_HEIGHT_PX = 3.2;
const STEP_PX = 0.4;

export function AgendaTimeGridZoom({
  defaultMinuteHeightPx,
  children,
  zoomOutLabel = 'Zoom out',
  zoomInLabel = 'Zoom in',
}: {
  defaultMinuteHeightPx: number;
  /** Render-prop receiving the current minuteHeightPx to pass straight into <AgendaTimeGrid minuteHeightPx={...}>. */
  children: (minuteHeightPx: number) => ReactNode;
  /** aria-label for the "-" button. Defaults to English; pass a locale-aware string from the caller's own next-intl scope to override. */
  zoomOutLabel?: string;
  /** aria-label for the "+" button. Defaults to English; pass a locale-aware string from the caller's own next-intl scope to override. */
  zoomInLabel?: string;
}) {
  const [minuteHeightPx, setMinuteHeightPx] = useState(defaultMinuteHeightPx);

  return (
    <div className="flex flex-col gap-2">
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
      {children(minuteHeightPx)}
    </div>
  );
}
