'use client';
// Client component for just the day-switching tab bar + active-day state
// (see docs/superpowers/plans/2026-10-31-agenda-time-grid-design.md, Task 4).
// The page itself (page.tsx) stays a Server Component for its data
// fetching -- only the "which day is active" state needs to live on the
// client, same split pattern as elsewhere in this codebase
// (page.tsx + a small 'use client' child for interactive state).
import { useState } from 'react';

export function DayTabs<TDay extends { date: string; labelEn: string; labelAr: string }>({
  days,
  locale,
  children,
}: {
  days: TDay[];
  locale: string;
  children: (activeDay: TDay) => React.ReactNode;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
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
      {children(activeDay)}
    </div>
  );
}
