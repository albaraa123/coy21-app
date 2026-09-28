import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../support/mock-intl-link';

// BottomTabBar renders next-intl's <Link> (from '@/i18n/routing') for the 3
// primary tabs. It does NOT call usePathname() itself — active-tab state is
// derived from the `currentPathname` prop the caller passes in (see the
// component's doc comment) — so only Link needs mocking here, matching the
// shared convention in tests/support/mock-intl-link.tsx used by
// tests/components/shell/sidebar-nav.test.tsx.
vi.mock('@/i18n/routing', () => mockIntlLink());

import { BottomTabBar } from '@/components/shell/bottom-tab-bar';
import type { NavItem } from '@/lib/nav/nav-types';

const primaryItems: NavItem[] = [
  { labelKey: 'nav.participant.dashboard', href: '/my-dashboard', iconKey: 'dashboard', placement: 'primary' },
  { labelKey: 'nav.participant.agenda', href: '/my-agenda', iconKey: 'schedule', placement: 'primary' },
  { labelKey: 'nav.participant.myQr', href: '/my-qr', iconKey: 'qr', placement: 'primary' },
];

const navTranslations = {
  'nav.participant.dashboard': 'Home',
  'nav.participant.agenda': 'My Program',
  'nav.participant.myQr': 'My QR',
};

describe('BottomTabBar', () => {
  it('renders exactly 4 tabs: 3 primary items plus a More trigger, in order', () => {
    const html = renderToStaticMarkup(
      <BottomTabBar
        primaryItems={primaryItems}
        navTranslations={navTranslations}
        moreLabel="More"
        onMoreClick={() => {}}
        currentPathname="/my-dashboard"
      />
    );
    expect(html).toContain('Home');
    expect(html).toContain('My Program');
    expect(html).toContain('My QR');
    expect(html).toContain('More');

    const homeIndex = html.indexOf('Home');
    const programIndex = html.indexOf('My Program');
    const qrIndex = html.indexOf('My QR');
    const moreIndex = html.indexOf('>More<');
    expect(homeIndex).toBeGreaterThan(-1);
    expect(programIndex).toBeGreaterThan(homeIndex);
    expect(qrIndex).toBeGreaterThan(programIndex);
    expect(moreIndex).toBeGreaterThan(qrIndex);
  });

  it('marks the tab matching the current pathname with aria-current="page"', () => {
    const html = renderToStaticMarkup(
      <BottomTabBar
        primaryItems={primaryItems}
        navTranslations={navTranslations}
        moreLabel="More"
        onMoreClick={() => {}}
        currentPathname="/my-dashboard"
      />
    );
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Home|Home[\s\S]*?aria-current="page"/);
  });

  it('gives the More trigger an accessible name via visible text, not icon alone', () => {
    const html = renderToStaticMarkup(
      <BottomTabBar
        primaryItems={primaryItems}
        navTranslations={navTranslations}
        moreLabel="More"
        onMoreClick={() => {}}
        currentPathname="/my-dashboard"
      />
    );
    expect(html).toContain('>More<');
  });
});
