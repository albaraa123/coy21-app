/**
 * Server-only helper (Task 12 bug fix): resolves every `labelKey` referenced
 * by a NavGroup[] into a plain, serializable Record<labelKey, translated
 * text>, using a real next-intl translate function.
 *
 * WHY THIS EXISTS: `getTranslations({ namespace: 'nav' })` returns a live
 * function, which is NOT serializable — it can never be passed as a prop
 * from a Server Component into a 'use client' Component (React/Next.js's
 * Flight serializer throws "Functions cannot be passed directly to Client
 * Components..." at render time). The original Task 12 implementation did
 * exactly that (passed the `t` function itself down through AppShell into
 * SidebarNav/MobileDrawer), which is the bug this module fixes.
 *
 * The fix: call the real `t(...)` function here, server-side, once per
 * `labelKey` actually present in the nav data, and return a plain object.
 * That object crosses the RSC boundary fine (it's just data) and
 * SidebarNav/MobileDrawer do a plain lookup (`translations[labelKey]`)
 * instead of calling a function prop.
 *
 * `labelKey` itself (e.g. "nav.groups.participants") is the FULL message
 * key path including the "nav." namespace prefix (see admin-nav-config.ts/
 * participant-nav-config.ts). A `getTranslations({ namespace: 'nav' })`
 * result expects paths RELATIVE to that namespace (e.g.
 * "groups.participants"), so the "nav." prefix is stripped before calling
 * `t()`. This must stay in sync with how the `nav` namespace is registered
 * in the layouts that call this helper.
 */

import type { NavGroup } from './nav-types';

const NAV_NAMESPACE_PREFIX = 'nav.';

function toNamespaceRelativeKey(labelKey: string): string {
  return labelKey.startsWith(NAV_NAMESPACE_PREFIX)
    ? labelKey.slice(NAV_NAMESPACE_PREFIX.length)
    : labelKey;
}

/**
 * Collects every distinct, non-empty labelKey referenced anywhere in
 * navGroups (group labelKeys, item labelKeys, and any nested item
 * children). An empty labelKey (the "flat ungrouped list" sentinel — see
 * sidebar-nav.tsx) is intentionally skipped: it is never rendered as text.
 */
function collectLabelKeys(navGroups: NavGroup[]): Set<string> {
  const keys = new Set<string>();

  function visitItems(items: NavGroup['items']): void {
    for (const item of items) {
      if (item.labelKey) keys.add(item.labelKey);
      if (item.children) visitItems(item.children);
    }
  }

  for (const group of navGroups) {
    if (group.labelKey) keys.add(group.labelKey);
    visitItems(group.items);
  }

  return keys;
}

/**
 * Builds a plain Record<labelKey, translatedText> for every labelKey
 * referenced in navGroups, using `translate` (a real `t` function from
 * `getTranslations({ namespace: 'nav' })`, called server-side by the
 * caller). Safe to pass the RESULT of this function as a prop into a
 * 'use client' component; never pass `translate` itself.
 */
export function buildNavTranslations(
  navGroups: NavGroup[],
  translate: (key: string) => string
): Record<string, string> {
  const translations: Record<string, string> = {};
  for (const labelKey of collectLabelKeys(navGroups)) {
    translations[labelKey] = translate(toNamespaceRelativeKey(labelKey));
  }
  return translations;
}
