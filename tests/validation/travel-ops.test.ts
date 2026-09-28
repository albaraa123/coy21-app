import { describe, it, expect } from 'vitest';
import { isTravelOpsStaffRole } from '@/lib/validation/travel-ops';

describe('isTravelOpsStaffRole', () => {
  it('accepts travel_operations_staff', () => {
    expect(isTravelOpsStaffRole('travel_operations_staff')).toBe(true);
  });
  it('accepts super_admin', () => {
    expect(isTravelOpsStaffRole('super_admin')).toBe(true);
  });
  it('rejects participant_care_staff (different sensitive-data area)', () => {
    expect(isTravelOpsStaffRole('participant_care_staff')).toBe(false);
  });
  it('rejects registration_admission_manager (staff, but not travel-ops staff)', () => {
    expect(isTravelOpsStaffRole('registration_admission_manager')).toBe(false);
  });
  it('rejects agenda_allocation_manager', () => {
    expect(isTravelOpsStaffRole('agenda_allocation_manager')).toBe(false);
  });
  it('rejects communications_attendance_manager', () => {
    expect(isTravelOpsStaffRole('communications_attendance_manager')).toBe(false);
  });
  it('rejects participant', () => {
    expect(isTravelOpsStaffRole('participant')).toBe(false);
  });
  it('rejects null/undefined', () => {
    expect(isTravelOpsStaffRole(null)).toBe(false);
    expect(isTravelOpsStaffRole(undefined)).toBe(false);
  });
});
