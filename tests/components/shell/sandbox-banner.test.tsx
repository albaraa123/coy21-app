// tests/components/shell/sandbox-banner.test.tsx
//
// SandboxBanner is an async Server Component that calls next-intl's
// getTranslations, which needs a real request context this Vitest
// environment doesn't provide. Mocking next-intl/server here (rather than
// rendering it live) lets these tests exercise the component's actual
// branching logic — real messages/en.json copy, real interpolation — while
// staying isolated, same as this repo's other no-jsdom
// renderToStaticMarkup-based component tests.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '@/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async ({ namespace }: { namespace: string }) => {
    const [, sub] = namespace.split('.');
    const messages = (en.shell as Record<string, unknown>)[sub] as Record<string, string>;
    return (key: string, values?: Record<string, string>) => {
      let text = messages[key];
      for (const [k, v] of Object.entries(values ?? {})) {
        text = text.replace(`{${k}}`, v);
      }
      return text;
    };
  },
}));

describe('SandboxBanner', () => {
  it('shows the redirect-target message when a recipient is configured', async () => {
    const { SandboxBanner } = await import('@/components/shell/sandbox-banner');
    const html = renderToStaticMarkup(
      await SandboxBanner({ locale: 'en', recipientEmail: 'sandbox-inbox@example.com' })
    );

    expect(html).toContain(en.shell.sandboxBanner.activeWithRecipient.replace('{email}', 'sandbox-inbox@example.com'));
    expect(html).not.toContain(en.shell.sandboxBanner.activeWithoutRecipient);
  });

  it('shows the sending-blocked message when no recipient is configured', async () => {
    const { SandboxBanner } = await import('@/components/shell/sandbox-banner');
    const html = renderToStaticMarkup(await SandboxBanner({ locale: 'en', recipientEmail: null }));

    expect(html).toContain(en.shell.sandboxBanner.activeWithoutRecipient);
    expect(html).not.toContain('null');
  });

  it('renders as an alert region', async () => {
    const { SandboxBanner } = await import('@/components/shell/sandbox-banner');
    const html = renderToStaticMarkup(await SandboxBanner({ locale: 'en', recipientEmail: null }));

    expect(html).toContain('role="alert"');
  });
});
