'use client';

/**
 * Locale switcher. Uses next-intl's usePathname()/useRouter() (from
 * @/i18n/routing) plus next/navigation's useSearchParams() to preserve
 * the current route/params/query across a locale switch.
 *
 * Verified against node_modules/next-intl's real
 * navigation/react-client/createNavigation.d.ts (not assumed from
 * memory): useRouter().replace's signature is
 *   replace(href, options？: NavigateOptions & { locale？: Locale })
 * so `router.replace(pathname, { locale: nextLocale })` is correct.
 *
 * Dynamic route params: next-intl's usePathname() (unlike plain
 * next/navigation's, which can return the literal "[id]" template for
 * some cases) returns the REAL resolved pathname string, e.g.
 * "/participants/abc-123" for a visit to that page — the bracketed
 * placeholder is never present at runtime. So no separate
 * param-extraction/re-substitution logic is needed: passing the
 * as-returned pathname straight to router.replace(pathname, { locale })
 * already carries the resolved dynamic segment through, confirmed via
 * this component's own test (language-switcher.test.tsx) asserting the
 * replace call is made with an unmodified dynamic-looking path string.
 *
 * Query preservation: useSearchParams() from next/navigation returns the
 * current query string; it is appended back onto the pathname before
 * calling replace(), since next-intl's router.replace href argument is a
 * plain pathname (optionally an object), not something that merges in
 * the previous query automatically.
 */

import { useSearchParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/routing';
import { routing } from '@/i18n/routing';
import { computeLocaleSwitchHref, isNoOpLocaleSwitch } from './language-switcher-logic';

const LOCALE_LABELS: Record<string, string> = {
  ar: 'العربية',
  en: 'English',
};

export interface LanguageSwitcherProps {
  currentLocale: string;
}

export function LanguageSwitcher({ currentLocale }: LanguageSwitcherProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  function switchTo(nextLocale: string) {
    if (isNoOpLocaleSwitch(currentLocale, nextLocale)) return;
    const href = computeLocaleSwitchHref(pathname, searchParams.toString());
    router.replace(href, { locale: nextLocale });
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Language">
      {routing.locales.map((locale) => (
        <button
          key={locale}
          type="button"
          onClick={() => switchTo(locale)}
          aria-current={locale === currentLocale ? 'true' : undefined}
          className={`rounded-md px-2 py-1 text-sm font-medium transition-colors ${
            locale === currentLocale
              ? 'bg-charcoal/10 text-charcoal'
              : 'text-charcoal/60 hover:bg-charcoal/5 hover:text-charcoal'
          }`}
        >
          {LOCALE_LABELS[locale] ?? locale}
        </button>
      ))}
    </div>
  );
}
