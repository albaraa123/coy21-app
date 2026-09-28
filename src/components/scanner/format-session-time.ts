// src/components/scanner/format-session-time.ts
//
// Pure formatting helper, extracted from session-switcher.tsx (previously
// duplicated inline in scanner/page.tsx before Phase 9.1) so it has a
// single definition and is directly unit-testable without rendering React.
export function formatSessionTime(session: { startTime: string; endTime: string }, locale: string): string {
  const formatter = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-US', {
    timeZone: 'Asia/Muscat',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${formatter.format(new Date(session.startTime))} – ${formatter.format(new Date(session.endTime))}`;
}
