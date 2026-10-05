import { describe, expect, it } from 'vitest';
import { adminDashboardItem, adminNavGroups } from '@/lib/nav/admin-nav-config';
import { participantNavItems } from '@/lib/nav/participant-nav-config';
import type { NavGroup, NavItem } from '@/lib/nav/nav-types';

/**
 * STANDING REGRESSION TEST — read before editing routes.
 *
 * `ADMIN_VERIFIED_ROUTES` below is the confirmed, real, FULL route
 * inventory for src/app/[locale]/(admin)/ as of Phase 5.5 Task 4
 * (2026-07-28), cross-checked directly against the directory tree.
 * `/dashboard` is intentionally included even though it does not exist yet
 * (it lands in a later task) — see the comments in admin-nav-config.ts.
 *
 * SIDEBAR NAV IS A SUBSET OF REAL ROUTES, NOT EQUAL TO IT (fixed
 * Phase 5.5 Task "sidebar dynamic-href crash" bug): every href rendered by
 * admin-nav-config.ts becomes an actual clickable next-intl <Link>
 * (sidebar-nav.tsx / mobile-drawer.tsx), which crashes at render time if
 * given a literal, unfilled dynamic-route placeholder such as
 * "/participants/[applicationId]". Detail-only routes that require a real
 * dynamic id to be meaningful are therefore real, valid ADMIN_VERIFIED_ROUTES
 * entries (users do reach them, by clicking through from their parent list
 * page) but are intentionally ABSENT from admin-nav-config.ts's rendered
 * items — see admin-nav-config.ts's module doc comment for the full
 * reasoning and how active-route highlighting still works for them via
 * route-matching.ts's static-parent-segment reduction.
 *
 * `ADMIN_DETAIL_ONLY_ROUTES` (a subset of ADMIN_VERIFIED_ROUTES) lists
 * exactly those intentionally-unrendered routes. The "contains every
 * verified route" test below is scoped to ADMIN_VERIFIED_ROUTES minus that
 * set, so it still fails if a genuine LIST/PARENT route silently goes
 * missing from the sidebar, without demanding detail routes be rendered.
 *
 * If you rename, add, or remove a route under the admin app directory, you
 * MUST update this list (and the corresponding nav-config file) in the
 * same change, or this test will fail.
 */
const ADMIN_VERIFIED_ROUTES = [
  '/dashboard',
  '/agenda',
  '/agenda/days',
  '/agenda/people',
  '/agenda/rooms',
  '/agenda/session-types',
  '/agenda/sessions',
  '/agenda/sessions/[id]',
  '/agenda/tags',
  '/agenda/tracks',
  '/allocation',
  '/allocation/clustering',
  '/allocation/extraction',
  '/allocation/runs',
  '/allocation/runs/[id]',
  '/allocation/runs/[id]/capacity',
  '/allocation/schedules',
  '/allocation/schedules/changed',
  '/allocation/schedules/participants/[applicationId]',
  '/allocation/schedules/stage/[allocationRunId]',
  '/allocation/schedules/stage/draft/[draftId]',
  '/applications',
  '/applications/[id]',
  '/participants',
  '/participants/accounts',
  '/participants/arrivals',
  '/participants/care',
  '/participants/funding',
  '/participants/travel',
  '/participants/[applicationId]',
  '/participants/import',
  '/participants/import/[batchId]/confirm',
  '/participants/import/[batchId]/map',
  '/participants/import/[batchId]/preview',
  '/participants/import/[batchId]/rollback',
  '/participants/imports',
  '/participants/imports/[batchId]',
  '/attendance/scanners',
  '/attendance/admissions',
  '/attendance/walk-in',
  '/attendance/demand',
  '/staff',
  '/staff/assignments',
  '/settings',
  '/reports',
  '/communications',
];

