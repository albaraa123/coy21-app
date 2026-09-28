import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../support/mock-intl-link';

vi.mock('@/i18n/routing', () => mockIntlLink());

import { EmptyState } from '@/components/ui/empty-state';

describe('EmptyState', () => {
  it('renders title only when no description/action/icon given (existing behavior)', () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here" />);
    expect(html).toContain('Nothing here');
    expect(html).toContain('role="status"');
  });

  it('renders description when given (existing behavior)', () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here" description="Try again later" />);
    expect(html).toContain('Try again later');
  });

  it('renders an icon when given', () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here" icon={<span data-testid="my-icon">*</span>} />);
    expect(html).toContain('data-testid="my-icon"');
  });

  it('renders an action as a link when action.href is given', () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here" action={{ label: 'Go back', href: '/schedule' }} />);
    expect(html).toContain('data-testid="intl-link"');
    expect(html).toContain('href="/schedule"');
    expect(html).toContain('Go back');
  });

  it('renders an action as a button when action.onClick is given (no href)', () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here" action={{ label: 'Retry', onClick: () => {} }} />);
    expect(html).toContain('<button');
    expect(html).toContain('Retry');
    expect(html).not.toContain('data-testid="intl-link"');
  });

  it('renders no action markup when action is omitted', () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here" />);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-testid="intl-link"');
  });
});
