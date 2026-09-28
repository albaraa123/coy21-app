import { describe, expect, it } from 'vitest';
import { isStaffRole, resolvePostLoginDestination, STAFF_ROLES } from '@/lib/auth/post-login-destination';

// Pure-logic unit coverage for the post-login redirect decision (Task 7's
// fix for the "log-in always redirects to /my-application regardless of
// role" bug). resolvePostLoginDestination has zero Next.js/Supabase
// imports, so this is a plain synchronous test — mirrors
// tests/lib/shell/admin-access.test.ts's established pattern for
// decideAdminAccess. The live-DB half (the real profiles.role lookup via
// the server action) is covered separately by
// tests/auth/post-login-redirect-live.test.ts.
describe('isStaffRole / STAFF_ROLES', () => {
  it('includes every non-participant role from role-label.ts', () => {
    expect(STAFF_ROLES.sort()).toEqual(
      [
        'super_admin',
        'registration_admission_manager',
        'agenda_allocation_manager',
        'communications_attendance_manager',
        'travel_operations_staff',
        'participant_care_staff',
        'participants_communications_manager',
        'program_attendance_manager',
        'scanner_device',
      ].sort()
    );
  });

  it('is false for participant, null, and undefined', () => {
    expect(isStaffRole('participant')).toBe(false);
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });

  it('is true for every staff role', () => {
    for (const role of STAFF_ROLES) {
      expect(isStaffRole(role)).toBe(true);
    }
  });
});

describe('resolvePostLoginDestination', () => {
  it('sends a participant to /my-dashboard (Task 11: the real participant dashboard)', () => {
    expect(resolvePostLoginDestination('participant')).toEqual({ href: '/my-dashboard' });
  });

  it('sends a missing/null profile row (fail-closed, treated as non-staff) to /my-dashboard', () => {
    expect(resolvePostLoginDestination(null)).toEqual({ href: '/my-dashboard' });
    expect(resolvePostLoginDestination(undefined)).toEqual({ href: '/my-dashboard' });
  });

  it('sends every staff role EXCEPT scanner_device to /dashboard (Task 11: the real admin dashboard)', () => {
    for (const role of STAFF_ROLES) {
      if (role === 'scanner_device') continue; // covered separately below
      expect(resolvePostLoginDestination(role)).toEqual({ href: '/dashboard' });
    }
  });

  it('sends scanner_device to /scanner, not the full admin dashboard (Phase 7 fix: a scanner terminal has no use for dashboard chrome, and previously required a second manual navigation after every login)', () => {
    expect(resolvePostLoginDestination('scanner_device')).toEqual({ href: '/scanner' });
  });
});
