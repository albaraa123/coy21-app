import { describe, it, expect } from 'vitest';
import { isApplicationMinor, CONFERENCE_START_DATE } from './minor';

describe('isApplicationMinor', () => {
  it('returns true when age_group is under_18, regardless of birth_date', () => {
    expect(isApplicationMinor({ age_group: 'under_18', birth_date: null })).toBe(true);
    expect(isApplicationMinor({ age_group: 'under_18', birth_date: '1990-01-01' })).toBe(true);
  });

  it('returns false when age_group is any other bucket, regardless of birth_date', () => {
    expect(isApplicationMinor({ age_group: '18_24', birth_date: null })).toBe(false);
    expect(isApplicationMinor({ age_group: '45_plus', birth_date: '2015-01-01' })).toBe(false);
  });

  it('falls back to birth_date when age_group is null: under 18 as of conference start', () => {
    // CONFERENCE_START_DATE is 2026-11-05. Born 2009-01-01 -> 17 at conference start.
    expect(isApplicationMinor({ age_group: null, birth_date: '2009-01-01' })).toBe(true);
    // Born 2008-01-01 -> 18 at conference start (birthday already passed).
    expect(isApplicationMinor({ age_group: null, birth_date: '2008-01-01' })).toBe(false);
    // Exact edge: born 2008-11-05 -> turns 18 exactly on conference start date -> not a minor.
    expect(isApplicationMinor({ age_group: null, birth_date: '2008-11-05' })).toBe(false);
    // One day later than the edge: still 17 the day before their 18th birthday.
    expect(isApplicationMinor({ age_group: null, birth_date: '2008-11-06' })).toBe(true);
  });

  it('returns false (never throws) when both age_group and birth_date are null', () => {
    expect(isApplicationMinor({ age_group: null, birth_date: null })).toBe(false);
  });
});
