import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIntlLink } from '../support/mock-intl-link';

vi.mock('@/i18n/routing', () => mockIntlLink());

import { ErrorState } from '@/components/states/error-state';

describe('ErrorState', () => {
  it('renders a real <h2> heading with the title', () => {
    const html = renderToStaticMarkup(<ErrorState title="Something went wrong" />);
    expect(html).toContain('<h2');
    expect(html).toContain('Something went wrong');
  });

  it('renders description when given', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" description="Please try again." />);
    expect(html).toContain('Please try again.');
  });

  it('does not set role="alert" by default', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" />);
    expect(html).not.toContain('role="alert"');
  });

  it('sets role="alert" only when announce is true', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" announce />);
    expect(html).toContain('role="alert"');
  });

  it('renders a retry button when onRetry is given', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" onRetry={() => {}} />);
    expect(html).toContain('<button');
  });

  it('renders no retry button when onRetry is omitted', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" />);
    expect(html).not.toContain('<button');
  });

  it('renders errorId as muted reference text when given', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" errorId="err_abc123" />);
    expect(html).toContain('err_abc123');
  });

  it('does not render errorId text when omitted', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" />);
    expect(html).not.toContain('err_');
  });

  it('renders technicalDetail inside a collapsed <details> element, hidden by default', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" technicalDetail="TypeError: x is undefined" />);
    expect(html).toContain('<details');
    expect(html).not.toContain('open=""');
    expect(html).not.toContain(' open>');
    expect(html).toContain('TypeError: x is undefined');
  });

  it('renders no <details> element when technicalDetail is omitted', () => {
    const html = renderToStaticMarkup(<ErrorState title="Error" />);
    expect(html).not.toContain('<details');
  });
});
