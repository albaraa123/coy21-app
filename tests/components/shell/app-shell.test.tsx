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
import type { NavGroup } from '@/lib/nav/nav-types';

const navGroups: NavGroup[] = [
  {
    labelKey: 'nav.groups.participants',
    items: [{ labelKey: 'nav.participants.list', href: '/participants', iconKey: 'participants' }],
  },
];

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
});
