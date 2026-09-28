'use client';

/**
 * The minimal client island for opening the mobile drawer. Kept as its
 * own tiny component (rather than making all of Topbar a Client
 * Component) because it's the only piece of Topbar that needs an
 * onClick handler and a ref to hand off to MobileDrawer for focus
 * return.
 *
 * Reads/writes the shared open state and trigger ref via
 * useMobileDrawer() (mobile-drawer-context.tsx) rather than taking
 * onClick/ref as props from its caller: AppShell (server) instantiates
 * this component directly and hands it to Topbar as a `mobileDrawerTrigger`
 * ReactNode slot, and MobileDrawer is rendered separately as this
 * component's SIBLING elsewhere in the same tree — neither is a
 * parent/child of the other, so the only legal way for them to share
 * "is the drawer open" state, without passing a function value across
 * the server/client boundary, is a Context provider both are rendered
 * underneath (see mobile-drawer-context.tsx's doc comment for the full
 * reasoning, including the bug this replaced).
 */

import { useMobileDrawer } from './mobile-drawer-context';

export interface MobileDrawerTriggerProps {
  ariaLabel: string;
}

export function MobileDrawerTrigger({ ariaLabel }: MobileDrawerTriggerProps) {
  const { setOpen, triggerRef } = useMobileDrawer();

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen(true)}
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      className="rounded-md p-2 text-charcoal/70 hover:bg-charcoal/5 hover:text-charcoal md:hidden"
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}
