// tests/email/html-template.test.ts
import { describe, it, expect } from 'vitest';
import { buildBrandedEmailHtml } from '@/lib/email/html-template';

const BASE_PARAMS = {
  locale: 'en' as const,
  heading: 'Test Heading',
  paragraphs: ['First paragraph.', 'Second paragraph.'],
  logoUrl: 'https://example.com/brand/logo/logo-horizontal-white.png',
};

describe('buildBrandedEmailHtml', () => {
  it('renders the logo image with the given URL', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).toContain('https://example.com/brand/logo/logo-horizontal-white.png');
    expect(html).toContain('<img');
  });

  it('renders every paragraph as its own <p>', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).toContain('First paragraph.');
    expect(html).toContain('Second paragraph.');
    expect((html.match(/<p/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('converts a single newline within one paragraph into <br>, not a dropped character or a new <p>', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      paragraphs: ['Previous time: 10:00\nNew time: 11:00'],
    });
    expect(html).toContain('Previous time: 10:00<br');
    expect(html).toContain('New time: 11:00');
    expect(html).not.toContain('Previous time: 10:00\nNew time: 11:00');
  });

  it('renders no badge markup when badge is omitted', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).not.toContain('ACCEPTED');
  });

  it('renders a green badge with the given label when badge.color is green', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      badge: { label: 'ACCEPTED', color: 'green' },
    });
    expect(html).toContain('ACCEPTED');
    expect(html).toContain('#3d9920');
  });

  it('renders a red badge with the given label when badge.color is red', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      badge: { label: 'APPLICATION UPDATE', color: 'red' },
    });
    expect(html).toContain('APPLICATION UPDATE');
    expect(html).toContain('#c0392b');
  });

  it('renders a blue badge with the given label when badge.color is blue', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      badge: { label: 'REMINDER', color: 'blue' },
    });
    expect(html).toContain('REMINDER');
    expect(html).toContain('#019de6');
  });

  it('renders a gold badge with the given label when badge.color is gold', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      badge: { label: 'CANCELLED', color: 'gold' },
    });
    expect(html).toContain('CANCELLED');
    expect(html).toContain('#b8860b');
  });

  it('renders a CTA button with the given label and URL when cta is provided', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      cta: { label: 'View My Application', url: 'https://example.com/my-application' },
    });
    expect(html).toContain('View My Application');
    expect(html).toContain('https://example.com/my-application');
  });

  it('renders no CTA markup when cta is omitted', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).not.toContain('my-application');
  });

  it('HTML-escapes interpolated heading and paragraph text', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      heading: '<script>alert(1)</script>',
      paragraphs: ['<img src=x onerror=alert(1)>'],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('sets dir="rtl" for Arabic locale and dir="ltr" for English', () => {
    const ar = buildBrandedEmailHtml({ ...BASE_PARAMS, locale: 'ar' });
    const en = buildBrandedEmailHtml({ ...BASE_PARAMS, locale: 'en' });
    expect(ar).toContain('dir="rtl"');
    expect(en).toContain('dir="ltr"');
  });

  it('includes the COY21 footer text', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).toContain('COY21');
    expect(html).toContain('Antalya');
  });
});
