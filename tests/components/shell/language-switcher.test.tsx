import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeLocaleSwitchHref, isNoOpLocaleSwitch } from '@/components/shell/language-switcher-logic';

// usePathname/useRouter/useSearchParams are hook-based and test-specific
// per the task brief, so mocked locally rather than via the shared
// mock-intl-link helper (which only covers Link).
vi.mock('@/i18n/routing', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
  usePathname: () => '/participants',
  useRouter: () => ({ replace: vi.fn() }),
  routing: { locales: ['ar', 'en'], defaultLocale: 'ar' },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ toString: () => '' }),
}));

import { LanguageSwitcher } from '@/components/shell/language-switcher';

describe('LanguageSwitcher component (SSR markup)', () => {
  it('renders both locale buttons', () => {
    const html = renderToStaticMarkup(<LanguageSwitcher currentLocale="ar" />);
    expect(html).toContain('العربية');
    expect(html).toContain('English');
  });

  it('marks the current locale with aria-current', () => {
    const html = renderToStaticMarkup(<LanguageSwitcher currentLocale="ar" />);
    expect(html).toContain('aria-current="true"');
  });

  it('does not mark the non-current locale with aria-current', () => {
    const html = renderToStaticMarkup(<LanguageSwitcher currentLocale="ar" />);
    // English's button should not carry aria-current at all — split the
    // markup on the English label to check only that button's attributes.
    const englishButtonStart = html.lastIndexOf('<button', html.indexOf('English'));
    const englishButtonMarkup = html.slice(englishButtonStart, html.indexOf('English'));
    expect(englishButtonMarkup).not.toContain('aria-current');
  });
});

// The real navigation behavior (route/param/query preservation) is tested
// directly against the extracted pure logic switchTo() delegates to —
// renderToStaticMarkup cannot fire a real onClick event (no jsdom in this
// repo; see mobile-drawer-logic.ts's doc comment for the same rationale),
// so testing the underlying computation directly is the faithful
// alternative rather than a fake assertion dressed up as a click test.
describe('computeLocaleSwitchHref (route/param/query preservation)', () => {
  it('returns the pathname unchanged when there is no query string', () => {
    expect(computeLocaleSwitchHref('/participants', '')).toBe('/participants');
  });

  it('appends the query string when present', () => {
    expect(computeLocaleSwitchHref('/participants', 'tab=overview&sort=asc')).toBe(
      '/participants?tab=overview&sort=asc'
    );
  });

  it('preserves a resolved dynamic-route pathname verbatim (no re-templating)', () => {
    // next-intl's usePathname() returns the REAL resolved pathname at
    // runtime (e.g. for a visit to /participants/abc-123), never the
    // "[applicationId]" placeholder — confirmed against next-intl's own
    // navigation.d.ts. So computeLocaleSwitchHref needs no separate
    // param-extraction/re-substitution step: the dynamic segment is
    // already baked into the string it's given.
    const dynamicPathname = '/participants/abc-123-def-456-uuid-looking-segment';
    expect(computeLocaleSwitchHref(dynamicPathname, '')).toBe(dynamicPathname);
    expect(computeLocaleSwitchHref(dynamicPathname, '')).not.toContain('[');
  });

  it('preserves both a dynamic pathname AND its query string together', () => {
    const dynamicPathname = '/allocation/runs/run-42';
    expect(computeLocaleSwitchHref(dynamicPathname, 'view=capacity')).toBe(
      '/allocation/runs/run-42?view=capacity'
    );
  });
});

describe('isNoOpLocaleSwitch', () => {
  it('is true when switching to the already-current locale', () => {
    expect(isNoOpLocaleSwitch('ar', 'ar')).toBe(true);
  });

  it('is false when switching to a different locale', () => {
    expect(isNoOpLocaleSwitch('ar', 'en')).toBe(false);
  });
});
