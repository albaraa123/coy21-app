/**
 * Shared factory for mocking next-intl's `Link` (from `@/i18n/routing`).
 *
 * Every `.tsx` component test in tests/components/ that renders something
 * built on next-intl's `Link` needs the same mock: a plain `<a>` tagged with
 * `data-testid="intl-link"` so assertions can tell it apart from a raw
 * `<button>`. Centralized here instead of copy-pasted per file — call sites
 * do:
 *
 *   import { mockIntlLink } from '../support/mock-intl-link';
 *   vi.mock('@/i18n/routing', () => mockIntlLink());
 *
 * Note: vitest hoists `vi.mock(...)` calls above this file's own imports, so
 * `mockIntlLink` is not yet initialized at the moment the `vi.mock` call
 * itself is evaluated. Passing `mockIntlLink` directly as the factory
 * therefore throws "Cannot access before initialization". Wrapping it in
 * `() => mockIntlLink()` defers the reference until vitest actually invokes
 * the factory (after all imports have resolved), which works correctly.
 */
export function mockIntlLink() {
  return {
    Link: ({ href, className, children, ...rest }: { href: string; className?: string; children: React.ReactNode }) => (
      <a href={href} className={className} data-testid="intl-link" {...rest}>
        {children}
      </a>
    ),
  };
}
