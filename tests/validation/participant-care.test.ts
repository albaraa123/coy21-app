import { describe, it, expect } from 'vitest';
import { isParticipantCareStaffRole } from '@/lib/validation/participant-care';

describe('isParticipantCareStaffRole', () => {
  it('accepts participant_care_staff', () => {
    expect(isParticipantCareStaffRole('participant_care_staff')).toBe(true);
  });
  it('accepts super_admin', () => {
    expect(isParticipantCareStaffRole('super_admin')).toBe(true);
  });
  it('rejects travel_operations_staff (different sensitive-data area)', () => {
    expect(isParticipantCareStaffRole('travel_operations_staff')).toBe(false);
  });
  it('rejects registration_admission_manager (staff, but not participant-care staff)', () => {
    expect(isParticipantCareStaffRole('registration_admission_manager')).toBe(false);
  });
  it('rejects agenda_allocation_manager', () => {
    expect(isParticipantCareStaffRole('agenda_allocation_manager')).toBe(false);
  });
  it('rejects communications_attendance_manager', () => {
    expect(isParticipantCareStaffRole('communications_attendance_manager')).toBe(false);
  });
  it('rejects participant', () => {
    expect(isParticipantCareStaffRole('participant')).toBe(false);
  });
  it('rejects null/undefined', () => {
    expect(isParticipantCareStaffRole(null)).toBe(false);
    expect(isParticipantCareStaffRole(undefined)).toBe(false);
  });
});
