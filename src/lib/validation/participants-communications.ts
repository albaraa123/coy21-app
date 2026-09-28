// Single source of truth for "is this profile.role allowed to act as
// participants & communications staff" (accepted-participant Excel import,
// participant profile management, account creation/linking, login-detail
// delivery, participant communications/reminders, viewing published
// schedules for communications purposes). Deliberately excludes agenda,
// allocation, clustering, and schedule-publication-approval access, and has
// no access to application_travel_info/application_health_info — those
// remain super_admin-only (plus the two dedicated care-staff roles).
export const PARTICIPANTS_COMMUNICATIONS_STAFF_ROLES = ['participants_communications_manager', 'super_admin'] as const;
export function isParticipantsCommunicationsStaffRole(role: string | null | undefined): boolean {
  return role != null && (PARTICIPANTS_COMMUNICATIONS_STAFF_ROLES as readonly string[]).includes(role);
}
