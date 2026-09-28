// Single source of truth for "is this profile.role allowed to view/edit
// funding_type and attendance_confirmation on applications" — both fields
// live on the same /participants/funding page ("Participant Status").
//
// funding_type: editable by isProgramAttendanceStaffRole OR
// isTravelOpsStaffRole (plus super_admin), per explicit user decision.
//
// attendance_confirmation: same edit role set as funding_type, PLUS
// participant_care_staff gets READ-ONLY access — that team needs to know
// who is attending to prepare reception/special-needs support, but does
// not own the attendance decision (explicit user decision). This is the
// first field in this codebase with a role set wider for read than for
// write, so the two checks are deliberately separate functions rather than
// a single isFundingTypeStaffRole-shaped boolean.
import { isProgramAttendanceStaffRole } from './program-attendance';
import { isTravelOpsStaffRole } from './travel-ops';
import { isParticipantCareStaffRole } from './participant-care';

export const FUNDING_TYPE_VALUES = ['self_funded', 'partially_funded', 'fully_funded'] as const;
export type FundingType = (typeof FUNDING_TYPE_VALUES)[number];

export const ATTENDANCE_CONFIRMATION_VALUES = ['confirmed', 'not_confirmed', 'declined'] as const;
export type AttendanceConfirmation = (typeof ATTENDANCE_CONFIRMATION_VALUES)[number];

// Editable: funding_type AND attendance_confirmation. Also the gate for
// "may open the Participant Status page at all" (participant_care_staff's
// read-only reach into attendance_confirmation is exposed as a narrower,
// separate check below, not by opening this whole page/console to them).
export function isFundingTypeStaffRole(role: string | null | undefined): boolean {
  return isProgramAttendanceStaffRole(role) || isTravelOpsStaffRole(role);
}

// Read-only reach into attendance_confirmation specifically. Deliberately
// NOT combined into isFundingTypeStaffRole — participant_care_staff must
// never gain funding_type visibility or any write access through this
// check.
export function canReadAttendanceConfirmation(role: string | null | undefined): boolean {
  return isFundingTypeStaffRole(role) || isParticipantCareStaffRole(role);
}
