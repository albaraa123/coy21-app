import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { shouldCloseOnPathnameChange } from '@/components/shell/mobile-drawer-logic';

const mockPathname = '/participants';
const mockLocale = 'ar';

vi.mock('@/i18n/routing', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
  usePathname: () => mockPathname,
}));
vi.mock('next-intl', () => ({
  useLocale: () => mockLocale,
}));
vi.mock('@/lib/nav/icon-map', () => ({ ICON_MAP: {} }));

import { MobileDrawer } from '@/components/shell/mobile-drawer';
import { MobileDrawerTrigger } from '@/components/shell/mobile-drawer-trigger';
import { MobileDrawerProvider } from '@/components/shell/mobile-drawer-context';
import type { NavGroup } from '@/lib/nav/nav-types';

const navGroups: NavGroup[] = [
  { labelKey: 'nav.groups.participants', items: [{ labelKey: 'nav.participants.list', href: '/participants', iconKey: 'participants' }] },
];

// MobileDrawer no longer takes open/onClose/triggerRef as direct props —
// it reads them from MobileDrawerProvider's Context (see
// mobile-drawer-context.tsx), the same provider MobileDrawerTrigger
// writes to. This is the fix for the real RSC bug where AppShell
// (server) previously had to pass a raw onClick FUNCTION across the
// server/client boundary into AppShellClient; both components are now
// wired together purely via Context, with no function prop crossing
// that boundary. SSR markup (renderToStaticMarkup) always starts with
// open=false regardless of trigger presence, since MobileDrawerProvider
// initializes its state with useState(false).
describe('MobileDrawer (SSR markup, via MobileDrawerProvider)', () => {
  it('renders nothing when closed (initial provider state)', () => {
    const html = renderToStaticMarkup(
      <MobileDrawerProvider>
        <MobileDrawer
          navGroups={navGroups}
          storageKey="rcoy-admin-nav-v1"
          ariaLabel="Menu"
          navTranslations={{}}
        />
      </MobileDrawerProvider>
    );
    expect(html).toBe('');
  });

  it('always starts closed: a fresh render produces no dialog markup even with a trigger present', () => {
    const html = renderToStaticMarkup(
      <MobileDrawerProvider>
        <MobileDrawerTrigger ariaLabel="Open menu" />
        <MobileDrawer
          navGroups={navGroups}
          storageKey="rcoy-admin-nav-v1"
          ariaLabel="Menu"
          navTranslations={{}}
        />
      </MobileDrawerProvider>
    );
    expect(html).not.toContain('role="dialog"');
  });

  it('throws if rendered outside a MobileDrawerProvider (composition guard)', () => {
    expect(() =>
      renderToStaticMarkup(
        <MobileDrawer
          navGroups={navGroups}
          storageKey="rcoy-admin-nav-v1"
          ariaLabel="Menu"
          navTranslations={{}}
        />
      )
    ).toThrow(/MobileDrawerProvider/);
  });

  it('trigger and drawer can be instantiated independently as siblings under one provider, proving no function prop is needed to wire them together', () => {
    // This is the shape AppShell (server) actually renders: Topbar gets
    // <MobileDrawerTrigger /> as a plain ReactNode slot prop, and
    // <MobileDrawer /> is rendered separately as its sibling — both
    // wrapped in one MobileDrawerProvider, with zero function values
    // passed as props anywhere in this tree.
    expect(() =>
      renderToStaticMarkup(
        <MobileDrawerProvider>
          <div>{/* stands in for Topbar receiving the trigger as a slot */}<MobileDrawerTrigger ariaLabel="Open menu" /></div>
          <MobileDrawer
            navGroups={navGroups}
            storageKey="rcoy-admin-nav-v1"
            ariaLabel="Menu"
            navTranslations={{}}
          />
        </MobileDrawerProvider>
      )
    ).not.toThrow();
  });

  it('MobileDrawerTrigger throws if rendered outside a MobileDrawerProvider (composition guard)', () => {
    expect(() => renderToStaticMarkup(<MobileDrawerTrigger ariaLabel="Open menu" />)).toThrow(
      /MobileDrawerProvider/
    );
  });
});

// The drawer's close-on-navigation effect keys off `${locale}:${pathname}`
// (see mobile-drawer.tsx) specifically because next-intl's usePathname()
// is locale-agnostic (verified against next-intl's own
// useBasePathname.js) — a pure locale switch on the same route does NOT
// change usePathname()'s return value, so pathname alone would miss it.
// This directly tests that a locale-only change (pathname unchanged) is
// still treated as a change worth closing the drawer over, via the same
// shouldCloseOnPathnameChange comparison the component's effect uses.
describe('close-on-navigate covers locale-only switches (drawer must not stay open across a locale switch)', () => {
  it('a locale change alone (pathname unchanged) is detected as a navigation-key change', () => {
    const before = `${'ar'}:${'/participants'}`;
    const after = `${'en'}:${'/participants'}`; // same route, different locale
    expect(shouldCloseOnPathnameChange(before, after)).toBe(true);
  });

  it('an unchanged locale AND unchanged pathname is correctly treated as no change', () => {
    const before = `${'ar'}:${'/participants'}`;
    const after = `${'ar'}:${'/participants'}`;
    expect(shouldCloseOnPathnameChange(before, after)).toBe(false);
  });

  it('a route change alone (locale unchanged) is still detected, as before', () => {
    const before = `${'ar'}:${'/participants'}`;
    const after = `${'ar'}:${'/agenda'}`;
    expect(shouldCloseOnPathnameChange(before, after)).toBe(true);
  });
});
