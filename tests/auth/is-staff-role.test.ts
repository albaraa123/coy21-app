import { describe, it, expect } from 'vitest';
import { isStaffRole, STAFF_ROLES } from '@/lib/auth/is-staff-role';

describe('isStaffRole', () => {
  it('returns true for staff', () => {
    expect(isStaffRole('staff')).toBe(true);
  });

  it('returns true for super_admin', () => {
    expect(isStaffRole('super_admin')).toBe(true);
  });

  it('returns false for participant', () => {
    expect(isStaffRole('participant')).toBe(false);
  });

  it('returns false for scanner_device', () => {
    expect(isStaffRole('scanner_device')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });

  it('returns false for a deprecated domain role', () => {
    expect(isStaffRole('registration_admission_manager')).toBe(false);
    expect(isStaffRole('travel_operations_staff')).toBe(false);
  });

  it('STAFF_ROLES contains exactly staff and super_admin', () => {
    expect(STAFF_ROLES).toEqual(['staff', 'super_admin']);
  });
});
