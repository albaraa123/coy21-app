import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

// Base styling consolidated from the ~10 hand-written `<input>` class
// strings this replaces (see git history for the pre-consolidation
// per-file duplicates). Two focus treatments existed before this
// component: `focus:border-turquoise focus:outline-none` (older) and
// `focus-visible:ring-2 focus-visible:ring-turquoise` (newer, and already
// the more common of the two). This component standardizes on the
// focus-visible ring since it only shows the ring for keyboard focus, not
// every mouse click -- more accessible without being visually noisier.
//
// Deliberately NOT `w-full` by default -- unlike `Select`, several
// existing `<input>` usages are explicitly narrower than their container
// (e.g. `max-w-sm`, `max-w-xs` passed via extra classes), so this leaves
// width entirely to the caller's `className`.
const BASE_CLASSES =
  'rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', ...rest },
  ref
) {
  return <input ref={ref} className={`${BASE_CLASSES} ${className}`} {...rest} />;
});
