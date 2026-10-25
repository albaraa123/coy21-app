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
});
