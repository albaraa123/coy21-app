import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../support/mock-intl-link';

vi.mock('@/i18n/routing', () => mockIntlLink());

import { MaintenanceState } from '@/components/states/maintenance-state';

describe('MaintenanceState', () => {
  it('renders a real <h2> heading with the title', () => {
    const html = renderToStaticMarkup(<MaintenanceState title="Under maintenance" description="Back soon." />);
    expect(html).toContain('<h2');
    expect(html).toContain('Under maintenance');
  });

  it('renders the description', () => {
    const html = renderToStaticMarkup(<MaintenanceState title="Under maintenance" description="We'll be back shortly." />);
    expect(html).toContain('back shortly.');
  });

  it('renders retryAt when given', () => {
    const html = renderToStaticMarkup(
      <MaintenanceState title="Under maintenance" description="Back soon." retryAt="2026-08-01T10:00:00.000Z" />
    );
    expect(html).toContain('2026-08-01T10:00:00.000Z');
  });

  it('does not render any retry-time text when retryAt is omitted (never invented)', () => {
    const html = renderToStaticMarkup(<MaintenanceState title="Under maintenance" description="Back soon." />);
    expect(html).not.toContain('2026');
    expect(html).not.toMatch(/back (at|by)/i);
  });

  it('renders a contact action link when contactAction is given', () => {
    const html = renderToStaticMarkup(
      <MaintenanceState
        title="Under maintenance"
        description="Back soon."
        contactAction={{ label: 'Contact support', href: '/contact' }}
      />
    );
    expect(html).toContain('data-testid="intl-link"');
    expect(html).toContain('href="/contact"');
    expect(html).toContain('Contact support');
  });

  it('renders no contact link when contactAction is omitted', () => {
    const html = renderToStaticMarkup(<MaintenanceState title="Under maintenance" description="Back soon." />);
    expect(html).not.toContain('data-testid="intl-link"');
  });
});
