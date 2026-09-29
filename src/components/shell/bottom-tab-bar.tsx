'use client';

/**
 * Persistent bottom tab bar for the participant portal shell — 3 primary
 * NavItems (placement: 'primary' in participant-nav-config.ts) plus a
 * fixed 4th "More" trigger that opens the existing MobileDrawer (see
 * app-shell.tsx for wiring). This component owns only the 4-tab strip;
 * it renders no panel/drawer content itself.
 *
 * Pure-props design: `currentPathname` is passed in by the caller (which
 * itself calls usePathname() inside the real Next.js app tree) rather than
 * read internally via the hook here. This keeps the component directly
 * testable with renderToStaticMarkup (no router context needed to resolve
 * pathname), matching this codebase's existing component-test convention
 * (see tests/components/shell/sidebar-nav.test.tsx, tests/components/
 * badge.test.tsx). Active-tab logic itself reuses the existing, separately
 * unit-tested `isItemActive` from route-matching.ts rather than
 * reimplementing matching rules here.
 *
 * Accessibility: active tab gets aria-current="page"; every tab (including
 * the More trigger) has an accessible name via visible label text (no
 * icon-only tabs — label always renders); touch targets sized via padding
 * (min-h-11) not just icon size; RTL mirroring is automatic via flex + no
 * explicit left/right positioning, same convention as sidebar-nav.tsx.
 */
import { Link } from '@/i18n/routing';
import { isItemActive } from '@/lib/nav/route-matching';
import type { NavItem } from '@/lib/nav/nav-types';
import { ICON_MAP } from '@/lib/nav/icon-map';

export interface BottomTabBarProps {
  primaryItems: NavItem[];
  navTranslations: Record<string, string>;
  moreLabel: string;
  onMoreClick: () => void;
  /**
   * Current pathname, computed by the caller (which calls usePathname())
   * rather than read internally via the hook here — see file-level doc
   * comment for rationale.
   */
  currentPathname: string;
}

/** Looks up a labelKey's translated text, falling back to the raw key (rather than crashing) if it is somehow missing from the map. */
function resolveLabel(navTranslations: Record<string, string>, labelKey: string): string {
  return navTranslations[labelKey] ?? labelKey;
}

export function BottomTabBar({ primaryItems, navTranslations, moreLabel, onMoreClick, currentPathname }: BottomTabBarProps) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-charcoal/10 bg-white dark:border-white/10 dark:bg-gray-900 md:hidden"
    >
      {primaryItems.map((item) => {
        const active = isItemActive(item, currentPathname);
        const Icon = ICON_MAP[item.iconKey];
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium ${
              active ? 'text-turquoise' : 'text-charcoal/60 dark:text-gray-400'
            }`}
          >
            {Icon ? <Icon className="h-5 w-5" aria-hidden="true" /> : null}
            <span>{resolveLabel(navTranslations, item.labelKey)}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMoreClick}
        className="flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium text-charcoal/60 dark:text-gray-400"
      >
        <span aria-hidden="true" className="text-lg leading-none">
          ⋯
        </span>
        <span>{moreLabel}</span>
      </button>
    </nav>
  );
}
