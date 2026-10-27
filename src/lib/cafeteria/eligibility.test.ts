import { describe, it, expect } from 'vitest';
import { isLunchEligible } from './eligibility';

describe('isLunchEligible', () => {
  const baseApp = { participant_type: null as string | null, status: 'accepted', attendance_confirmation: 'confirmed' };

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
});
