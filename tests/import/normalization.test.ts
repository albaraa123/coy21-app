import { describe, expect, it } from 'vitest';
import {
  normalizeEmail, isValidEmail, normalizePhone, normalizeYesNo,
  splitMultiSelect, computeRowFingerprint, computeFileChecksum,
  normalizeTrackLabel, normalizeFundingType, normalizeAttendanceConfirmation,
} from '@/lib/import/normalization';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => expect(normalizeEmail('  Foo.Bar@EXAMPLE.com  ')).toBe('foo.bar@example.com'));
});

describe('isValidEmail', () => {
  it('accepts a well-formed address', () => expect(isValidEmail('a@b.com')).toBe(true));
  it('rejects a malformed address', () => expect(isValidEmail('not-an-email')).toBe(false));
  it('accepts a plus-tag alias', () => expect(isValidEmail('foo+tag@example.com')).toBe(true));
  it('accepts a subdomain address', () => expect(isValidEmail('foo.bar@sub.example.com')).toBe(true));
  it('rejects a double-@ address', () => expect(isValidEmail('foo@@example.com')).toBe(false));
  it('rejects an address with no local part', () => expect(isValidEmail('@example.com')).toBe(false));
  it('rejects an address with a space in the local part', () => expect(isValidEmail('foo bar@example.com')).toBe(false));
  it('rejects an address with no TLD', () => expect(isValidEmail('foo@localhost')).toBe(false));
});

describe('normalizePhone', () => {
  it('preserves leading zeros and plus signs', () => {
    expect(normalizePhone('+968 9123 4567')).toBe('+968 9123 4567');
    expect(normalizePhone('0091234567')).toBe('0091234567');
  });
});

describe('normalizeYesNo', () => {
  it.each([
    ['yes', true], ['Yes', true], ['Y', true], ['نعم', true], ['true', true], ['1', true],
    ['no', false], ['N', false], ['لا', false], ['false', false], ['0', false],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeYesNo(input)).toBe(expected);
  });
  it('returns null for an unrecognized value rather than guessing', () => {
    expect(normalizeYesNo('maybe')).toBeNull();
  });
});

describe('splitMultiSelect', () => {
  it('splits on commas', () => expect(splitMultiSelect('Climate, Energy, Water')).toEqual(['Climate', 'Energy', 'Water']));
  it('splits on semicolons', () => expect(splitMultiSelect('Climate; Energy; Water')).toEqual(['Climate', 'Energy', 'Water']));
  it('splits on line breaks', () => expect(splitMultiSelect('Climate\nEnergy\nWater')).toEqual(['Climate', 'Energy', 'Water']));
  it('trims each resulting item and drops empty entries', () => expect(splitMultiSelect('Climate,  , Energy,')).toEqual(['Climate', 'Energy']));
});

describe('computeRowFingerprint', () => {
  it('produces the same fingerprint for the same normalized content', () => {
    const a = computeRowFingerprint({ email: 'a@b.com', full_name: 'A B' });
    const b = computeRowFingerprint({ email: 'a@b.com', full_name: 'A B' });
    expect(a).toBe(b);
  });
  it('produces a different fingerprint when content differs', () => {
    const a = computeRowFingerprint({ email: 'a@b.com', full_name: 'A B' });
    const b = computeRowFingerprint({ email: 'a@b.com', full_name: 'A C' });
    expect(a).not.toBe(b);
  });
  it('is insensitive to key insertion order', () => {
    const a = computeRowFingerprint({ email: 'a@b.com', full_name: 'A B' });
    const b = computeRowFingerprint({ full_name: 'A B', email: 'a@b.com' });
    expect(a).toBe(b);
  });
});

describe('computeFileChecksum', () => {
  it('produces a stable SHA-256 hex digest for the same bytes', () => {
    const buf = Buffer.from('hello world');
    expect(computeFileChecksum(buf)).toBe(computeFileChecksum(Buffer.from('hello world')));
  });
});

