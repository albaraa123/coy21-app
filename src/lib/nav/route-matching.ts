/**
 * Pure, framework-free route-matching helpers that drive sidebar active-item
 * highlighting. No React, no Next.js APIs — these operate on plain strings
 * so they're trivially unit-testable and reusable from server or client
 * code (e.g. computing initial active state during SSR).
 *
 * Matching rule: an item is "active" if, after stripping the locale prefix
 * and query string from the runtime pathname:
 *   - pathname === staticHref, OR
 *   - pathname starts with `${staticHref}/` (a genuine path-segment
 *     boundary, so "/agenda" does not false-match "/agenda-typo").
 *
 * Dynamic segments in config hrefs (e.g. "/participants/[applicationId]")
 * can never literally equal a real runtime pathname — the config href
 * contains the bracketed placeholder token itself, not a real id/UUID. We
 * resolve this by reducing the config href down to its static PARENT
 * segment (everything before the first "[...]" path segment) before
 * applying the same exact/prefix rule above. That means a nav entry for
 * "/participants/[applicationId]" activates for the list page
 * ("/participants"), the detail page ("/participants/abc-123"), and any
 * deeper nested route under that parent — which is the desired behavior:
 * the config's dynamic-route entries represent "this whole section is
 * active," not a literal (impossible) string match against the runtime id.
 *
 * Side-effect check: because we still apply the segment-boundary guard to
 * the reduced static parent, a route that merely shares the parent as a
 * text prefix (e.g. "/participants-typo") does NOT false-match — the
 * boundary requires either an exact match or the next character to be "/".
 * This also means two different dynamic items that share the same static
 * parent — e.g. `/allocation/runs`, `/allocation/runs/[id]`, and
 * `/allocation/runs/[id]/capacity` in admin-nav-config.ts all share the
 * parent "/allocation/runs" — would all report active together. This is
 * acceptable/expected for sidebar highlighting (the whole "Runs" section
 * is active), but the Task 5 sidebar should be aware that navigating to
 * the capacity page will also highlight the sibling Runs and Run Detail
 * entries, not just Run Capacity itself.
 */

import type { NavGroup, NavItem } from './nav-types';

/** Strip a leading `/xx` or `/xx-YY` locale segment (e.g. "/en", "/ar"). */
function stripLocalePrefix(pathname: string): string {
  const match = pathname.match(/^\/[a-z]{2}(?:-[A-Z]{2})?(\/|$)/);
  if (!match) {
    return pathname;
  }
  const stripped = pathname.slice(match[0].length - (match[1] === '/' ? 1 : 0));
  return stripped === '' ? '/' : stripped;
}

/** Strip a trailing query string (and hash, defensively) from a pathname. */
function stripQueryAndHash(pathname: string): string {
  const queryIndex = pathname.indexOf('?');
  const hashIndex = pathname.indexOf('#');
  const cutIndex = [queryIndex, hashIndex].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return cutIndex === undefined ? pathname : pathname.slice(0, cutIndex);
}

/** Normalize a runtime pathname: strip query/hash, then locale prefix. */
function normalizePathname(pathname: string): string {
  return stripLocalePrefix(stripQueryAndHash(pathname));
}

/**
 * Reduce a config href down to its static parent segment: everything
 * before the first path segment that is a dynamic placeholder (starts with
 * "["). A fully static href is returned unchanged.
 */
function staticParentSegment(href: string): string {
  const segments = href.split('/');
  const dynamicIndex = segments.findIndex((segment) => segment.startsWith('['));
  if (dynamicIndex === -1) {
    return href;
  }
  const parent = segments.slice(0, dynamicIndex).join('/');
  // Guard against a dynamic segment appearing as the very first path
  // segment (e.g. href === "/[id]"), which would otherwise reduce to "".
  return parent === '' ? '/' : parent;
}

/** True if `pathname` exactly equals `href`, or is a child path of it. */
function matchesHref(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isItemActive(item: NavItem, pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  const staticHref = staticParentSegment(item.href);

  if (matchesHref(normalized, staticHref)) {
    return true;
  }

  if (item.children) {
    return item.children.some((child) => isItemActive(child, pathname));
  }

  return false;
}

export function isGroupActive(group: NavGroup, pathname: string): boolean {
  return group.items.some((item) => isItemActive(item, pathname));
}

/** Every group's labelKey whose items match `pathname` (see isGroupActive). */
export function defaultExpandedGroups(navGroups: NavGroup[], pathname: string): string[] {
  return navGroups.filter((group) => isGroupActive(group, pathname)).map((group) => group.labelKey);
}

/**
 * Pure decision function behind sidebar-nav.tsx's "force-expand the active
 * group on navigation" effect. Returns the group keys that should be
 * force-added to expandedGroups, or `null` when nothing should change.
 *
 * Lives here (not in sidebar-nav.tsx itself) so it can be unit-tested
 * directly without pulling in sidebar-nav.tsx's 'use client' imports
 * (@/i18n/routing's Link/usePathname, which transitively import
 * next/navigation -- unresolvable outside a real Next.js runtime, the same
 * problem notification-bell-logic.ts was split out to avoid). This
 * codebase has no @testing-library/react-style interactive-render setup,
 * so a timing bug like the one this function encodes a fix for is
 * otherwise invisible to the renderToStaticMarkup-based tests already in
 * sidebar-nav.test.tsx (SSR-only, no useEffect, no click simulation).
 *
 * The bug this fixes: the original implementation decided whether to fire
 * based on whether the active group was CURRENTLY expanded (a value
 * derived from expandedGroups itself), not on whether a real navigation
 * had occurred. That meant collapsing the active-route group via a manual
 * toggle click flipped that derived value, which the effect's own
 * dependency array picked up, re-firing the effect and silently
 * re-expanding the very group the user had just clicked to collapse --
 * manual collapse of the active-route group was effectively impossible
 * while staying on that route. Keying this purely off "did pathname
 * change since the last time we decided this" fixes it: a toggle click
 * doesn't change pathname, so it's left alone.
 */
export function groupsToForceExpandOnNavigation(
  navGroups: NavGroup[],
  previousPathname: string | null,
  currentPathname: string
): string[] | null {
  if (previousPathname === currentPathname) return null;
  const activeGroupKeys = defaultExpandedGroups(navGroups, currentPathname);
  return activeGroupKeys.length === 0 ? null : activeGroupKeys;
}
