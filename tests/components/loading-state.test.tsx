import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { LoadingState } from '@/components/states/loading-state';

describe('LoadingState', () => {
  it('defaults to the "page" variant with aria-live="polite"', () => {
    const html = renderToStaticMarkup(<LoadingState />);
    expect(html).toContain('aria-live="polite"');
  });

  it('renders a label when given, for the page variant', () => {
    const html = renderToStaticMarkup(<LoadingState variant="page" label="Loading schedule…" />);
    expect(html).toContain('Loading schedule…');
    expect(html).toContain('aria-live="polite"');
  });

  it('renders the section variant with aria-live="polite"', () => {
    const html = renderToStaticMarkup(<LoadingState variant="section" label="Loading sessions…" />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Loading sessions…');
  });

  it('renders the inline variant without a live-region wrapper', () => {
    const html = renderToStaticMarkup(<LoadingState variant="inline" />);
    expect(html).not.toContain('aria-live');
  });

  it('renders the table variant composed of Skeleton rows with the default row/column count', () => {
    const html = renderToStaticMarkup(<LoadingState variant="table" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading"');
  });

  it('renders exactly one role="status" region that is NOT itself inside an aria-hidden subtree (the live region SRs actually announce)', () => {
    const html = renderToStaticMarkup(<LoadingState variant="table" rows={3} columns={3} />);
    // The outer wrapper carries role="status" directly (not nested inside
    // any aria-hidden ancestor); every per-cell Skeleton's role="status"
    // lives inside the aria-hidden="true" row wrapper, so it is pruned from
    // the accessibility tree even though the attribute is still present in
    // the raw HTML. Assert the outer wrapper's role="status" appears before
    // the first aria-hidden="true" row wrapper, proving it sits outside it.
    const statusIndex = html.indexOf('role="status"');
    const ariaHiddenIndex = html.indexOf('aria-hidden="true"');
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(ariaHiddenIndex).toBeGreaterThan(statusIndex);
  });

  it('hides the per-cell skeleton grid from the accessibility tree for the table variant', () => {
    const html = renderToStaticMarkup(<LoadingState variant="table" rows={2} columns={2} />);
    expect(html).toContain('aria-hidden="true"');
  });

  it('wraps every row inside the aria-hidden subtree, so no per-cell role="status" is exposed to the accessibility tree', () => {
    const html = renderToStaticMarkup(<LoadingState variant="table" rows={3} columns={3} />);
    const rowWrapperCount = (html.match(/aria-hidden="true"/g) ?? []).length;
    // 3 rows -> 3 aria-hidden row wrappers, each containing that row's
    // per-cell role="status" Skeletons.
    expect(rowWrapperCount).toBe(3);
  });

  it('renders the table variant with a configurable row count (more skeleton cells)', () => {
    const htmlDefault = renderToStaticMarkup(<LoadingState variant="table" rows={3} columns={2} />);
    const htmlMore = renderToStaticMarkup(<LoadingState variant="table" rows={6} columns={2} />);
    const countSkeletons = (html: string) => (html.match(/animate-pulse/g) ?? []).length;
    expect(countSkeletons(htmlMore)).toBeGreaterThan(countSkeletons(htmlDefault));
  });

  it('renders the table variant with a configurable column count (more skeleton cells)', () => {
    const htmlFewer = renderToStaticMarkup(<LoadingState variant="table" rows={2} columns={2} />);
    const htmlMore = renderToStaticMarkup(<LoadingState variant="table" rows={2} columns={5} />);
    const countSkeletons = (html: string) => (html.match(/animate-pulse/g) ?? []).length;
    expect(countSkeletons(htmlMore)).toBeGreaterThan(countSkeletons(htmlFewer));
  });
});
