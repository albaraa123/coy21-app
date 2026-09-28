import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from '@/components/ui/badge';

const VARIANTS = ['mandatory', 'elective', 'cancelled', 'changed', 'pending', 'neutral'] as const;

describe('Badge', () => {
  it('renders a visually distinct class string for every variant (no two variants collide)', () => {
    const htmlByVariant = new Map<string, string>();
    for (const variant of VARIANTS) {
      htmlByVariant.set(variant, renderToStaticMarkup(<Badge variant={variant}>{variant}</Badge>));
    }

    const seen = new Map<string, string>();
    for (const [variant, html] of htmlByVariant) {
      const classMatch = html.match(/class="([^"]*)"/);
      const classes = classMatch?.[1] ?? '';
      const prior = seen.get(classes);
      expect(prior, `variant "${variant}" has the same classes as "${prior}": ${classes}`).toBeUndefined();
      seen.set(classes, variant);
    }
  });

  it('keeps the cancelled variant strikethrough', () => {
    const html = renderToStaticMarkup(<Badge variant="cancelled">Cancelled</Badge>);
    expect(html).toContain('line-through');
  });
});
