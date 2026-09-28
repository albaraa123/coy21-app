import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../support/mock-intl-link';

vi.mock('@/i18n/routing', () => mockIntlLink());

import { UnauthorizedState } from '@/components/states/unauthorized-state';

describe('UnauthorizedState', () => {
  it('renders a real <h2> heading', () => {
    const html = renderToStaticMarkup(<UnauthorizedState destination={{ href: '/dashboard', label: 'Go to dashboard' }} />);
    expect(html).toContain('<h2');
  });

  it('renders the passed-in destination as a link, never a hardcoded fallback', () => {
    const html = renderToStaticMarkup(
      <UnauthorizedState destination={{ href: '/staff/dashboard', label: 'Back to my dashboard' }} />
    );
    expect(html).toContain('data-testid="intl-link"');
    expect(html).toContain('href="/staff/dashboard"');
    expect(html).toContain('Back to my dashboard');
  });

  it('renders a different destination when a different one is passed (proves no hardcoding)', () => {
    const html = renderToStaticMarkup(
      <UnauthorizedState destination={{ href: '/portal/home', label: 'Return to portal home' }} />
    );
    expect(html).toContain('href="/portal/home"');
    expect(html).toContain('Return to portal home');
    expect(html).not.toContain('/dashboard"');
  });

  it('reveals no page-specific or role-specific strings beyond destination.label', () => {
    const destinationLabel = 'Back to my dashboard';
    const html = renderToStaticMarkup(
      <UnauthorizedState destination={{ href: '/staff/dashboard', label: destinationLabel }} />
    );
    // Forbidden: role names, admin/permission jargon, or naming what the
    // blocked page was/contained.
    const forbidden = [
      'admin',
      'staff-only',
      'role',
      'permission',
      'organizer',
      'reviewer',
      'you tried to access',
      'you attempted',
    ];
    const lowerHtml = html.toLowerCase();
    for (const word of forbidden) {
      expect(lowerHtml).not.toContain(word);
    }
  });
});
