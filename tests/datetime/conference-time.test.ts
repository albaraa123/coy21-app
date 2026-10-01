// tests/datetime/conference-time.test.ts
import { describe, it, expect } from 'vitest';
import {
  CONFERENCE_TIMEZONE_OFFSET_MS,
  formatConferenceTime,
  formatConferenceDate,
  isoToConferenceLocalInputValue,
  conferenceLocalInputValueToIso,
} from '@/lib/datetime/conference-time';

describe('conference-time', () => {
  it('CONFERENCE_TIMEZONE_OFFSET_MS is exactly 3 hours', () => {
    expect(CONFERENCE_TIMEZONE_OFFSET_MS).toBe(3 * 60 * 60 * 1000);
  });

  it('formatConferenceTime renders the Istanbul-local wall-clock time (en, 12h)', () => {
    // 2026-11-05T09:30:00Z -> Istanbul (UTC+3) = 12:30 PM
    const result = formatConferenceTime('2026-11-05T09:30:00Z', 'en');
    expect(result).toBe('12:30 PM');
  });

  it('formatConferenceTime supports a 24-hour override via hour12: false', () => {
    const result = formatConferenceTime('2026-11-05T09:30:00Z', 'en', { hour12: false });
    expect(result).toBe('12:30');
  });

  it('formatConferenceDate renders the Istanbul-local calendar date (en)', () => {
    // 2026-11-05T22:00:00Z -> Istanbul = 2026-11-06T01:00 -> next calendar day
    const result = formatConferenceDate('2026-11-05T22:00:00Z', 'en');
    expect(result).toContain('November 6, 2026');
  });

  it('isoToConferenceLocalInputValue converts a UTC instant to the Istanbul wall-clock datetime-local string', () => {
    const result = isoToConferenceLocalInputValue('2026-11-05T09:30:00.000Z');
    expect(result).toBe('2026-11-05T12:30');
  });

  it('conferenceLocalInputValueToIso converts an Istanbul wall-clock string back to the correct UTC instant', () => {
    const result = conferenceLocalInputValueToIso('2026-11-05T12:30');
    expect(new Date(result).toISOString()).toBe('2026-11-05T09:30:00.000Z');
  });

  it('round-trips isoToConferenceLocalInputValue -> conferenceLocalInputValueToIso losslessly', () => {
    const original = '2026-11-05T14:45:00.000Z';
    const local = isoToConferenceLocalInputValue(original);
    const roundTripped = conferenceLocalInputValueToIso(local);
    expect(new Date(roundTripped).getTime()).toBe(new Date(original).getTime());
  });
});
