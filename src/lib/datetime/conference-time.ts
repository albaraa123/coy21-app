// src/lib/datetime/conference-time.ts
//
// Turkey (host country for COY21, Antalya, Nov 2026) abolished DST in 2016
// and has observed a permanent UTC+3 offset ("TRT") year-round since. This
// means conference-local time can be computed with plain fixed-offset
// arithmetic rather than a full IANA-aware timezone library. If Turkey ever
// reintroduces DST, this constant (and the two conversion functions below)
// would need to become DST-aware — see
// docs/superpowers/specs/2026-10-01-timezone-unification-design.md for the
// full investigation this module replaces (17 files hardcoding the wrong
// 'Asia/Muscat' zone, plus 4 files using the invalid, crash-inducing
// 'Asia/Istanbul' string).
export const CONFERENCE_TIMEZONE_OFFSET_MS = 3 * 60 * 60 * 1000;

type Locale = 'ar' | 'en';

function toIntlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar' : 'en-US';
}

export function formatConferenceTime(
  iso: string,
  locale: Locale,
  options?: { hour12?: boolean }
): string {
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    timeZone: 'Europe/Istanbul',
    hour: 'numeric',
    minute: '2-digit',
    hour12: options?.hour12 ?? true,
  }).format(new Date(iso));
}

export function formatConferenceDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
    timeZone: 'Europe/Istanbul',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso));
}

// ISO instant (from the DB) -> the wall-clock time an Istanbul-based staff
// member should see in a `datetime-local` input, formatted as the
// `YYYY-MM-DDTHH:mm` string that input requires.
export function isoToConferenceLocalInputValue(iso: string): string {
  const utcMs = new Date(iso).getTime();
  const istanbulMs = utcMs + CONFERENCE_TIMEZONE_OFFSET_MS;
  const d = new Date(istanbulMs);
  // Read UTC getters on the shifted timestamp so no additional (browser-local)
  // timezone conversion is layered on top of the Istanbul shift already applied.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// What staff type into a `datetime-local` input (a timezone-less wall-clock
// string) -> the ISO instant to send to the server, interpreting what they
// typed as Europe/Istanbul wall-clock time (not the browser's local
// timezone, which may differ from Istanbul).
export function conferenceLocalInputValueToIso(value: string): string {
  // `value` is `YYYY-MM-DDTHH:mm`, timezone-less. Parsing it with a trailing
  // `Z` makes Date.UTC-style parsing treat those digits as UTC wall-clock
  // fields; subtracting the Istanbul offset then yields the correct UTC
  // instant for "this wall-clock time, in Europe/Istanbul".
  const asIfUtcMs = new Date(`${value}:00Z`).getTime();
  const utcMs = asIfUtcMs - CONFERENCE_TIMEZONE_OFFSET_MS;
  return new Date(utcMs).toISOString();
}
