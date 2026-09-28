// Single source of truth for "is this profile.role allowed to act as
// participant-care staff" (application_health_info: allergies, medical
// conditions, accessibility requirements, dietary requirements, emergency
// contact). Separate from isAgendaStaffRole/isAdmissionStaffRole/
// isTravelOpsStaffRole — different sensitive-data area, deliberately not
// shared. See
// docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md
// section 3.3a for the role-access matrix this mirrors.
export const PARTICIPANT_CARE_STAFF_ROLES = ['participant_care_staff', 'super_admin'] as const;
export function isParticipantCareStaffRole(role: string | null | undefined): boolean {
  return role != null && (PARTICIPANT_CARE_STAFF_ROLES as readonly string[]).includes(role);
}
