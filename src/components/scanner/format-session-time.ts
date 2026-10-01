// src/components/scanner/format-session-time.ts
//
// Pure formatting helper, extracted from session-switcher.tsx (previously
// duplicated inline in scanner/page.tsx before Phase 9.1) so it has a
// single definition and is directly unit-testable without rendering React.
import { formatConferenceTime } from '@/lib/datetime/conference-time';

export function formatSessionTime(session: { startTime: string; endTime: string }, locale: string): string {
  const resolvedLocale = locale === 'ar' ? 'ar' : 'en';
  return `${formatConferenceTime(session.startTime, resolvedLocale)} – ${formatConferenceTime(session.endTime, resolvedLocale)}`;
}
