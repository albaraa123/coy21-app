// Single source of truth for "is this profile.role allowed to act as
// travel-operations staff" (application_travel_info: departure airport, visa,
// passport, funding/support level, accommodation operations). Separate from
// isAgendaStaffRole/isAdmissionStaffRole/isParticipantCareStaffRole —
// different sensitive-data area, deliberately not shared. See
// docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md
// section 3.3a for the role-access matrix this mirrors.
export const TRAVEL_OPS_STAFF_ROLES = ['travel_operations_staff', 'super_admin'] as const;
export function isTravelOpsStaffRole(role: string | null | undefined): boolean {
  return role != null && (TRAVEL_OPS_STAFF_ROLES as readonly string[]).includes(role);
}
