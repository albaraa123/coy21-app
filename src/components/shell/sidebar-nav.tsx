'use client';

/**
 * Client sidebar navigation. Receives navGroups as plain data (NavGroup[]
 * from Task 4's nav-types.ts) and renders the actual interactive list:
 * active-route highlighting, and (for grouped/admin configs) expand/
 * collapse of groups with localStorage persistence.
 *
 * Flat participant config handling: participant-nav-config.ts exports a
 * flat NavItem[] (no groups) per Task 4. The caller wraps that in a single
 * synthetic NavGroup with an empty labelKey (see AppShell) so this
 * component only ever deals in NavGroup[] — but a single-group,
 * unlabeled list renders with NO group header/toggle at all (see
 * `isUngroupedList` below): there is nothing meaningful to expand/collapse
 * when there's only one flat list, so no group-toggle UI is forced onto
 * it, per the task brief's explicit instruction.
 *
 * SSR-hydration safety: expandedGroups' initial useState value is a pure
 * function of props only (defaultExpandedGroups(navGroups, pathname) —
 * the group containing the active route open, matching what the server
 * markup already implies via aria-current/data-active — every other group
 * collapsed). localStorage is read ONLY inside a useEffect, after mount,
 * and any keys it contributes are merged in via a second setState call —
 * never during the render that produces the initial/SSR-matching markup.
 * This avoids the hydration mismatch the task brief warns about.
 *
 * Label translation (Task 12, bug-fixed): `labelKey` (e.g.
 * "nav.groups.participants") is used as a stable IDENTITY string
 * throughout this component — React `key`s, `expandedGroups` entries, and
 * the localStorage persistence keys written by sidebar-nav-storage.ts. It
 * must stay a stable, locale-independent string, so it is never replaced
 * with translated display text. Instead, the caller supplies
 * `navTranslations`, a PLAIN Record<labelKey, translatedText> object
 * (built server-side via src/lib/nav/build-nav-translations.ts's
 * buildNavTranslations(), which calls next-intl's real
 * getTranslations({ namespace: 'nav' }) function in the server layouts
 * that render this tree — see (admin)/layout.tsx and
 * (participant)/(shell)/layout.tsx). This component does a plain object
 * lookup (`navTranslations[labelKey] ?? labelKey`) to produce the visible
 * label text, leaving `labelKey` itself untouched everywhere else. A
 * missing key degrades to showing the raw labelKey rather than crashing.
 *
 * IMPORTANT: navTranslations must be plain, serializable DATA, never a
 * live translate function. This component is 'use client', and a function
 * value cannot legally cross from a Server Component into a Client
 * Component's props (React/Next.js's Flight serializer throws at render
 * time) — that was the original Task 12 bug this fixes.
 */

import { useEffect, useState } from 'react';
import { usePathname } from '@/i18n/routing';
import { isGroupActive, isItemActive } from '@/lib/nav/route-matching';
import type { NavGroup, NavItem } from '@/lib/nav/nav-types';
import { ICON_MAP } from '@/lib/nav/icon-map';
import { Link } from '@/i18n/routing';
import { readExpandedGroups, writeExpandedGroups } from './sidebar-nav-storage';

export interface SidebarNavProps {
  navGroups: NavGroup[];
  storageKey: string;
  /** Plain map of NavItem/NavGroup `labelKey` -> translated display text. */
  navTranslations: Record<string, string>;
}

/** Looks up a labelKey's translated text, falling back to the raw key (rather than crashing) if it is somehow missing from the map. */
function resolveLabel(navTranslations: Record<string, string>, labelKey: string): string {
  return navTranslations[labelKey] ?? labelKey;
}

/** True when navGroups is really a flat list smuggled in as one unlabeled group. */
function isUngroupedList(navGroups: NavGroup[]): boolean {
  return navGroups.length === 1 && navGroups[0].labelKey === '';
}

function defaultExpandedGroups(navGroups: NavGroup[], pathname: string): string[] {
  return navGroups.filter((group) => isGroupActive(group, pathname)).map((group) => group.labelKey);
}

