import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../../support/mock-intl-link';

// usePathname is hook-based and test-specific (per Task 5's brief), so it
// is mocked locally rather than via the shared mock-intl-link helper,
// which only covers Link.
let mockPathname = '/participants';
vi.mock('@/i18n/routing', () => ({
  ...mockIntlLink(),
  usePathname: () => mockPathname,
}));

import { SidebarNav } from '@/components/shell/sidebar-nav';
import type { NavGroup } from '@/lib/nav/nav-types';
import { adminDashboardItem, adminNavGroups } from '@/lib/nav/admin-nav-config';
import { participantNavItems } from '@/lib/nav/participant-nav-config';
import enMessages from '@/messages/en.json';

// Real translations built from the real `nav` namespace in en.json (not a
// stub), so these tests exercise the actual message data Task 12 added,
// not just the plumbing. Mirrors what
// src/lib/nav/build-nav-translations.ts's buildNavTranslations() produces
// server-side: a plain Record<labelKey, translatedText> map, e.g.
// navTranslations['nav.groups.participants'] === 'Participants'. This is
// the bug-fixed shape — SidebarNav now takes a plain object, never a
// `translate` function prop (a function value cannot legally cross the
// Server -> Client Component boundary).
const navMessages: Record<string, unknown> = enMessages.nav;
function resolve(labelKey: string): string {
  const path = labelKey.startsWith('nav.') ? labelKey.slice('nav.'.length) : labelKey;
  const value = path.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object' && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, navMessages);
  return typeof value === 'string' ? value : labelKey;
}

function buildTranslations(navGroupsToResolve: NavGroup[]): Record<string, string> {
  const translations: Record<string, string> = {};
  for (const group of navGroupsToResolve) {
    if (group.labelKey) translations[group.labelKey] = resolve(group.labelKey);
    for (const item of group.items) {
      translations[item.labelKey] = resolve(item.labelKey);
    }
  }
  return translations;
}

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

const flatGroups: NavGroup[] = [
  {
    labelKey: '',
    items: [
      { labelKey: 'nav.participant.dashboard', href: '/my-dashboard', iconKey: 'dashboard' },
      { labelKey: 'nav.participant.schedule', href: '/schedule', iconKey: 'schedule' },
    ],
  },
];

describe('SidebarNav', () => {
  it('SSR-renders without accessing localStorage during the initial render', () => {
    // renderToStaticMarkup runs no useEffect, so if the component tried to
    // read localStorage during render (rather than only in an effect), it
    // would throw here since `window`/`localStorage` are unavailable in
    // this node-environment test run (vitest.config.ts: environment: 'node').
    mockPathname = '/participants';
    expect(() =>
      renderToStaticMarkup(<SidebarNav navGroups={groups} storageKey="rcoy-admin-nav-v1" navTranslations={buildTranslations(groups)} />)
    ).not.toThrow();
  });

  it('force-expands the group containing the active route on initial render (no localStorage needed)', () => {
    mockPathname = '/agenda';
    const html = renderToStaticMarkup(
      <SidebarNav navGroups={groups} storageKey="rcoy-admin-nav-v1" navTranslations={buildTranslations(groups)} />
    );
    // The agenda group's item link must be present in the markup (i.e. the
    // group rendered expanded), proving the SSR-safe default-expansion
    // logic (defaultExpandedGroups) worked without touching localStorage.
    expect(html).toContain('href="/agenda"');
  });

  it('collapses a group with no active route by default', () => {
    mockPathname = '/agenda';
    const html = renderToStaticMarkup(
      <SidebarNav navGroups={groups} storageKey="rcoy-admin-nav-v1" navTranslations={buildTranslations(groups)} />
    );
    // The participants group is not active, so its item link should not render.
    expect(html).not.toContain('href="/participants"');
  });

  it('marks the active item with aria-current="page"', () => {
    mockPathname = '/agenda';
    const html = renderToStaticMarkup(
      <SidebarNav navGroups={groups} storageKey="rcoy-admin-nav-v1" navTranslations={buildTranslations(groups)} />
    );
    expect(html).toContain('aria-current="page"');
  });

  it('renders a flat, ungrouped list with no group-toggle UI for the participant config', () => {
    mockPathname = '/my-dashboard';
    const html = renderToStaticMarkup(
      <SidebarNav navGroups={flatGroups} storageKey="rcoy-participant-nav-v1" navTranslations={buildTranslations(flatGroups)} />
    );
    expect(html).toContain('href="/my-dashboard"');
    expect(html).toContain('href="/schedule"');
    // No aria-expanded group-toggle button should be present in the flat case.
    expect(html).not.toContain('aria-expanded');
  });

  it('never renders a dynamic-route placeholder as a Link href for the real admin nav config (regression: Next.js <Link> crash on unfilled "[...]" segments)', () => {
    // Force every group open by landing on a pathname that activates all
    // of them isn't possible in one shot, so instead render once per
    // real pathname corresponding to each group's first item, unioning the
    // rendered markup — this exercises the ACTUAL adminNavGroups export
    // (not a hand-rolled fixture), proving the fix holds for the real,
    // shipped config, not just a synthetic one.
    const htmls = adminNavGroups.map((group) => {
      mockPathname = group.items[0].href;
      return renderToStaticMarkup(
        <SidebarNav navGroups={adminNavGroups} storageKey="rcoy-admin-nav-v1" navTranslations={buildTranslations(adminNavGroups)} />
      );
    });
    for (const html of htmls) {
      // Every href="..." attribute value must not contain "[" or "]" —
      // i.e. no NavItem ever reaches <Link> with an unfilled dynamic
      // segment like "/participants/[applicationId]".
      const hrefMatches = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefMatches.length).toBeGreaterThan(0);
      for (const href of hrefMatches) {
        expect(href, `rendered Link href "${href}" must not contain a dynamic-route placeholder`).not.toMatch(
          /[[\]]/
        );
      }
    }
  });
});