describe('normalizeFundingType', () => {
  it('recognizes the canonical codes', () => {
    expect(normalizeFundingType('self_funded')).toEqual({ status: 'recognized', code: 'self_funded' });
    expect(normalizeFundingType('partially_funded')).toEqual({ status: 'recognized', code: 'partially_funded' });
    expect(normalizeFundingType('fully_funded')).toEqual({ status: 'recognized', code: 'fully_funded' });
  });

  it('recognizes common English wording, case-insensitively', () => {
    expect(normalizeFundingType('Self-Funded')).toEqual({ status: 'recognized', code: 'self_funded' });
    expect(normalizeFundingType('Partially Funded')).toEqual({ status: 'recognized', code: 'partially_funded' });
    expect(normalizeFundingType('Fully Sponsored')).toEqual({ status: 'recognized', code: 'fully_funded' });
    expect(normalizeFundingType('fully funded')).toEqual({ status: 'recognized', code: 'fully_funded' });
  });

  it('recognizes Arabic wording', () => {
    expect(normalizeFundingType('تمويل ذاتي')).toEqual({ status: 'recognized', code: 'self_funded' });
    expect(normalizeFundingType('تمويل جزئي')).toEqual({ status: 'recognized', code: 'partially_funded' });
    expect(normalizeFundingType('تمويل كامل')).toEqual({ status: 'recognized', code: 'fully_funded' });
  });

  it('returns unrecognized for an unknown value rather than guessing', () => {
    expect(normalizeFundingType('maybe some support')).toEqual({ status: 'unrecognized' });
  });
});

describe('normalizeAttendanceConfirmation', () => {
  it('recognizes the canonical codes', () => {
    expect(normalizeAttendanceConfirmation('confirmed')).toEqual({ status: 'recognized', code: 'confirmed' });
    expect(normalizeAttendanceConfirmation('not_confirmed')).toEqual({ status: 'recognized', code: 'not_confirmed' });
    expect(normalizeAttendanceConfirmation('declined')).toEqual({ status: 'recognized', code: 'declined' });
  });

  it('recognizes Yes/No and Attending/Not Attending wording, case-insensitively', () => {
    expect(normalizeAttendanceConfirmation('Yes')).toEqual({ status: 'recognized', code: 'confirmed' });
    expect(normalizeAttendanceConfirmation('Attending')).toEqual({ status: 'recognized', code: 'confirmed' });
    expect(normalizeAttendanceConfirmation('No')).toEqual({ status: 'recognized', code: 'declined' });
    expect(normalizeAttendanceConfirmation('Not Attending')).toEqual({ status: 'recognized', code: 'declined' });
    expect(normalizeAttendanceConfirmation('Cancelled')).toEqual({ status: 'recognized', code: 'declined' });
  });

  it('recognizes Arabic wording', () => {
    expect(normalizeAttendanceConfirmation('نعم')).toEqual({ status: 'recognized', code: 'confirmed' });
    expect(normalizeAttendanceConfirmation('لا')).toEqual({ status: 'recognized', code: 'declined' });
    expect(normalizeAttendanceConfirmation('لم يؤكد')).toEqual({ status: 'recognized', code: 'not_confirmed' });
  });

  it('returns unrecognized for an unknown value rather than guessing', () => {
    expect(normalizeAttendanceConfirmation('maybe later')).toEqual({ status: 'unrecognized' });
  });
});

