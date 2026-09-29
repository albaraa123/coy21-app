import { describe, it, expect } from 'vitest';
import { participantNavItems } from '@/lib/nav/participant-nav-config';

describe('participantNavItems placement partition', () => {
  it('has exactly 4 primary items: dashboard, my-agenda, my-qr, and a more-trigger placeholder is NOT one of them', () => {
    const primary = participantNavItems.filter((i) => i.placement === 'primary');
    const hrefs = primary.map((i) => i.href).sort();
    expect(hrefs).toEqual(['/my-agenda', '/my-dashboard', '/my-qr'].sort());
  });

  it('has exactly 6 "more" items: schedule, my-application, my-travel, venue-map, local-info, my-profile', () => {
    const more = participantNavItems.filter((i) => i.placement === 'more');
    const hrefs = more.map((i) => i.href).sort();
    expect(hrefs).toEqual(
      ['/schedule', '/my-application', '/my-travel', '/venue-map', '/local-info', '/my-profile'].sort()
    );
  });

  it('every item has a placement of either primary or more (no unassigned items)', () => {
    for (const item of participantNavItems) {
      expect(['primary', 'more']).toContain(item.placement);
    }
  });
});
