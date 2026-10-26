//
// Narrows WHERE a `staff` account can go, without touching isStaffRole
// (WHETHER someone is staff). Only `staff` is restricted by this check --
// super_admin and scanner_device pass through unconditionally, since
// this predicate's whole purpose is the staff-specific reversal of the
// 2026-09-29 consolidation (see
// docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-design.md).
//
// Bug found and fixed during Task 4 spec-compliance review: this app's
// i18n routing (src/i18n/routing.ts) has no localePrefix override, so
// next-intl defaults to 'always' -- every real runtime pathname carries
// a locale segment (e.g. "/en/attendance/walk-in"), never the bare
// "/attendance/walk-in" this predicate's STAFF_ALLOWED_HREFS are written
// against. Without stripping that prefix first, isRouteAllowedForStaff
// returned false for every real staff request -- including to the two
// routes staff are supposed to keep -- causing an infinite redirect loop
// at the (admin)/layout.tsx integration (redirect to /attendance/walk-in
// -> still "not allowed" once locale-prefixed -> redirect again).
// stripLocalePrefix is the same already-tested utility
// src/lib/nav/route-matching.ts uses for nav active-item highlighting,
// reused here rather than duplicated.
import { stripLocalePrefix } from '@/lib/nav/route-matching';

export const STAFF_ALLOWED_HREFS = ['/attendance/walk-in', '/attendance/admissions'] as const;

function matchesAllowedHref(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isRouteAllowedForStaff(role: string | null | undefined, pathname: string): boolean {
  if (role !== 'staff') {
    return true;
  }
  const normalized = stripLocalePrefix(pathname);
  return STAFF_ALLOWED_HREFS.some((href) => matchesAllowedHref(normalized, href));
}
