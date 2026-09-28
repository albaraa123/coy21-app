// Single source of truth for "is this profile.role allowed to act as
// program & attendance staff" (conference days, tracks, session types,
// sessions, rooms/capacities, speakers/moderators/facilitators/trainers,
// feature extraction, clustering, automatic/manual allocation, schedule
// confirmation and publication, and future QR/scanner/attendance
// management). Deliberately excludes participant account creation,
// password resets, and login-details email sending, and has no access to
// application_travel_info/application_health_info — those remain
// super_admin-only (plus the two dedicated care-staff roles).
export const PROGRAM_ATTENDANCE_STAFF_ROLES = ['program_attendance_manager', 'super_admin'] as const;
export function isProgramAttendanceStaffRole(role: string | null | undefined): boolean {
  return role != null && (PROGRAM_ATTENDANCE_STAFF_ROLES as readonly string[]).includes(role);
}
