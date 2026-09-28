import { forwardRef } from 'react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from '@/i18n/routing';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-turquoise text-white hover:bg-turquoise/85',
  secondary: 'border border-charcoal text-charcoal bg-transparent hover:bg-charcoal/5',
  ghost: 'bg-transparent text-charcoal hover:bg-charcoal/5',
  // Irreversible/security-consequential actions (e.g. revoking an
  // invitation) — deliberately more visually assertive than `secondary` so
  // a destructive action never reads as the least-prominent control on a
  // security surface. Red tokens match the error/alert text treatment
  // already established elsewhere (see invitation-controls.tsx's
  // text-red-700 dark:text-red-300 alert text, badge.tsx's dark cancelled
  // variant).
  destructive: 'border border-red-700 text-red-700 bg-transparent hover:bg-red-50 dark:border-red-400 dark:text-red-300 dark:hover:bg-red-950/40',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none';

interface CommonProps {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

type ButtonAsButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & { href?: undefined };

type ButtonAsLinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children' | 'href'> & { href: string };

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

// forwardRef (added for Task 15's publish-confirmation dialog, which needs
// a real DOM ref to the publish trigger button to implement
// focus-returns-to-trigger-on-close, matching the accessibility pattern
// already established by mobile-drawer.tsx/mobile-drawer-trigger.tsx).
// Anchor-rendering branch (`href` set) forwards the same ref to next-intl's
// Link, which itself forwards to the underlying <a> — safe for either
// element type since callers needing the ref are only ever using the
// button-rendering branch today.
export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(
  { children, variant = 'primary', size = 'md', className = '', href, ...rest },
  ref
) {
  const classes = `${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`;

  if (href) {
    return (
      <Link
        ref={ref as React.Ref<HTMLAnchorElement>}
        href={href}
        className={classes}
        {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}
      >
        {children}
      </Link>
    );
  }

  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type="button"
      className={classes}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {children}
    </button>
  );
});
