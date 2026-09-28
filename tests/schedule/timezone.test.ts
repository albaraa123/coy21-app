// tests/schedule/timezone.test.ts
import { describe, expect, it } from 'vitest';

// Reuses the exact idiom already established in Phase 3/4
// (toLocaleString('en-US', { timeZone: 'Asia/Muscat' })) — this test
// confirms it against a known UTC instant, since Asia/Muscat is fixed
// UTC+4 with no DST (documented in session-edit-form.tsx).
describe('Asia/Muscat time display', () => {
  it('renders a known UTC instant as the correct Muscat wall-clock time', () => {
    const utc = '2026-09-15T05:30:00Z'; // 05:30 UTC = 09:30 Muscat (UTC+4)
    const formatted = new Date(utc).toLocaleString('en-US', {
      timeZone: 'Asia/Muscat',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(formatted).toBe('09:30');
  });
});
