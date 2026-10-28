import { describe, it, expect } from 'vitest';
import { isLunchEligible, isCoffeeEligible } from './eligibility';
import type { Database } from '@/types/database';

describe('isLunchEligible', () => {
  const baseApp = {
    participant_type: null as Database['public']['Enums']['participant_type'] | null,
    status: 'accepted' as Database['public']['Enums']['application_status'],
    attendance_confirmation: 'confirmed' as Database['public']['Enums']['attendance_confirmation_status'],
  };

  it('delegate accepted+confirmed is eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'delegate' }, null)).toBe(true);
  });
  it('volunteer accepted+confirmed is eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'volunteer' }, null)).toBe(true);
  });
  it('delegate not confirmed is NOT eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'delegate', attendance_confirmation: 'not_confirmed' }, null)).toBe(false);
  });
  it('delegate not accepted is NOT eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'delegate', status: 'waitlisted' }, null)).toBe(false);
  });
  it('knowledge_partner is NOT eligible regardless of status', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'knowledge_partner' }, null)).toBe(false);
  });
  it('speaker is NOT eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'speaker' }, null)).toBe(false);
  });
  it('youngo is NOT eligible (not yet classified)', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'youngo' }, null)).toBe(false);
  });
  it('staff role is eligible regardless of application', () => {
    expect(isLunchEligible(null, { role: 'staff' })).toBe(true);
  });
  it('super_admin role is eligible', () => {
    expect(isLunchEligible(null, { role: 'super_admin' })).toBe(true);
  });
  it('scanner_device role is NOT eligible', () => {
    expect(isLunchEligible(null, { role: 'scanner_device' })).toBe(false);
  });
  it('participant role (no staff role) with no application is NOT eligible', () => {
    expect(isLunchEligible(null, { role: 'participant' })).toBe(false);
  });
  it('both null is NOT eligible', () => {
    expect(isLunchEligible(null, null)).toBe(false);
  });
  it('an unrecognized participant_type is NOT eligible (fails closed)', () => {
    // @ts-expect-error -- deliberately testing runtime behavior for a value outside the real enum, e.g. DB/generated-type drift
    expect(isLunchEligible({ ...baseApp, participant_type: 'some_future_type' }, null)).toBe(false);
  });
});

describe('isCoffeeEligible', () => {
  it('returns true for everyone isLunchEligible already covers (delegate/volunteer/staff)', () => {
    expect(isCoffeeEligible(
      { participant_type: 'delegate', status: 'accepted', attendance_confirmation: 'confirmed' },
      null
    )).toBe(true);
    expect(isCoffeeEligible(
      { participant_type: 'volunteer', status: 'accepted', attendance_confirmation: 'confirmed' },
      null
    )).toBe(true);
    expect(isCoffeeEligible(null, { role: 'staff' })).toBe(true);
    expect(isCoffeeEligible(null, { role: 'super_admin' })).toBe(true);
  });

  it('returns true for an accepted+confirmed speaker (the one case isLunchEligible excludes)', () => {
    expect(isCoffeeEligible(
      { participant_type: 'speaker', status: 'accepted', attendance_confirmation: 'confirmed' },
      null
    )).toBe(true);
  });

  it('returns false for a speaker not yet accepted+confirmed', () => {
    expect(isCoffeeEligible(
      { participant_type: 'speaker', status: 'accepted', attendance_confirmation: 'not_confirmed' },
      null
    )).toBe(false);
    expect(isCoffeeEligible(
      { participant_type: 'speaker', status: 'draft', attendance_confirmation: 'confirmed' },
      null
    )).toBe(false);
  });

  it('returns false for a knowledge_partner (ineligible for both lunch and coffee)', () => {
    expect(isCoffeeEligible(
      { participant_type: 'knowledge_partner', status: 'accepted', attendance_confirmation: 'confirmed' },
      null
    )).toBe(false);
  });

  it('returns false when both application and profile are null', () => {
    expect(isCoffeeEligible(null, null)).toBe(false);
  });
});
