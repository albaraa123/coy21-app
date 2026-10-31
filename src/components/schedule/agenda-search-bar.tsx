// src/components/schedule/agenda-search-bar.tsx
'use client';

// Search input + result counter for the Timeline view's top bar.
// Controlled component -- the parent owns the query string and the
// already-filtered count, same pattern as the other Timeline controls.
import { Input } from '@/components/ui/input';

export function AgendaSearchBar({
  value,
  onChange,
  placeholder,
  resultCountLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** A next-intl-resolved string like "12 sessions" / "12 جلسة" -- the
      caller resolves pluralization via t(), this component just renders it. */
  resultCountLabel: string;
}) {
  return (
    <div className="flex flex-1 items-center gap-3">
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="max-w-xs"
        aria-label={placeholder}
      />
      <span className="shrink-0 text-xs text-charcoal/50 dark:text-gray-400">{resultCountLabel}</span>
    </div>
  );
}
