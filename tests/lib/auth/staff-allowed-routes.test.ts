import { describe, expect, it } from 'vitest';
import { isRouteAllowedForStaff } from '@/lib/auth/staff-allowed-routes';

describe('isRouteAllowedForStaff', () => {
  it('allows staff on /attendance/walk-in', () => {
    expect(isRouteAllowedForStaff('staff', '/attendance/walk-in')).toBe(true);
  });
  it('allows staff on a nested path under /attendance/admissions', () => {
    expect(isRouteAllowedForStaff('staff', '/attendance/admissions/123')).toBe(true);
  });
  it('rejects staff on /attendance/scanners', () => {
    expect(isRouteAllowedForStaff('staff', '/attendance/scanners')).toBe(false);
  });
  it('rejects staff on /dashboard', () => {
    expect(isRouteAllowedForStaff('staff', '/dashboard')).toBe(false);
  });
  it('always allows super_admin regardless of path', () => {
    expect(isRouteAllowedForStaff('super_admin', '/dashboard')).toBe(true);
  });
  it('always allows scanner_device regardless of path (not narrowed by this check)', () => {
    expect(isRouteAllowedForStaff('scanner_device', '/dashboard')).toBe(true);
  });

  // Regression coverage: this app's i18n routing has no localePrefix
  // override, so next-intl defaults to 'always' -- every real runtime
  // pathname carries a locale segment (e.g. "/en/attendance/walk-in"),
  // never the bare form. A prior version of this predicate didn't strip
  // it, so every real staff request was rejected regardless of the
  // actual route, causing an infinite redirect loop in (admin)/layout.tsx.
  it('allows staff on a locale-prefixed /en/attendance/walk-in', () => {
    expect(isRouteAllowedForStaff('staff', '/en/attendance/walk-in')).toBe(true);
  });
  it('allows staff on a locale-prefixed nested /ar/attendance/admissions/123', () => {
    expect(isRouteAllowedForStaff('staff', '/ar/attendance/admissions/123')).toBe(true);
  });
  it('rejects staff on a locale-prefixed /en/dashboard', () => {
    expect(isRouteAllowedForStaff('staff', '/en/dashboard')).toBe(false);
  });
});
