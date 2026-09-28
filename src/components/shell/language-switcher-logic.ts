/**
 * Pure logic for LanguageSwitcher's locale-switch navigation, split out
 * so it's directly unit-testable without needing to fire a real onClick
 * through a DOM (this repo has no jsdom — renderToStaticMarkup cannot
 * execute event handlers). See mobile-drawer-logic.ts for the same
 * extraction rationale applied here.
 */

/**
 * Computes the href to pass to next-intl's router.replace(href, { locale })
 * when switching locale: the current (already-resolved, no bracket
 * placeholders) pathname with the current query string re-appended, since
 * next-intl's router.replace href argument does not automatically merge
 * in a previous query string.
 */
export function computeLocaleSwitchHref(pathname: string, queryString: string): string {
  return queryString ? `${pathname}?${queryString}` : pathname;
}

/** True if switching to `nextLocale` is a no-op (already the current locale). */
export function isNoOpLocaleSwitch(currentLocale: string, nextLocale: string): boolean {
  return currentLocale === nextLocale;
}
