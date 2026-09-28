import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../support/mock-intl-link';

vi.mock('@/i18n/routing', () => mockIntlLink());

vi.mock('next-intl', async () => {
  const en = (await import('@/messages/en.json')).default;
  const ar = (await import('@/messages/ar.json')).default;
  const catalogs: Record<string, typeof en> = { en, ar };
  return {
    useTranslations:
      (namespace: string) =>
      (key: string) => {
        // Tests drive the active locale via a mutable module-level var set
        // right before render (see `setMockLocale` below).
        const messages = catalogs[mockLocale];
        const parts = `${namespace}.${key}`.split('.');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let node: any = messages;
        for (const part of parts) node = node?.[part];
        return node ?? `${namespace}.${key}`;
      },
  };
});

let mockLocale = 'en';
function setMockLocale(locale: 'en' | 'ar') {
  mockLocale = locale;
}

import { NotFoundState } from '@/components/states/not-found-state';

describe('NotFoundState', () => {
  it('renders a real <h2> heading', () => {
    setMockLocale('en');
    const html = renderToStaticMarkup(<NotFoundState />);
    expect(html).toContain('<h2');
  });

  it('renders English copy when locale is en (inline usage, translated)', () => {
    setMockLocale('en');
    const html = renderToStaticMarkup(<NotFoundState />);
    expect(html).toContain('Page not found');
    expect(html).toContain('looking for');
  });

  it('renders Arabic copy when locale is ar (inline usage, translated)', () => {
    setMockLocale('ar');
    const html = renderToStaticMarkup(<NotFoundState />);
    expect(html).toContain('الصفحة غير موجودة');
  });

  it('renders a home link', () => {
    setMockLocale('en');
    const html = renderToStaticMarkup(<NotFoundState />);
    expect(html).toContain('data-testid="intl-link"');
  });

  it('supports a static (non-translated) mode for use at the file-convention not-found.tsx location, which cannot access locale params', () => {
    const html = renderToStaticMarkup(<NotFoundState static />);
    // Falls back to default-locale (ar, per routing.ts) copy without
    // calling useTranslations/relying on route params.
    expect(html).toContain('<h2');
    expect(html).toContain('data-testid="intl-link"');
  });
});
