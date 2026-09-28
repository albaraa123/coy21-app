import { Skeleton } from '../ui/skeleton';

type LoadingStateVariant = 'page' | 'section' | 'inline' | 'table';

function Spinner({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg className={`animate-spin text-charcoal/60 dark:text-gray-400 ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function LoadingState({
  variant = 'page',
  label,
  rows = 3,
  columns = 3,
}: {
  variant?: LoadingStateVariant;
  label?: string;
  rows?: number;
  columns?: number;
}) {
  if (variant === 'inline') {
    return <Spinner className="h-4 w-4" />;
  }

  if (variant === 'table') {
    return (
      // Single live region for the whole table skeleton. Skeleton itself
      // carries role="status" aria-label="Loading" per cell — intentionally
      // suppressed here via aria-hidden on the inner grid so screen readers
      // announce "Loading" once, not once per cell (rows * columns). Do not
      // remove the aria-hidden wrapper to "deduplicate" — it's the fix.
      <div role="status" aria-label="Loading" className="flex flex-col gap-2">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div key={rowIndex} className="flex gap-2" aria-hidden="true">
            {Array.from({ length: columns }).map((__, colIndex) => (
              <Skeleton key={colIndex} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  const padding = variant === 'section' ? 'p-6' : 'p-12';

  return (
    <div aria-live="polite" className={`flex flex-col items-center justify-center gap-2 ${padding}`}>
      <Spinner />
      {label && <p className="text-sm text-charcoal/70 dark:text-gray-400">{label}</p>}
    </div>
  );
}
