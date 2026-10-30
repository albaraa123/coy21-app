import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';

// Same base treatment as Input (see input.tsx for the focus-visible
// rationale). Not `w-full` by default, matching Input -- every existing
// `<textarea>` usage this replaces already passes its own `w-full` via
// className where it wants one, so the component leaves width to the
// caller rather than forcing it.
const BASE_CLASSES =
  'rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className = '', ...rest },
  ref
) {
  return <textarea ref={ref} className={`${BASE_CLASSES} ${className}`} {...rest} />;
});
