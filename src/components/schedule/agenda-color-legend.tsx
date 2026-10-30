// Simple color-key legend for the agenda time-grid, added 2026-11-01
// after direct user feedback: the grid color-codes each block by track,
// but nothing on either page explained what the colors meant. Pure
// presentational, no 'use client' needed (plain data in, plain markup
// out) -- same reasoning as AgendaTimeGrid itself.
export interface AgendaLegendItem {
  id: string;
  name: string;
  color: string;
}

export function AgendaColorLegend({ items }: { items: AgendaLegendItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-charcoal/10 bg-warm-white px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-900">
      {items.map((item) => (
        <span key={item.id} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
          <span className="text-charcoal/70 dark:text-gray-300">{item.name}</span>
        </span>
      ))}
    </div>
  );
}
