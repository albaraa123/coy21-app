import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';

// Same base treatment as Input (see input.tsx for the focus-visible
// rationale) -- plus `w-full` by default, since the real usages this
// replaces are overwhelmingly full-width within their container (filter
// bars, form grids). Callers that genuinely need a narrower select can
// still override width via `className` (e.g. `max-w-xs`).
const BASE_CLASSES =
  'w-full rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  className?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = '', ...rest },
  ref
) {
  return <select ref={ref} className={`${BASE_CLASSES} ${className}`} {...rest} />;
});
