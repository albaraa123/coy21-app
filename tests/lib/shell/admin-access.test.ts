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
// Task 7 code-review fix: decideAdminAccess now uses isStaffRole (all 4
// non-participant roles) instead of isAgendaStaffRole (2 of 4) — see
// admin-access.ts's doc comment. The 'is unauthorized for a non-agenda
// staff role' case below was flipped from unauthorized to authorized
// accordingly, and a case for the 4th role
// (communications_attendance_manager) was added alongside it so all 4
// staff roles have explicit coverage here, not just 3.
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

  it('is authorized for registration_admission_manager (not agenda-scoped, but still staff)', () => {
    expect(decideAdminAccess('user-1', 'registration_admission_manager')).toEqual({ kind: 'authorized' });
  });

  it('is authorized for communications_attendance_manager (not agenda-scoped, but still staff)', () => {
    expect(decideAdminAccess('user-1', 'communications_attendance_manager')).toEqual({ kind: 'authorized' });
  });

  it('is authorized for agenda_allocation_manager', () => {
    expect(decideAdminAccess('user-1', 'agenda_allocation_manager')).toEqual({ kind: 'authorized' });
  });

  it('is authorized for super_admin', () => {
    expect(decideAdminAccess('user-1', 'super_admin')).toEqual({ kind: 'authorized' });
  });
});
