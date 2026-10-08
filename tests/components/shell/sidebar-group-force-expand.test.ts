// tests/components/shell/sidebar-group-force-expand.test.ts
//
// Regression coverage for a real production bug found during a live
// deployment check: clicking a sidebar group's header to collapse it (via
// toggleGroup()) while still on a route inside that group silently
// re-expanded it on the next render. sidebar-nav.tsx's existing test file
// uses renderToStaticMarkup (SSR-only, no useEffect, no click simulation)
// and this codebase has no @testing-library/react-style interactive-render
// setup, so the force-expand effect's actual bug (keyed off a value derived
// from expandedGroups itself, re-firing whenever a manual toggle changed
// it) was invisible to that test style. groupsToForceExpandOnNavigation
// lives in route-matching.ts (not sidebar-nav.tsx itself) specifically so
// it can be imported here without pulling in sidebar-nav.tsx's 'use client'
// imports (@/i18n/routing's Link/usePathname, which transitively import
// next/navigation -- unresolvable outside a real Next.js runtime).
import { describe, expect, it } from 'vitest';
import { groupsToForceExpandOnNavigation } from '@/lib/nav/route-matching';
import type { NavGroup } from '@/lib/nav/nav-types';

const groups: NavGroup[] = [
  {
    labelKey: 'nav.groups.participants',
    items: [{ labelKey: 'nav.participants.list', href: '/participants', iconKey: 'participants' }],
  },
  {
    labelKey: 'nav.groups.agenda',
    items: [{ labelKey: 'nav.agenda.overview', href: '/agenda', iconKey: 'agenda' }],
  },
];

describe('groupsToForceExpandOnNavigation', () => {
  it('returns the active group on the very first call (previousPathname null, matching mount)', () => {
    expect(groupsToForceExpandOnNavigation(groups, null, '/participants')).toEqual(['nav.groups.participants']);
  });

  it('returns the active group when pathname genuinely changes to a route inside a different group', () => {
    expect(groupsToForceExpandOnNavigation(groups, '/participants', '/agenda')).toEqual(['nav.groups.agenda']);
  });

  // The exact regression: pathname does NOT change (the user stayed on the
  // same page and only clicked the group header to collapse it) -- this
  // must return null, so the calling effect never re-adds the group to
  // expandedGroups and the manual collapse sticks.
  it('returns null when pathname is unchanged -- a manual collapse must not be fought by a re-expand', () => {
    expect(groupsToForceExpandOnNavigation(groups, '/participants', '/participants')).toBeNull();
    expect(groupsToForceExpandOnNavigation(groups, '/participants/accounts', '/participants/accounts')).toBeNull();
  });

  it('returns null when the new pathname matches no group (nothing to force-expand)', () => {
    expect(groupsToForceExpandOnNavigation(groups, '/participants', '/some-ungrouped-route')).toBeNull();
  });

  it('a sub-route within the same group still counts as "unchanged" for repeat calls at that sub-route', () => {
    // Simulates: navigate to /participants (expand), then re-render at the
    // same /participants/accounts pathname again (e.g. a state update
    // unrelated to navigation) -- must not force-expand a second time.
    const first = groupsToForceExpandOnNavigation(groups, null, '/participants/accounts');
    expect(first).toEqual(['nav.groups.participants']);
    const second = groupsToForceExpandOnNavigation(groups, '/participants/accounts', '/participants/accounts');
    expect(second).toBeNull();
  });
});
