// src/components/schedule/agenda-view-toggle.tsx
'use client';

// Grid/Timeline segmented control shared by the admin Sessions page and
// the participant Browse Sessions page. The active `view` is owned by the
// PARENT client component (SessionsGridClient/BrowseGridClient), not here
// -- the parent needs it to decide which of AgendaTimeGrid/AgendaTimeline
// to render, so this component is a controlled view + onChange callback,
// same lift-state-up shape already used for minuteHeightPx in the
// existing zoom controls. This component's only local behavior is reading
// the persisted preference on mount and reporting it up.
//
// SSR-hydration safety, matching src/components/shell/sidebar-nav.tsx's
// established pattern exactly (see that file's own header comment for the
// full rationale): the PARENT's initial state for `view` is a fixed
// deterministic default ('grid'), NEVER read from localStorage during
// render -- the server has no localStorage to read from, so reading it
// synchronously would produce a server/client markup mismatch whenever a
// user's stored preference is 'timeline'. The actual stored preference is
// read here inside a useEffect that runs once after mount, then reported
// to the parent via onChange.
import { useEffect } from 'react';
import { readAgendaView, writeAgendaView, type AgendaView } from './agenda-view-storage';

export function AgendaViewToggle({
  storageKey,
  view,
  onChange,
  gridLabel,
  timelineLabel,
}: {
  storageKey: string;
  view: AgendaView;
  onChange: (view: AgendaView) => void;
  gridLabel: string;
  timelineLabel: string;
}) {
  useEffect(() => {
    onChange(readAgendaView(window.localStorage, storageKey));
    // Intentionally runs once on mount only -- see module header comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (next: AgendaView) => {
    onChange(next);
    writeAgendaView(window.localStorage, storageKey, next);
  };

  return (
    <div role="tablist" className="inline-flex rounded-md border border-charcoal/20 p-0.5 dark:border-gray-700">
      <button
        type="button"
        role="tab"
        aria-selected={view === 'grid'}
        onClick={() => select('grid')}
        className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
          view === 'grid' ? 'bg-turquoise text-white' : 'text-charcoal/60 hover:text-charcoal dark:text-gray-400'
        }`}
      >
        {gridLabel}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'timeline'}
        onClick={() => select('timeline')}
        className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
          view === 'timeline' ? 'bg-turquoise text-white' : 'text-charcoal/60 hover:text-charcoal dark:text-gray-400'
        }`}
      >
        {timelineLabel}
      </button>
    </div>
  );
}
