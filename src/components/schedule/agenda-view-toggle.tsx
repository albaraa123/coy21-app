// src/components/schedule/agenda-view-toggle.tsx
'use client';

// Grid/Timeline segmented control shared by the admin Sessions page and
// the participant Browse Sessions page. Owns the active-view useState and
// persists it via agenda-view-storage.ts.
//
// SSR-hydration safety, matching src/components/shell/sidebar-nav.tsx's
// established pattern exactly (see that file's own header comment for the
// full rationale): the initial useState value is a fixed deterministic
// default ('grid'), NEVER read from localStorage during render -- the
// server has no localStorage to read from, so reading it synchronously
// here would produce a server/client markup mismatch whenever a user's
// stored preference is 'timeline'. The actual stored preference is read
// inside a useEffect that runs once after mount, then applied via
// setState.
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
