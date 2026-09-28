'use client';

/**
 * The minimal client island for the participant bottom tab bar — mirrors
 * MobileDrawerTrigger's exact role/shape (see mobile-drawer-trigger.tsx's
 * doc comment) for the same kind of client-only concern: BottomTabBar
 * (bottom-tab-bar.tsx) is a pure-props presentational component that needs
 * `currentPathname` (usePathname()) and `onMoreClick` (opens the existing
 * MobileDrawer via useMobileDrawer()'s shared open/close state) — neither
 * of which AppShell itself can provide directly, since AppShell is a
 * Server Component (no 'use client', no usePathname — see its own doc
 * comment).
 *
 * Reuses the SAME MobileDrawerProvider context/state that
 * MobileDrawerTrigger and MobileDrawer already coordinate through, rather
 * than introducing any new state: "More" simply calls setOpen(true), the
 * identical action MobileDrawerTrigger's hamburger button performs.
 */

import { usePathname } from '@/i18n/routing';
import { useMobileDrawer } from './mobile-drawer-context';
import { BottomTabBar } from './bottom-tab-bar';
import type { NavItem } from '@/lib/nav/nav-types';

export interface BottomTabBarClientWrapperProps {
  primaryItems: NavItem[];
  navTranslations: Record<string, string>;
  moreLabel: string;
}

export function BottomTabBarClientWrapper({ primaryItems, navTranslations, moreLabel }: BottomTabBarClientWrapperProps) {
  const pathname = usePathname();
  const { setOpen } = useMobileDrawer();

  return (
    <BottomTabBar
      primaryItems={primaryItems}
      navTranslations={navTranslations}
      moreLabel={moreLabel}
      onMoreClick={() => setOpen(true)}
      currentPathname={pathname}
    />
  );
}