/**
 * Real, valid admin routes that are intentionally NOT rendered as their own
 * sidebar NavItems. Most entries contain a "[...]" dynamic-segment path
 * token and require a real dynamic id to be meaningful (see the module doc
 * comment above and admin-nav-config.ts) -- reached by clicking through
 * from a parent list page.
 *
 * The remaining, non-dynamic-segment entries fall into two patterns, both
 * verified by reading each page directly (not assumed):
 *
 * 1. Hub/landing pages whose own body links to their real sub-pages, where
 *    the sidebar's group header only toggles expand/collapse (sidebar-nav.tsx
 *    uses onClick, not a Link, for group headers) rather than navigating
 *    anywhere -- so the hub page itself, and any of its sub-pages the
 *    sidebar's own nav group doesn't separately list, are reachable only via
 *    click-through, never as a standalone sidebar link. This covers `/agenda`
 *    (links to `/agenda/session-types`, `/agenda/tags`, among others already
 *    in the sidebar) and `/allocation` (links to `/allocation/clustering`,
 *    `/allocation/extraction`).
 * 2. A page reachable via click-through from somewhere OTHER than its own
 *    section's hub -- `/allocation/schedules/changed` is linked from
 *    `/allocation/schedules`'s own page body; `/participants/imports` is
 *    linked from three `/dashboard` cards; `/participants` has no content of
 *    its own at all and transparently redirects to `/applications`.
 */
const ADMIN_DETAIL_ONLY_ROUTES = [
  '/agenda',
  '/agenda/session-types',
  '/agenda/tags',
  '/agenda/sessions/[id]',
  '/allocation',
  '/allocation/clustering',
  '/allocation/extraction',
  '/allocation/runs/[id]',
  '/allocation/runs/[id]/capacity',
  '/allocation/schedules/changed',
  '/allocation/schedules/participants/[applicationId]',
  '/allocation/schedules/stage/[allocationRunId]',
  '/allocation/schedules/stage/draft/[draftId]',
  '/applications/[id]',
  '/participants',
  '/participants/imports',
  '/participants/[applicationId]',
  '/participants/import/[batchId]/confirm',
  '/participants/import/[batchId]/map',
  '/participants/import/[batchId]/preview',
  '/participants/import/[batchId]/rollback',
  '/participants/imports/[batchId]',
];

const ADMIN_SIDEBAR_ROUTES = ADMIN_VERIFIED_ROUTES.filter(
  (route) => !ADMIN_DETAIL_ONLY_ROUTES.includes(route)
);

const PARTICIPANT_VERIFIED_ROUTES = [
  '/my-dashboard',
  '/my-agenda',
  '/schedule',
  '/my-travel',
  '/my-profile',
  '/my-application',
  '/my-qr',
  '/venue-map',
  '/local-info',
];

function collectHrefs(items: NavItem[]): string[] {
  return items.flatMap((item) => [item.href, ...(item.children ? collectHrefs(item.children) : [])]);
}

function allAdminHrefs(): string[] {
  const groupHrefs = (adminNavGroups as NavGroup[]).flatMap((group) => collectHrefs(group.items));
  return [adminDashboardItem.href, ...groupHrefs];
}

