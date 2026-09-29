import { isStaffRole } from '@/lib/auth/is-staff-role';

export const FUNDING_TYPE_VALUES = ['self_funded', 'partially_funded', 'fully_funded'] as const;
export type FundingType = (typeof FUNDING_TYPE_VALUES)[number];

export const ATTENDANCE_CONFIRMATION_VALUES = ['confirmed', 'not_confirmed', 'declined'] as const;
export type AttendanceConfirmation = (typeof ATTENDANCE_CONFIRMATION_VALUES)[number];

// Editable: funding_type AND attendance_confirmation.
//
// PRE-2026-09-29 this was narrower (isProgramAttendanceStaffRole OR
// isTravelOpsStaffRole) and canReadAttendanceConfirmation additionally
// granted participant_care_staff READ-ONLY access to
// attendance_confirmation only. Both distinctions collapsed to a single
// isStaffRole check as part of the staff role consolidation (see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md)
// — every account that could reach any of those 3 domains before can
// now read AND write both fields, since all 7 old domain roles are the
// same 'staff' role today. Kept as two named functions (rather than
// deleting one) so call sites' intent stays self-documenting even
// though they're now equivalent.
export function isFundingTypeStaffRole(role: string | null | undefined): boolean {
  return isStaffRole(role);
}

export function canReadAttendanceConfirmation(role: string | null | undefined): boolean {
  return isStaffRole(role);
}