// Task 12 regression coverage: the real, user-visible bug this task fixes
// (the admin sidebar rendering raw "nav.participants.list"-shaped i18n key
// paths instead of real text, because the `nav` message namespace did not
// exist yet). Exercises the ACTUAL adminNavGroups/participantNavItems
// exports through the real `navTranslations` map built (via
// buildTranslations, mirroring src/lib/nav/build-nav-translations.ts) from
// the real src/messages/en.json `nav` namespace — not a synthetic fixture —
// so this fails if any labelKey referenced by either shipped nav config is
// ever missing its translation.
// Extracts only the text nodes rendered inside <span>...</span> (where
// NavLink/group-header labels actually render) — deliberately excludes
// attribute values like aria-controls="sidebar-group-nav.groups.x", which
// legitimately embed the raw, stable labelKey as a DOM id and are not
// user-visible text.
function spanTextContents(html: string): string[] {
  return [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
}

describe('SidebarNav labelKey -> translated text resolution (Task 12)', () => {
  it('never renders a raw "nav.*" key path as visible text anywhere in the admin sidebar markup', () => {
    const htmls = adminNavGroups.map((group) => {
      mockPathname = group.items[0].href;
      return renderToStaticMarkup(
        <SidebarNav navGroups={adminNavGroups} storageKey="rcoy-admin-nav-v1" navTranslations={buildTranslations(adminNavGroups)} />
      );
    });
    for (const html of htmls) {
      for (const text of spanTextContents(html)) {
        expect(text).not.toMatch(/^nav\.[a-zA-Z]+(\.[a-zA-Z]+)*$/);
      }
    }
  });

  it('never renders a raw "nav.*" key path as visible text anywhere in the flat participant sidebar markup', () => {
    mockPathname = '/my-dashboard';
    const html = renderToStaticMarkup(
      <SidebarNav navGroups={flatGroups} storageKey="rcoy-participant-nav-v1" navTranslations={buildTranslations(flatGroups)} />
    );
    for (const text of spanTextContents(html)) {
      expect(text).not.toMatch(/^nav\.[a-zA-Z]+(\.[a-zA-Z]+)*$/);
    }
  });

  it('resolves every real admin group label to non-empty, non-key-shaped text', () => {
    for (const group of adminNavGroups) {
      const label = resolve(group.labelKey);
      expect(label).not.toBe(group.labelKey);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('resolves every real admin item label to non-empty, non-key-shaped text', () => {
    for (const group of adminNavGroups) {
      for (const item of group.items) {
        const label = resolve(item.labelKey);
        expect(label).not.toBe(item.labelKey);
        expect(label.length).toBeGreaterThan(0);
      }
    }
    expect(resolve(adminDashboardItem.labelKey)).not.toBe(adminDashboardItem.labelKey);
  });

  it('resolves every real participant item label to non-empty, non-key-shaped text', () => {
    for (const item of participantNavItems) {
      const label = resolve(item.labelKey);
      expect(label).not.toBe(item.labelKey);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('falls back to the raw labelKey (never blank, never a crash) when a translation is missing from navTranslations', () => {
    // Proves resolveLabel()'s degrade-gracefully fallback (sidebar-nav.tsx)
    // independently of whether the real en.json happens to be complete —
    // an empty navTranslations map is the worst case this fallback exists
    // to handle.
    mockPathname = '/participants';
    const html = renderToStaticMarkup(
      <SidebarNav navGroups={groups} storageKey="rcoy-admin-nav-v1" navTranslations={{}} />
    );
    expect(html).toContain('nav.groups.participants');
    expect(html).toContain('nav.participants.list');
  });
});