describe('normalizeTrackLabel', () => {
  it('recognizes the canonical codes for Tracks 1-3', () => {
    expect(normalizeTrackLabel('adaptation_resilience_communities')).toEqual({ status: 'recognized_1_to_3', code: 'adaptation_resilience_communities' });
    expect(normalizeTrackLabel('just_transition_green_economy_climate_innovation')).toEqual({ status: 'recognized_1_to_3', code: 'just_transition_green_economy_climate_innovation' });
    expect(normalizeTrackLabel('climate_finance_governance_international_cooperation')).toEqual({ status: 'recognized_1_to_3', code: 'climate_finance_governance_international_cooperation' });
  });

  it('recognizes the official English and Arabic names for Tracks 1-3', () => {
    expect(normalizeTrackLabel('Track 1: Adaptation, Resilience, and Resilient Communities')).toEqual({ status: 'recognized_1_to_3', code: 'adaptation_resilience_communities' });
    expect(normalizeTrackLabel('المحور الأول: التكيف والمرونة وصمود المجتمعات')).toEqual({ status: 'recognized_1_to_3', code: 'adaptation_resilience_communities' });
    expect(normalizeTrackLabel('Track 2: Just Transition, Green Economy, and Climate Innovation')).toEqual({ status: 'recognized_1_to_3', code: 'just_transition_green_economy_climate_innovation' });
    expect(normalizeTrackLabel('Track 3: Climate Finance, Governance, and International Cooperation')).toEqual({ status: 'recognized_1_to_3', code: 'climate_finance_governance_international_cooperation' });
  });

  it('normalizes old (pre-correction) Track 1/3 wording as historical aliases', () => {
    expect(normalizeTrackLabel('Track 1: Adaptation, Resilience, and Human Well-Being')).toEqual({ status: 'recognized_1_to_3', code: 'adaptation_resilience_communities' });
    expect(normalizeTrackLabel('المحور الأول: التكيف والمرونة والرفاه الإنساني')).toEqual({ status: 'recognized_1_to_3', code: 'adaptation_resilience_communities' });
    expect(normalizeTrackLabel('Track 3: Climate Finance, Governance, and Inclusive Leadership')).toEqual({ status: 'recognized_1_to_3', code: 'climate_finance_governance_international_cooperation' });
    expect(normalizeTrackLabel('المحور الثالث: التمويل المناخي والحوكمة والقيادة الشاملة')).toEqual({ status: 'recognized_1_to_3', code: 'climate_finance_governance_international_cooperation' });
  });

  it('normalizes short/plain forms ("Track 1", "المحور الأول")', () => {
    expect(normalizeTrackLabel('Track 1')).toEqual({ status: 'recognized_1_to_3', code: 'adaptation_resilience_communities' });
    expect(normalizeTrackLabel('  track 2  ')).toEqual({ status: 'recognized_1_to_3', code: 'just_transition_green_economy_climate_innovation' });
    expect(normalizeTrackLabel('المحور 3')).toEqual({ status: 'recognized_1_to_3', code: 'climate_finance_governance_international_cooperation' });
  });

  it('is case-insensitive', () => {
    expect(normalizeTrackLabel('TRACK 1')).toEqual({ status: 'recognized_1_to_3', code: 'adaptation_resilience_communities' });
  });

  it('recognizes Track 4 distinctly, never as a Track 1-3 result', () => {
    expect(normalizeTrackLabel('cross_cutting_track')).toEqual({ status: 'recognized_track_4' });
    expect(normalizeTrackLabel('Track 4: Cross-Cutting Track')).toEqual({ status: 'recognized_track_4' });
    expect(normalizeTrackLabel('المحور الرابع: المسار التقاطعي')).toEqual({ status: 'recognized_track_4' });
    expect(normalizeTrackLabel('Track 4')).toEqual({ status: 'recognized_track_4' });
  });

  it('never confuses Track 4 (cross_cutting_track) with the unrelated admission_policy value "cross_cutting"', () => {
    // 'cross_cutting' alone (the admission_policy value) is not a track
    // label at all and must not resolve to Track 4 or any track.
    expect(normalizeTrackLabel('cross_cutting')).toEqual({ status: 'unrecognized' });
  });

  it('returns unrecognized for free text that does not match any known track', () => {
    expect(normalizeTrackLabel('Something else entirely')).toEqual({ status: 'unrecognized' });
    expect(normalizeTrackLabel('')).toEqual({ status: 'unrecognized' });
  });
});
