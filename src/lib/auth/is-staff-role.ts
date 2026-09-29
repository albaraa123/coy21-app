//
// Single source of truth for "is this profile.role allowed to act as
// staff" — replaces the 6 domain-specific is<X>StaffRole() functions
// this codebase used to have (isAdmissionStaffRole, isAgendaStaffRole,
// isTravelOpsStaffRole, isParticipantCareStaffRole,
// isParticipantsCommunicationsStaffRole, isProgramAttendanceStaffRole),
// now that all 7 staff-domain roles have been consolidated into a
// single 'staff' user_role enum value (see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md).
//
// NOT the same as isNonParticipantRole (src/lib/auth/post-login-destination.ts)
// — that check is deliberately wider and includes scanner_device, for
// post-login-redirect purposes. This check is narrower: "is this a
// general-purpose staff account", excluding the dedicated scanner_device
// role.
export const STAFF_ROLES = ['staff', 'super_admin'] as const;

export function isStaffRole(role: string | null | undefined): boolean {
  return role != null && (STAFF_ROLES as readonly string[]).includes(role);
}
