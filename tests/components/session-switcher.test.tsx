import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ScannerSessionContext } from '@/lib/attendance/scanner-assignment-context';

// ScannerClient pulls in qr-scanner (Web Worker/BarcodeDetector, browser
// camera APIs) and several browser-only hooks (wake lock, service worker,
// network status) — none of which are meaningful or safe under a Node
// static-markup render. Mocked out here so this test is scoped purely to
// SessionSwitcher's own new logic (Phase 9.1: picker visibility, default
// selection, option labels) rather than re-testing ScannerClient's
// internals, which already have their own dedicated test files.
vi.mock('@/components/scanner/scanner-client', () => ({
  ScannerClient: ({ sessionId }: { sessionId: string }) => <div data-testid="scanner-client" data-session-id={sessionId} />,
}));

vi.mock('next-intl', async () => {
  const en = (await import('@/messages/en.json')).default;
  return {
    useTranslations:
      (namespace: string) =>
      (key: string) => {
        const parts = `${namespace}.${key}`.split('.');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let node: any = en;
        for (const part of parts) node = node?.[part];
        return node ?? `${namespace}.${key}`;
      },
  };
});

import { SessionSwitcher } from '@/components/scanner/session-switcher';

function session(overrides: Partial<ScannerSessionContext> & { sessionId: string }): ScannerSessionContext {
  return {
    titleAr: 'جلسة',
    titleEn: 'Session',
    startTime: '2026-09-24T09:00:00Z',
    endTime: '2026-09-24T10:00:00Z',
    status: 'confirmed',
    roomId: 'room-1',
    roomCode: 'R1',
    roomNameAr: 'قاعة',
    roomNameEn: 'Room',
    ...overrides,
  };
}

describe('SessionSwitcher', () => {
  it('renders no <select> picker when there is exactly one ready session', () => {
    const html = renderToStaticMarkup(<SessionSwitcher sessions={[session({ sessionId: 's1' })]} locale="en" />);
    expect(html).not.toContain('<select');
  });

  it('renders a <select> picker with one <option> per session when there is more than one', () => {
    const html = renderToStaticMarkup(
      <SessionSwitcher
        sessions={[session({ sessionId: 's1', titleEn: 'Session A' }), session({ sessionId: 's2', titleEn: 'Session B' })]}
        locale="en"
      />
    );
    expect(html).toContain('<select');
    expect(html).toContain('Session A');
    expect(html).toContain('Session B');
  });

  it('mounts ScannerClient with the FIRST session as the default selection', () => {
    const html = renderToStaticMarkup(
      <SessionSwitcher
        sessions={[session({ sessionId: 's1', titleEn: 'First' }), session({ sessionId: 's2', titleEn: 'Second' })]}
        locale="en"
      />
    );
    expect(html).toContain('data-session-id="s1"');
    expect(html).not.toContain('data-session-id="s2"');
  });

  it('displays the selected (first) session\'s own title/room/time in the always-visible detail card', () => {
    const html = renderToStaticMarkup(
      <SessionSwitcher
        sessions={[session({ sessionId: 's1', titleEn: 'Keynote', roomNameEn: 'Main Hall' })]}
        locale="en"
      />
    );
    expect(html).toContain('Keynote');
    expect(html).toContain('Main Hall');
  });

  it('uses the Arabic title/room fields when locale is "ar"', () => {
    const html = renderToStaticMarkup(
      <SessionSwitcher
        sessions={[session({ sessionId: 's1', titleAr: 'الافتتاح', titleEn: 'Opening', roomNameAr: 'القاعة الرئيسية', roomNameEn: 'Main Hall' })]}
        locale="ar"
      />
    );
    expect(html).toContain('الافتتاح');
    expect(html).toContain('القاعة الرئيسية');
    expect(html).not.toContain('Opening');
  });
});
