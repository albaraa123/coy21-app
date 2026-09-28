import { describe, expect, it } from 'vitest';
import { isItemActive, isGroupActive } from '@/lib/nav/route-matching';
import type { NavGroup, NavItem } from '@/lib/nav/nav-types';

describe('isItemActive', () => {
  it('matches an exact href', () => {
    const item: NavItem = { labelKey: 'nav.agenda', href: '/agenda', iconKey: 'agenda' };
    expect(isItemActive(item, '/agenda')).toBe(true);
  });

  it('matches a child route under the href (path-segment boundary)', () => {
    const item: NavItem = { labelKey: 'nav.agenda', href: '/agenda', iconKey: 'agenda' };
    expect(isItemActive(item, '/agenda/days')).toBe(true);
    expect(isItemActive(item, '/agenda/sessions/abc-123')).toBe(true);
  });

  it('does NOT match a false-positive prefix (segment boundary guard)', () => {
    const item: NavItem = { labelKey: 'nav.agenda', href: '/agenda', iconKey: 'agenda' };
    expect(isItemActive(item, '/agenda-typo')).toBe(false);
  });

  it('strips the locale prefix before comparing', () => {
    const item: NavItem = { labelKey: 'nav.agenda', href: '/agenda', iconKey: 'agenda' };
    expect(isItemActive(item, '/en/agenda')).toBe(true);
    expect(isItemActive(item, '/ar/agenda')).toBe(true);
    expect(isItemActive(item, '/en/agenda/days')).toBe(true);
  });

  it('strips a query string before comparing', () => {
    const item: NavItem = { labelKey: 'nav.agenda', href: '/agenda', iconKey: 'agenda' };
    expect(isItemActive(item, '/en/agenda?tab=days')).toBe(true);
    expect(isItemActive(item, '/agenda-typo?x=1')).toBe(false);
  });

  it('matches a dynamic-segment config href against its static parent segment', () => {
    // Config href literally contains the placeholder token (e.g.
    // "/participants/[applicationId]"), which can never equal a real
    // runtime pathname (which has a real UUID/id in that position, not the
    // literal string "[applicationId]"). We match on the static PARENT
    // segment instead — i.e. everything before the first bracketed dynamic
    // segment — so the whole section (list + detail pages) is treated as
    // one active unit.
    const item: NavItem = {
      labelKey: 'nav.participantDetail',
      href: '/participants/[applicationId]',
      iconKey: 'participants',
    };
    expect(isItemActive(item, '/en/participants/abc-123')).toBe(true);
    expect(isItemActive(item, '/participants/abc-123')).toBe(true);
    expect(isItemActive(item, '/participants')).toBe(true);
  });

  it('does not false-match a sibling static route that merely shares the parent prefix', () => {
    const item: NavItem = {
      labelKey: 'nav.participantDetail',
      href: '/participants/[applicationId]',
      iconKey: 'participants',
    };
    // "/participants-typo" must not match, same segment-boundary guard.
    expect(isItemActive(item, '/participants-typo')).toBe(false);
  });

  it('matches deep dynamic segments correctly against their static parent', () => {
    const item: NavItem = {
      labelKey: 'nav.allocationRun',
      href: '/allocation/runs/[id]/capacity',
      iconKey: 'allocation',
    };
    // Static parent is "/allocation/runs" (segment before the first "[..]").
    expect(isItemActive(item, '/en/allocation/runs/xyz-1/capacity')).toBe(true);
    expect(isItemActive(item, '/en/allocation/runs/xyz-1')).toBe(true);
    expect(isItemActive(item, '/en/allocation/runs')).toBe(true);
  });

  it('returns false when there is no match', () => {
    const item: NavItem = { labelKey: 'nav.agenda', href: '/agenda', iconKey: 'agenda' };
    expect(isItemActive(item, '/en/allocation')).toBe(false);
  });

  it('recurses into children to determine active state', () => {
    const item: NavItem = {
      labelKey: 'nav.agenda',
      href: '/agenda',
      iconKey: 'agenda',
      children: [{ labelKey: 'nav.agendaDays', href: '/agenda/days', iconKey: 'agenda' }],
    };
    expect(isItemActive(item, '/en/agenda/days')).toBe(true);
  });
});

describe('isGroupActive', () => {
  it('is active if any child item is active', () => {
    const group: NavGroup = {
      labelKey: 'nav.groups.agenda',
      items: [
        { labelKey: 'nav.agenda', href: '/agenda', iconKey: 'agenda' },
        { labelKey: 'nav.allocation', href: '/allocation', iconKey: 'allocation' },
      ],
    };
    expect(isGroupActive(group, '/en/allocation/runs')).toBe(true);
  });

  it('is inactive when no child item matches', () => {
    const group: NavGroup = {
      labelKey: 'nav.groups.agenda',
      items: [{ labelKey: 'nav.agenda', href: '/agenda', iconKey: 'agenda' }],
    };
    expect(isGroupActive(group, '/en/allocation')).toBe(false);
  });
});
