// Single source of truth for "is this profile.role allowed to act as a
// scanner_device (QR & Attendance Operator)". Deliberately narrow — this
// role may only scan/confirm entry for its assigned scope; it has no
// access to allocation, schedule-publication, or participant-account
// management, and no access to application_travel_info/application_
// health_info.
export const SCANNER_DEVICE_ROLES = ['scanner_device', 'super_admin'] as const;
export function isScannerDeviceRole(role: string | null | undefined): boolean {
  return role != null && (SCANNER_DEVICE_ROLES as readonly string[]).includes(role);
}
