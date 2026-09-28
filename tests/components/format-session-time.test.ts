import { describe, expect, it } from 'vitest';
import { formatSessionTime } from '@/components/scanner/format-session-time';

describe('formatSessionTime', () => {
  it('formats start–end time in the Asia/Muscat timezone for English locale', () => {
    const result = formatSessionTime({ startTime: '2026-09-24T09:00:00Z', endTime: '2026-09-24T10:30:00Z' }, 'en');
    // 09:00 UTC = 13:00 Asia/Muscat (UTC+4), 10:30 UTC = 14:30 Asia/Muscat.
    expect(result).toContain('1:00');
    expect(result).toContain('2:30');
    expect(result).toContain('–');
  });

  it('formats using Arabic numerals/locale when locale is "ar"', () => {
    const enResult = formatSessionTime({ startTime: '2026-09-24T09:00:00Z', endTime: '2026-09-24T10:30:00Z' }, 'en');
    const arResult = formatSessionTime({ startTime: '2026-09-24T09:00:00Z', endTime: '2026-09-24T10:30:00Z' }, 'ar');
    expect(arResult).not.toBe(enResult);
  });

  it('treats any non-"ar" locale the same as "en"', () => {
    const enResult = formatSessionTime({ startTime: '2026-09-24T09:00:00Z', endTime: '2026-09-24T10:30:00Z' }, 'en');
    const otherResult = formatSessionTime({ startTime: '2026-09-24T09:00:00Z', endTime: '2026-09-24T10:30:00Z' }, 'fr');
    expect(otherResult).toBe(enResult);
  });
});
