/**
 * Topbar — server where possible. No 'use client' directive: this file
 * itself has zero interaction state. The horizontal logo links to `/`
 * (via next-intl's Link, which is safe to use from a Server Component).
 * LanguageSwitcher and UserMenu are imported directly — both are Client
 * Components, but importing a Client Component into a Server Component
 * and rendering it is the standard, supported composition (it does not
 * force Topbar itself client-side, only those subtrees).
 *
 * mobileDrawerTrigger is accepted as a ReactNode prop (a "slot") rather
 * than importing MobileDrawerTrigger directly, because the trigger needs
 * a ref + onClick wired to drawer-open state shared via Context with a
 * sibling MobileDrawer instance (see mobile-drawer-context.tsx's doc
 * comment) — AppShell (server) instantiates MobileDrawerTrigger itself
 * and passes the rendered element down, so Topbar never needs to know
 * about that state, or import a 'use client' module, at all.
 *
 * pageTitle is accepted as a plain string (not children/a client slot):
 * every real usage in this task passes a pre-resolved, server-rendered
 * string (the caller already knows the page title server-side — there is
 * no per-page client dynamism requirement in this task), so a string prop
 * is sufficient and keeps this file simplest. A later task introducing a
 * genuinely client-dynamic breadcrumb can widen this prop to ReactNode
 * without changing Topbar's server-vs-client status.
 *
 * notificationBell (sub-project 6, Task 7) follows the exact same
 * ReactNode-slot pattern as mobileDrawerTrigger above, for the identical
 * reason: NotificationBell is a Client Component with its own hook state
 * (open/close, Realtime subscriptions, polling), so Topbar never imports
 * it directly — AppShell (server) instantiates
 * `<NotificationBell applicationId={...} />` itself and passes the
 * rendered element down. Optional and rendered only when provided, so
 * every caller that doesn't pass it (currently the admin shell) renders
 * byte-for-byte as before.
 */

import type { ReactNode } from 'react';
import Image from 'next/image';
import { Link } from '@/i18n/routing';
import { LanguageSwitcher } from './language-switcher';
import { UserMenu } from './user-menu';

export interface TopbarProps {
  locale: string;
  pageTitle?: string;
  userDisplay: { name: string; roleLabel: string };
  logoutLabel: string;
  mobileDrawerTrigger: ReactNode;
  /** Pre-rendered <NotificationBell /> slot, rendered in the right-side gap-3 div before UserMenu. Omitted entirely when undefined. */
  notificationBell?: ReactNode;
}

export function Topbar({ locale, pageTitle, userDisplay, logoutLabel, mobileDrawerTrigger, notificationBell }: TopbarProps) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-charcoal/10 bg-warm-white px-4">
      <div className="flex items-center gap-3">
        {mobileDrawerTrigger}
        <Link href="/" className="flex items-center">
          <Image
            src="/brand/logo/logo-horizontal-color.svg"
            alt="COY21 Türkiye 2026"
            width={160}
            height={32}
            className="h-8 w-auto"
            priority
          />
        </Link>
        {pageTitle && (
          <>
            <span aria-hidden="true" className="text-charcoal/30">
              /
            </span>
            <h1 className="truncate text-sm font-semibold text-charcoal">{pageTitle}</h1>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {notificationBell}
        <UserMenu name={userDisplay.name} roleLabel={userDisplay.roleLabel} logoutLabel={logoutLabel} />
      </div>
    </header>
  );
}

