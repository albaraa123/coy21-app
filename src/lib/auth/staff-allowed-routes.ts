//
// Narrows WHERE a `staff` account can go, without touching isStaffRole
// (WHETHER someone is staff). Only `staff` is restricted by this check --
// super_admin and scanner_device pass through unconditionally, since
// this predicate's whole purpose is the staff-specific reversal of the
// 2026-09-29 consolidation (see
// docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-design.md).
export const STAFF_ALLOWED_HREFS = ['/attendance/walk-in', '/attendance/admissions'] as const;

function matchesAllowedHref(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isRouteAllowedForStaff(role: string | null | undefined, pathname: string): boolean {
  if (role !== 'staff') {
    return true;
  }
  return STAFF_ALLOWED_HREFS.some((href) => matchesAllowedHref(pathname, href));
}
