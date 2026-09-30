import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../../support/mock-intl-link';

vi.mock('@/i18n/routing', () => ({
  ...mockIntlLink(),
  usePathname: () => '/participants',
  useRouter: () => ({ replace: vi.fn() }),
  routing: { locales: ['ar', 'en'], defaultLocale: 'ar' },
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => ({ toString: () => '' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('@/app/[locale]/(auth)/actions', () => ({ logOutAction: vi.fn() }));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- test-only stand-in for next/image; alt is forwarded via {...props}, this is not a real page image.
  default: (props: Record<string, unknown>) => <img {...props} />,
}));

import { AppShell } from '@/components/shell/app-shell';
import type { NavGroup, NavItem } from '@/lib/nav/nav-types';

const navGroups: NavGroup[] = [
  {
    labelKey: 'nav.groups.participants',
    items: [{ labelKey: 'nav.participants.list', href: '/participants', iconKey: 'participants' }],
  },
];

const bottomTabItems: NavItem[] = [
  { labelKey: 'nav.participant.dashboard', href: '/my-dashboard', iconKey: 'dashboard', placement: 'primary' },
  { labelKey: 'nav.participant.agenda', href: '/my-agenda', iconKey: 'schedule', placement: 'primary' },
  { labelKey: 'nav.participant.myQr', href: '/my-qr', iconKey: 'qr', placement: 'primary' },
];

const bottomTabNavTranslations = {
  'nav.participant.dashboard': 'Home',
  'nav.participant.agenda': 'My Program',
  'nav.participant.myQr': 'My QR',
};

describe('AppShell (server, SSR markup)', () => {
  it('renders without throwing (no server-side data fetching / no client-only APIs at this layer)', () => {
    expect(() =>
      renderToStaticMarkup(
        <AppShell
          navGroups={navGroups}
          storageKey="rcoy-admin-nav-v1"
          userDisplay={{ name: 'Amina K.', roleLabel: 'Admin' }}
          locale="ar"
          logoutLabel="Log out"
          drawerAriaLabel="Main menu"
          triggerAriaLabel="Open menu"
          navTranslations={{}}
        >
          <p>Page content</p>
        </AppShell>
      )
    ).not.toThrow();
  });

  it('renders the given children inside the shell', () => {
    const html = renderToStaticMarkup(
      <AppShell
        navGroups={navGroups}
        storageKey="rcoy-admin-nav-v1"
        userDisplay={{ name: 'Amina K.', roleLabel: 'Admin' }}
        locale="ar"
        logoutLabel="Log out"
        drawerAriaLabel="Main menu"
        triggerAriaLabel="Open menu"
        navTranslations={{}}
      >
        <p data-testid="page-content">Hello</p>
      </AppShell>
    );
    expect(html).toContain('Hello');
  });

  it('renders the passed userDisplay.name/roleLabel, never fetching or containing its own user data', () => {
    const html = renderToStaticMarkup(
      <AppShell
        navGroups={navGroups}
        storageKey="rcoy-admin-nav-v1"
        userDisplay={{ name: 'Distinctive Test Name', roleLabel: 'Distinctive Role' }}
        locale="ar"
        logoutLabel="Log out"
        drawerAriaLabel="Main menu"
        triggerAriaLabel="Open menu"
        navTranslations={{}}
      >
        <p>content</p>
      </AppShell>
    );
    expect(html).toContain('Distinctive Test Name');
    expect(html).toContain('Distinctive Role');
  });

  it('renders the bottom tab bar and pads <main> with pb-16 when bottomTabItems is provided', () => {
    const html = renderToStaticMarkup(
      <AppShell
        navGroups={navGroups}
        storageKey="rcoy-participant-nav-v1"
        userDisplay={{ name: 'Amina K.', roleLabel: 'Participant' }}
        locale="ar"
        logoutLabel="Log out"
        drawerAriaLabel="Main menu"
        triggerAriaLabel="Open menu"
        navTranslations={bottomTabNavTranslations}
        bottomTabItems={bottomTabItems}
        moreLabel="More"
      >
        <p>Page content</p>
      </AppShell>
    );
    expect(html).toContain('Home');
    expect(html).toContain('My Program');
    expect(html).toContain('My QR');
    expect(html).toContain('>More<');
    expect(html).toMatch(/<main class="[^"]*\bpb-16\b[^"]*"/);
  });

  it('omits the bottom tab bar and pb-16 padding when bottomTabItems is not provided', () => {
    const html = renderToStaticMarkup(
      <AppShell
        navGroups={navGroups}
        storageKey="rcoy-admin-nav-v1"
        userDisplay={{ name: 'Amina K.', roleLabel: 'Admin' }}
        locale="ar"
        logoutLabel="Log out"
        drawerAriaLabel="Main menu"
        triggerAriaLabel="Open menu"
        navTranslations={{}}
      >
        <p>Page content</p>
      </AppShell>
    );
    expect(html).not.toContain('>More<');
    expect(html).toMatch(/<main class="[^"]*"/);
    expect(html).not.toMatch(/<main class="[^"]*\bpb-16\b[^"]*"/);
  });

  it('renders the given sandboxBanner node when provided (Task 6)', () => {
    const html = renderToStaticMarkup(
      <AppShell
        navGroups={navGroups}
        storageKey="rcoy-admin-nav-v1"
        userDisplay={{ name: 'Amina K.', roleLabel: 'Admin' }}
        locale="ar"
        logoutLabel="Log out"
        drawerAriaLabel="Main menu"
        triggerAriaLabel="Open menu"
        navTranslations={{}}
        sandboxBanner={<div data-testid="sandbox-banner">Sandbox mode is ON</div>}
      >
        <p>Page content</p>
      </AppShell>
    );
    expect(html).toContain('Sandbox mode is ON');
    expect(html).toContain('data-testid="sandbox-banner"');
  });

  it('renders nothing extra when sandboxBanner is omitted (participant shell is unaffected)', () => {
    const html = renderToStaticMarkup(
      <AppShell
        navGroups={navGroups}
        storageKey="rcoy-admin-nav-v1"
        userDisplay={{ name: 'Amina K.', roleLabel: 'Admin' }}
        locale="ar"
        logoutLabel="Log out"
        drawerAriaLabel="Main menu"
        triggerAriaLabel="Open menu"
        navTranslations={{}}
      >
        <p>Page content</p>
      </AppShell>
    );
    expect(html).not.toContain('sandbox-banner');
    expect(html).not.toContain('Sandbox');
  });
});