function NavLink({
  item,
  pathname,
  navTranslations,
}: {
  item: NavItem;
  pathname: string;
  navTranslations: Record<string, string>;
}) {
  const active = isItemActive(item, pathname);
  const Icon = ICON_MAP[item.iconKey];
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      data-active={active ? 'true' : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
        active
          ? 'bg-turquoise text-white shadow-sm'
          : 'text-charcoal/60 hover:bg-charcoal/6 hover:text-charcoal'
      }`}
    >
      {Icon ? <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-white' : 'text-charcoal/40'}`} aria-hidden="true" /> : null}
      <span>{resolveLabel(navTranslations, item.labelKey)}</span>
    </Link>
  );
}

export function SidebarNav({ navGroups, storageKey, navTranslations }: SidebarNavProps) {
  const pathname = usePathname();
  const ungrouped = isUngroupedList(navGroups);

  // Initial value is derived ONLY from props (navGroups + pathname), never
  // from localStorage, so this matches the server-rendered markup exactly.
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() =>
    ungrouped ? [] : defaultExpandedGroups(navGroups, pathname)
  );

  // Syncs expandedGroups with an external system (localStorage) once,
  // after mount — this is precisely the "subscribe for updates from an
  // external system" case react-hooks/set-state-in-effect's own guidance
  // carves out as legitimate (as opposed to deriving state from other
  // React state, which the rule is really meant to catch). The read
  // happens only in this effect, never during render, so it cannot cause
  // a hydration mismatch.
  useEffect(() => {
    if (ungrouped) return;
    const stored = readExpandedGroups(window.localStorage, storageKey);
    if (stored.length === 0) return;
    // The group containing the active route force-expands regardless of
    // stored state, per the task brief. Computed once here from the
    // mount-time pathname/navGroups (both effect dependencies), not from
    // the previous React state, avoiding a setState-derived-from-state
    // pattern.
    const activeGroupKeys = defaultExpandedGroups(navGroups, pathname);
    const merged = Array.from(new Set([...stored, ...activeGroupKeys]));
    // This IS the "correct from localStorage inside a useEffect only" sync
    // the task brief mandates; localStorage is an external system and
    // cannot be read during render without risking a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedGroups(merged);
    // Intentionally runs once per (storageKey, ungrouped) change, not on
    // every pathname change — the separate effect below handles
    // force-expanding the active group on subsequent navigations without
    // re-reading storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, ungrouped]);

  // Force-expands the group containing the active route on every
  // navigation, overriding stored/collapsed state, per the task brief.
  // Guarded so it's a no-op (no setState call at all) once the active
  // group is already expanded, rather than looping on itself.
  const activeGroupKeys = ungrouped ? [] : defaultExpandedGroups(navGroups, pathname);
  const activeGroupsAlreadyExpanded = activeGroupKeys.every((key) => expandedGroups.includes(key));
  useEffect(() => {
    if (ungrouped || activeGroupsAlreadyExpanded || activeGroupKeys.length === 0) return;
    // Force-expanding the active-route group on navigation (overriding
    // collapsed state) is an explicit task requirement and is guarded
    // above so it only fires when the active group is not yet expanded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedGroups((current) => Array.from(new Set([...current, ...activeGroupKeys])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, ungrouped, activeGroupsAlreadyExpanded]);

  function toggleGroup(labelKey: string) {
    setExpandedGroups((current) => {
      const next = current.includes(labelKey)
        ? current.filter((key) => key !== labelKey)
        : [...current, labelKey];
      writeExpandedGroups(window.localStorage, storageKey, next);
      return next;
    });
  }

  if (ungrouped) {
    return (
      <nav aria-label="Primary" className="flex flex-col gap-1 p-3">
        {navGroups[0].items.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} navTranslations={navTranslations} />
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Primary" className="flex flex-col gap-4 p-3">
      {navGroups.map((group) => {
        const expanded = expandedGroups.includes(group.labelKey);
        const groupId = `sidebar-group-${group.labelKey}`;
        return (
          <div key={group.labelKey}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={groupId}
              onClick={() => toggleGroup(group.labelKey)}
              className="flex w-full items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-charcoal/40 hover:text-charcoal/60"
            >
              <span>{resolveLabel(navTranslations, group.labelKey)}</span>
              <span aria-hidden="true" className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
                {'›'}
              </span>
            </button>
            {expanded && (
              <div id={groupId} className="mt-1 flex flex-col gap-1">
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} pathname={pathname} navTranslations={navTranslations} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
