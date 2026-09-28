import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../support/mock-intl-link';

vi.mock('@/i18n/routing', () => mockIntlLink());

import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders a plain <button> element when no href is given', () => {
    const html = renderToStaticMarkup(<Button>Click me</Button>);
    expect(html).toContain('<button');
    expect(html).not.toContain('data-testid="intl-link"');
    expect(html).toContain('Click me');
  });

  it('renders the next-intl Link (not a <button>) when href is given', () => {
    const html = renderToStaticMarkup(<Button href="/schedule">Go</Button>);
    expect(html).toContain('data-testid="intl-link"');
    expect(html).toContain('href="/schedule"');
    expect(html).not.toContain('<button');
  });

  it('applies the primary variant class by default', () => {
    const html = renderToStaticMarkup(<Button>Primary</Button>);
    expect(html).toContain('bg-turquoise');
  });

  it('applies the secondary variant class', () => {
    const html = renderToStaticMarkup(<Button variant="secondary">Secondary</Button>);
    expect(html).toContain('border-charcoal');
  });

  it('applies the ghost variant class', () => {
    const html = renderToStaticMarkup(<Button variant="ghost">Ghost</Button>);
    expect(html).toContain('bg-transparent');
  });

  it('applies the destructive variant class', () => {
    const html = renderToStaticMarkup(<Button variant="destructive">Revoke</Button>);
    expect(html).toContain('border-red-700');
    expect(html).toContain('text-red-700');
  });

  it('applies size classes for sm/md/lg', () => {
    const sm = renderToStaticMarkup(<Button size="sm">S</Button>);
    const md = renderToStaticMarkup(<Button size="md">M</Button>);
    const lg = renderToStaticMarkup(<Button size="lg">L</Button>);
    expect(sm).not.toEqual(md);
    expect(md).not.toEqual(lg);
  });

  it('includes a visible focus ring using the turquoise token', () => {
    const html = renderToStaticMarkup(<Button>Focusable</Button>);
    expect(html).toContain('focus-visible:ring-turquoise');
  });

  it('applies variant/size classes on the link path too', () => {
    const html = renderToStaticMarkup(
      <Button href="/schedule" variant="secondary" size="lg">
        Link
      </Button>
    );
    expect(html).toContain('border-charcoal');
  });

  it('defaults to type="button" so it never accidentally submits an enclosing form', () => {
    const html = renderToStaticMarkup(<Button>Click me</Button>);
    expect(html).toContain('type="button"');
  });

  it('allows an explicit type="submit" to override the default', () => {
    const html = renderToStaticMarkup(<Button type="submit">Save</Button>);
    expect(html).toContain('type="submit"');
    expect(html).not.toContain('type="button"');
  });
});