describe('admin nav config', () => {
  it('round-trips through JSON.parse(JSON.stringify(...)) without throwing or losing data', () => {
    const roundTripped = JSON.parse(JSON.stringify({ adminDashboardItem, adminNavGroups }));
    expect(roundTripped).toEqual({ adminDashboardItem, adminNavGroups });
  });

  it('contains every verified LIST/PARENT admin route exactly once (detail-only routes intentionally excluded)', () => {
    const hrefs = allAdminHrefs();
    for (const route of ADMIN_SIDEBAR_ROUTES) {
      const occurrences = hrefs.filter((href) => href === route).length;
      expect(occurrences, `expected "${route}" to appear exactly once, found ${occurrences}`).toBe(1);
    }
  });

  it('contains no hrefs outside the verified admin route list', () => {
    const hrefs = allAdminHrefs();
    for (const href of hrefs) {
      expect(ADMIN_VERIFIED_ROUTES, `unexpected href "${href}" not in verified route list`).toContain(href);
    }
  });

  it('never renders a detail-only route (dynamic-segment href or click-through-only hub page) as a sidebar NavItem', () => {
    // Every href actually rendered by the sidebar becomes a clickable
    // next-intl <Link>, which crashes on a literal, unfilled dynamic
    // segment (e.g. "/participants/[applicationId]"). This is the
    // regression test for that exact bug: no config href may contain a
    // "[" or "]" character.
    const hrefs = allAdminHrefs();
    for (const href of hrefs) {
      expect(href, `sidebar NavItem href "${href}" must not contain a dynamic-route placeholder`).not.toMatch(
        /[[\]]/
      );
    }
    // And, independently, confirm every intentionally-excluded detail
    // route really is absent from the rendered sidebar hrefs.
    for (const route of ADMIN_DETAIL_ONLY_ROUTES) {
      expect(hrefs, `detail-only route "${route}" must not be a rendered sidebar NavItem`).not.toContain(route);
    }
  });

  it('places /dashboard first/ungrouped', () => {
    expect(adminDashboardItem.href).toBe('/dashboard');
  });

  it('has exactly 7 groups: Participants, Agenda, Allocation, Attendance, Reporting, Staff, Settings', () => {
    expect(adminNavGroups).toHaveLength(7);
    expect(adminNavGroups.map((g) => g.labelKey)).toEqual([
      'nav.groups.participants',
      'nav.groups.agenda',
      'nav.groups.allocation',
      'nav.groups.attendance',
      'nav.groups.reporting',
      'nav.groups.staff',
      'nav.groups.settings',
    ]);
  });

  it('puts /attendance/scanners, /attendance/admissions, /attendance/walk-in, and /attendance/demand under the Attendance group', () => {
    const attendanceGroup = adminNavGroups.find((g) => g.labelKey === 'nav.groups.attendance');
    expect(attendanceGroup).toBeDefined();
    expect(collectHrefs(attendanceGroup!.items)).toEqual(['/attendance/scanners', '/attendance/admissions', '/attendance/walk-in', '/attendance/demand']);
  });

  it('puts /applications under the Participants group (detail route /applications/[id] intentionally not rendered)', () => {
    const participantsGroup = adminNavGroups.find((g) => g.labelKey === 'nav.groups.participants');
    expect(participantsGroup).toBeDefined();
    const hrefs = collectHrefs(participantsGroup!.items);
    expect(hrefs).toContain('/applications');
    // See the "never renders a detail-only route" test above: this is
    // intentional, not a gap — /applications/[id] is a real route (in
    // ADMIN_VERIFIED_ROUTES / ADMIN_DETAIL_ONLY_ROUTES) reached by
    // clicking through from /applications, not a standalone sidebar link.
    expect(hrefs).not.toContain('/applications/[id]');
  });

  it('puts /participants/care under the Participants group', () => {
    const participantsGroup = adminNavGroups.find((g) => g.labelKey === 'nav.groups.participants');
    expect(participantsGroup).toBeDefined();
    expect(collectHrefs(participantsGroup!.items)).toContain('/participants/care');
  });

  it('puts /participants/travel under the Participants group', () => {
    const participantsGroup = adminNavGroups.find((g) => g.labelKey === 'nav.groups.participants');
    expect(participantsGroup).toBeDefined();
    expect(collectHrefs(participantsGroup!.items)).toContain('/participants/travel');
  });
});

describe('participant nav config', () => {
  it('round-trips through JSON.parse(JSON.stringify(...)) without throwing or losing data', () => {
    const roundTripped = JSON.parse(JSON.stringify(participantNavItems));
    expect(roundTripped).toEqual(participantNavItems);
  });

  it('contains every verified participant route exactly once', () => {
    const hrefs = collectHrefs(participantNavItems);
    for (const route of PARTICIPANT_VERIFIED_ROUTES) {
      const occurrences = hrefs.filter((href) => href === route).length;
      expect(occurrences, `expected "${route}" to appear exactly once, found ${occurrences}`).toBe(1);
    }
  });

  it('contains no hrefs outside the verified participant route list', () => {
    const hrefs = collectHrefs(participantNavItems);
    for (const href of hrefs) {
      expect(PARTICIPANT_VERIFIED_ROUTES, `unexpected href "${href}" not in verified route list`).toContain(href);
    }
  });

  it('is a flat list (no children/groups)', () => {
    for (const item of participantNavItems) {
      expect(item.children).toBeUndefined();
    }
  });
});
