import { describe, expect, it } from 'vitest';
import { decideAdminAccess } from '@/lib/shell/admin-access';

// Pure-logic unit coverage for (admin)/layout.tsx's authorization gate.
// decideAdminAccess has zero Next.js/Supabase imports, so this is a plain
// synchronous test — no live DB, no Server Component render needed. This
// mirrors Task 5's established "extract the decision, unit-test that"
// pattern (see tests/shell/logout-live.test.ts's doc comment for the
// sibling case of a DB-touching function that DOES need a live test
// instead). The actual data-fetching half (auth.getUser(), the
// profiles.role read) lives in (admin)/layout.tsx itself and is exercised
// indirectly by `npm run build` compiling it and by the existing
// page-level auth tests already covering the same createClient() +
// createServiceRoleClient() + isAgendaStaffRole pattern.
//
// Task 7 code-review fix: decideAdminAccess now uses isNonParticipantRole
// (all non-participant roles; renamed from isStaffRole as of the
// 2026-09-29 staff role consolidation — see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md)
// instead of isAgendaStaffRole (2 of 4) — see admin-access.ts's doc
// comment.
//
// 2026-09-29 staff role consolidation: isNonParticipantRole derives its
// role list from role-label.ts's ROLE_LABEL_KEYS, which now holds only
// the 4 consolidated roles (participant, super_admin, staff,
// scanner_device) — the 7 deprecated staff-subtype roles (e.g.
// registration_admission_manager) are no longer recognized as
// non-participant roles here, even though they remain physically present
// in the Postgres user_role enum (Postgres can't drop enum values in
// place). The per-deprecated-role cases below were replaced with a
// single case for the new 'staff' role, plus an explicit case proving a
// deprecated role string is now correctly treated as unauthorized (not
// silently still authorized), documenting this as an intentional
// consequence of the consolidation rather than a regression.
describe('decideAdminAccess', () => {
  it('redirects when there is no authenticated user', () => {
    expect(decideAdminAccess(null, null)).toEqual({ kind: 'redirect-unauthenticated' });
    expect(decideAdminAccess(undefined, 'super_admin')).toEqual({ kind: 'redirect-unauthenticated' });
  });

  it('is unauthorized (not authenticated-but-blocked) for a participant role, with the participant-dashboard destination', () => {
    expect(decideAdminAccess('user-1', 'participant')).toEqual({
      kind: 'unauthorized',
      destinationHref: '/my-dashboard',
    });
  });

  it('is unauthorized for a null/missing profile row (authenticated user, no profile)', () => {
    expect(decideAdminAccess('user-1', null)).toEqual({
      kind: 'unauthorized',
      destinationHref: '/my-dashboard',
    });
  });

  it('is authorized for staff', () => {
    expect(decideAdminAccess('user-1', 'staff')).toEqual({ kind: 'authorized' });
  });

  it('is authorized for super_admin', () => {
    expect(decideAdminAccess('user-1', 'super_admin')).toEqual({ kind: 'authorized' });
  });

  it('is unauthorized for a deprecated staff-subtype role, since it is no longer in ROLE_LABEL_KEYS', () => {
    expect(decideAdminAccess('user-1', 'registration_admission_manager')).toEqual({
      kind: 'unauthorized',
      destinationHref: '/my-dashboard',
    });
  });
});
