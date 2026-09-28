import { createHash } from 'node:crypto';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  // A simple, permissive shape check (not the same regex as this codebase's
  // registration Zod schema, z.string().email(), which uses a longer,
  // RFC-leaning pattern — this one is deliberately simpler, reimplemented
  // as a plain regex since this module has no Zod dependency of its own),
  // roughly equivalent in what it accepts/rejects for realistic
  // conference-registration addresses.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizePhone(raw: string): string {
  // Preserve exactly as entered (leading zeros, plus signs, spacing) per
  // the design spec's "preserving the original phone value" requirement —
  // this function only trims surrounding whitespace, it does not reformat.
  return raw.trim();
}

const YES_VALUES = new Set(['yes', 'y', 'true', '1', 'نعم', 'أجل']);
const NO_VALUES = new Set(['no', 'n', 'false', '0', 'لا', 'كلا']);

export function normalizeYesNo(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (YES_VALUES.has(v)) return true;
  if (NO_VALUES.has(v)) return false;
  return null;
}

export function splitMultiSelect(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Canonical codes for the 4 official conference tracks (must match
// supabase/migrations/20260805100000_seed_official_tracks.sql). Track 4
// (cross_cutting_track) is a real agenda track but is deliberately excluded
// from TRACK_1_TO_3_CODES: the application form only ever asks for a
// primary/secondary track among Tracks 1-3 (requirement: "Primary and
// secondary participant preferences must remain limited to Tracks 1-3"),
// so a primary_track/secondary_track value resolving to Track 4 is invalid,
// not merely unrecognized.
export const TRACK_1_TO_3_CODES = [
  'adaptation_resilience_communities',
  'just_transition_green_economy_climate_innovation',
  'climate_finance_governance_international_cooperation',
] as const;
export type Track1To3Code = (typeof TRACK_1_TO_3_CODES)[number];

export const CROSS_CUTTING_TRACK_CODE = 'cross_cutting_track';

// Maps every known way a spreadsheet cell might spell out a track — the
// canonical code itself, the current official Arabic/English names, and the
// older form wording this codebase used before the official names above
// were finalized — to its canonical code. Keys are matched case-
// insensitively after trimming; add new rows here (not in field-dictionary,
// which maps column HEADERS, not cell values) if another legacy spelling
// surfaces in a real import file.
const TRACK_LABEL_ALIASES: Record<string, Track1To3Code | typeof CROSS_CUTTING_TRACK_CODE> = {
  // Canonical codes, so a re-export of already-normalized data round-trips.
  adaptation_resilience_communities: 'adaptation_resilience_communities',
  just_transition_green_economy_climate_innovation: 'just_transition_green_economy_climate_innovation',
  climate_finance_governance_international_cooperation: 'climate_finance_governance_international_cooperation',
  cross_cutting_track: CROSS_CUTTING_TRACK_CODE,

  // Official names (English + Arabic), as seeded.
  'track 1: adaptation, resilience, and resilient communities': 'adaptation_resilience_communities',
  'المحور الأول: التكيف والمرونة وصمود المجتمعات': 'adaptation_resilience_communities',
  'track 2: just transition, green economy, and climate innovation': 'just_transition_green_economy_climate_innovation',
  'المحور الثاني: التحول العادل والاقتصاد الأخضر والابتكار المناخي': 'just_transition_green_economy_climate_innovation',
  'track 3: climate finance, governance, and international cooperation': 'climate_finance_governance_international_cooperation',
  'المحور الثالث: تمويل المناخ والحوكمة والتعاون الدولي': 'climate_finance_governance_international_cooperation',
  'track 4: cross-cutting track': CROSS_CUTTING_TRACK_CODE,
  'المحور الرابع: المسار التقاطعي': CROSS_CUTTING_TRACK_CODE,

  // Historical aliases: earlier wording used by this codebase's
  // field-dictionary track_N_focus_areas labels and by real prior imports,
  // before the official names above were finalized. Kept indefinitely as
  // import aliases per the explicit requirement to keep accepting old
  // Track 1-3 labels — do not remove even after no live data uses them.
  'track 1: adaptation, resilience, and human well-being': 'adaptation_resilience_communities',
  'المحور الأول: التكيف والمرونة والرفاه الإنساني': 'adaptation_resilience_communities',
  'track 3: climate finance, governance, and inclusive leadership': 'climate_finance_governance_international_cooperation',
  'المحور الثالث: التمويل المناخي والحوكمة والقيادة الشاملة': 'climate_finance_governance_international_cooperation',

  // Short/plain forms seen in free-text answers (not a full official name).
  'track 1': 'adaptation_resilience_communities',
  'المحور الأول': 'adaptation_resilience_communities',
  'المحور 1': 'adaptation_resilience_communities',
  'track 2': 'just_transition_green_economy_climate_innovation',
  'المحور الثاني': 'just_transition_green_economy_climate_innovation',
  'المحور 2': 'just_transition_green_economy_climate_innovation',
  'track 3': 'climate_finance_governance_international_cooperation',
  'المحور الثالث': 'climate_finance_governance_international_cooperation',
  'المحور 3': 'climate_finance_governance_international_cooperation',
  'track 4': CROSS_CUTTING_TRACK_CODE,
  'المحور الرابع': CROSS_CUTTING_TRACK_CODE,
  'المحور 4': CROSS_CUTTING_TRACK_CODE,
};

// funding_type: matches canonical codes, plain English wording, and common
// real-world phrasing (e.g. "fully sponsored") to the 3-value enum
// (self_funded/partially_funded/fully_funded). Same case-insensitive,
// trimmed-key lookup pattern as TRACK_LABEL_ALIASES above — add new rows
// here (not in field-dictionary, which maps column HEADERS, not cell
// values) if another real spelling surfaces in an import file.
const FUNDING_TYPE_ALIASES: Record<string, 'self_funded' | 'partially_funded' | 'fully_funded'> = {
  // Canonical codes, so a re-export of already-normalized data round-trips.
  self_funded: 'self_funded',
  partially_funded: 'partially_funded',
  fully_funded: 'fully_funded',

  'self-funded': 'self_funded',
  'self funded': 'self_funded',
  self: 'self_funded',
  'تمويل ذاتي': 'self_funded',
  'ذاتي': 'self_funded',

  'partially funded': 'partially_funded',
  'partially-funded': 'partially_funded',
  partial: 'partially_funded',
  'تمويل جزئي': 'partially_funded',
  'جزئي': 'partially_funded',

  'fully funded': 'fully_funded',
  'fully-funded': 'fully_funded',
  'fully sponsored': 'fully_funded',
  full: 'fully_funded',
  sponsored: 'fully_funded',
  'تمويل كامل': 'fully_funded',
  'ممول بالكامل': 'fully_funded',
  'كامل': 'fully_funded',
};

export type FundingTypeNormalizationResult =
  | { status: 'recognized'; code: 'self_funded' | 'partially_funded' | 'fully_funded' }
  | { status: 'unrecognized' };

export function normalizeFundingType(raw: string): FundingTypeNormalizationResult {
  const key = raw.trim().toLowerCase();
  const resolved = FUNDING_TYPE_ALIASES[key];
  if (resolved === undefined) return { status: 'unrecognized' };
  return { status: 'recognized', code: resolved };
}

// attendance_confirmation: matches canonical codes, plain English/Arabic
// wording, and common real-world phrasing (Yes/No, Attending/Not
// Attending, Cancelled) to the 3-value enum (confirmed/not_confirmed/
// declined). Same case-insensitive, trimmed-key lookup pattern as
// FUNDING_TYPE_ALIASES above.
const ATTENDANCE_CONFIRMATION_ALIASES: Record<string, 'confirmed' | 'not_confirmed' | 'declined'> = {
  // Canonical codes, so a re-export of already-normalized data round-trips.
  confirmed: 'confirmed',
  not_confirmed: 'not_confirmed',
  declined: 'declined',

  'attending': 'confirmed',
  'will attend': 'confirmed',
  'yes': 'confirmed',
  'نعم': 'confirmed',
  'مؤكد': 'confirmed',
  'سيحضر': 'confirmed',

  'not attending': 'declined',
  'no': 'declined',
  'لا': 'declined',
  'اعتذر': 'declined',
  'معتذر': 'declined',
  'cancelled': 'declined',
  'canceled': 'declined',

  'not confirmed': 'not_confirmed',
  'pending': 'not_confirmed',
  'لم يؤكد': 'not_confirmed',
  'غير مؤكد': 'not_confirmed',
};

export type AttendanceConfirmationNormalizationResult =
  | { status: 'recognized'; code: 'confirmed' | 'not_confirmed' | 'declined' }
  | { status: 'unrecognized' };

export function normalizeAttendanceConfirmation(raw: string): AttendanceConfirmationNormalizationResult {
  const key = raw.trim().toLowerCase();
  const resolved = ATTENDANCE_CONFIRMATION_ALIASES[key];
  if (resolved === undefined) return { status: 'unrecognized' };
  return { status: 'recognized', code: resolved };
}

export type TrackNormalizationResult =
  | { status: 'recognized_1_to_3'; code: Track1To3Code }
  | { status: 'recognized_track_4' }
  | { status: 'unrecognized' };

// Normalizes a raw primary_track/secondary_track cell value against every
// known spelling (canonical code, official name, or historical alias).
// Deliberately does not touch track_1_focus_areas/track_2_focus_areas/
// track_3_focus_areas (those are per-track free-text multi-select answer
// lists, not a track selector, and are unaffected by this correction) or
// track_interests (a separate, unrelated free-text interests field).
export function normalizeTrackLabel(raw: string): TrackNormalizationResult {
  const key = raw.trim().toLowerCase();
  const resolved = TRACK_LABEL_ALIASES[key];
  if (resolved === undefined) return { status: 'unrecognized' };
  if (resolved === CROSS_CUTTING_TRACK_CODE) return { status: 'recognized_track_4' };
  return { status: 'recognized_1_to_3', code: resolved };
}

export function computeRowFingerprint(normalizedRow: Record<string, unknown>): string {
  const sortedKeys = Object.keys(normalizedRow).sort();
  const canonical = sortedKeys.map((k) => `${k}=${JSON.stringify(normalizedRow[k])}`).join('&');
  return createHash('sha256').update(canonical).digest('hex');
}

export function computeFileChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
