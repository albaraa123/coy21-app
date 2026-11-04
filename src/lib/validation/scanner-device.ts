// Single source of truth for "is this profile.role allowed to act as a
// scanner_device (QR & Attendance Operator)". Deliberately narrow — this
// role may only scan/confirm entry for its assigned scope; it has no
// access to allocation, schedule-publication, or participant-account
// management, and no access to application_travel_info/application_
// health_info.
//
// 'staff' included per explicit product decision (Nov 2026): a staff
// member who has been given a scanner_assignments row (same table/shape
// as a scanner_device's assignment) can open /scanner and scan for that
// assignment, in addition to their existing walk-in/admissions duties —
// not a replacement for those, an addition. loadScannerAssignmentContext
// still gates actual scanning on having a real assignment row, so a staff
// account with no assignment sees /scanner's existing "no_assignment"
// state, exactly like an unassigned scanner_device would.
export const SCANNER_DEVICE_ROLES = ['scanner_device', 'super_admin', 'staff'] as const;
export function isScannerDeviceRole(role: string | null | undefined): boolean {
  return role != null && (SCANNER_DEVICE_ROLES as readonly string[]).includes(role);
}
