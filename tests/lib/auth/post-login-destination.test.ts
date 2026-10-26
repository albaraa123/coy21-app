import { describe, expect, it } from 'vitest';
import { isNonParticipantRole, resolvePostLoginDestination, NON_PARTICIPANT_ROLES } from '@/lib/auth/post-login-destination';

// Pure-logic unit coverage for the post-login redirect decision (Task 7's
// fix for the "log-in always redirects to /my-application regardless of
// role" bug). resolvePostLoginDestination has zero Next.js/Supabase
// imports, so this is a plain synchronous test — mirrors
// tests/lib/shell/admin-access.test.ts's established pattern for
// decideAdminAccess. The live-DB half (the real profiles.role lookup via
// the server action) is covered separately by
// tests/auth/post-login-redirect-live.test.ts.
describe('isNonParticipantRole / NON_PARTICIPANT_ROLES', () => {
  it('includes every non-participant role from role-label.ts', () => {
    expect(NON_PARTICIPANT_ROLES.sort()).toEqual(['super_admin', 'staff', 'scanner_device'].sort());
  });

  it('is false for participant, null, and undefined', () => {
    expect(isNonParticipantRole('participant')).toBe(false);
    expect(isNonParticipantRole(null)).toBe(false);
    expect(isNonParticipantRole(undefined)).toBe(false);
  });

  it('is true for every staff role', () => {
    for (const role of NON_PARTICIPANT_ROLES) {
      expect(isNonParticipantRole(role)).toBe(true);
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

  it('sends every staff role EXCEPT scanner_device and staff to /dashboard (Task 11: the real admin dashboard)', () => {
    for (const role of NON_PARTICIPANT_ROLES) {
      if (role === 'scanner_device' || role === 'staff') continue; // covered separately below
      expect(resolvePostLoginDestination(role)).toEqual({ href: '/dashboard' });
    }
  });

  it('sends scanner_device to /scanner, not the full admin dashboard (Phase 7 fix: a scanner terminal has no use for dashboard chrome, and previously required a second manual navigation after every login)', () => {
    expect(resolvePostLoginDestination('scanner_device')).toEqual({ href: '/scanner' });
  });

  it('sends staff to /attendance/walk-in, not the full admin dashboard (2026-10-25 narrowing: staff is kept to walk-in admission and the attendance-correction console only)', () => {
    expect(resolvePostLoginDestination('staff')).toEqual({ href: '/attendance/walk-in' });
  });

  it('still sends super_admin to /dashboard (unaffected by the staff narrowing)', () => {
    expect(resolvePostLoginDestination('super_admin')).toEqual({ href: '/dashboard' });
  });
});
