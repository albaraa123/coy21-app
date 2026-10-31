// src/components/schedule/agenda-track-filter-pills.tsx
'use client';

// Multi-select track filter pills for the Timeline view's top bar. Color
// dot + track name per pill (per the approved spec); controlled component,
// no internal state -- the parent (SessionsGridClient/BrowseGridClient)
// owns the selected-track-id Set and passes it down, same lift-state-up
// shape as every other control on these pages.
export interface AgendaTrackFilterOption {
  id: string;
  name: string;
  color: string;
}

export function AgendaTrackFilterPills({
  options,
  selectedIds,
  onToggle,
  onClear,
  allLabel,
}: {
  options: AgendaTrackFilterOption[];
  /** Empty set means "no filter" (== show all), same as pressing allLabel. */
  selectedIds: Set<string>;
  onToggle: (trackId: string) => void;
  onClear: () => void;
  allLabel: string;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onClear}
        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
          selectedIds.size === 0
            ? 'border-turquoise bg-turquoise/10 text-turquoise'
            : 'border-charcoal/20 text-charcoal/60 hover:text-charcoal dark:border-gray-700 dark:text-gray-400'
        }`}
      >
        {allLabel}
      </button>
      {options.map((opt) => {
        const active = selectedIds.has(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onToggle(opt.id)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              active ? 'border-turquoise bg-turquoise/10 text-turquoise' : 'border-charcoal/20 text-charcoal/60 hover:text-charcoal dark:border-gray-700 dark:text-gray-400'
            }`}
          >
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: opt.color }} />
            {opt.name}
          </button>
        );
      })}
    </div>
  );
}
