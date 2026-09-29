// src/lib/auth/post-login-destination.ts
//
// Pure decision logic for "where should a user land right after a
// successful sign-in", extracted the same way Task 6's decideAdminAccess
// (src/lib/shell/admin-access.ts) and role-label.ts's roleLabelKey were:
// zero Next.js/Supabase imports, so it can be unit-tested with plain
// assertions and reused by both the real server action
// (src/app/[locale]/(auth)/actions.ts's resolvePostLoginRedirectAction)
// and tests/auth/post-login-redirect-live.test.ts without either pulling
// in next/headers or '@/i18n/routing' (see sign-out.ts's doc comment for
// why those two imports specifically break a plain vitest/Node run).
//
// STAFF DEFINITION: deliberately NOT isAgendaStaffRole (agenda.ts) or
// isAdmissionStaffRole (admission-review.ts) — those are each scoped to
// a specific feature area's authorization (2 of the 4 non-participant
// roles apiece) and are the wrong single source of truth for "is this
// user staff at all" in a login-redirect context, which needs to cover
// every non-participant role. Built instead from role-label.ts's
// ROLE_LABEL_KEYS (the canonical list of every known user_role value),
// minus 'participant' — reusing that list rather than hand-maintaining a
// third role enumeration.
//
// 404-AVOIDANCE (Task 7 plan, "CRITICAL: real current state" section) —
// HISTORICAL, RESOLVED BY TASK 11: as of Task 7, neither /dashboard nor
// /my-dashboard had a real page yet (/dashboard had only (admin)/layout.tsx
// with no page.tsx under it; /my-dashboard had no layout or page at all).
// Redirecting to either would have 404'd for every user, so Task 7
// temporarily targeted /participants (staff) and /my-application
// (participant) instead. Task 11 built real pages at both
// (admin)/dashboard/page.tsx and (participant)/(shell)/my-dashboard/
// page.tsx, so this function now targets the real dashboards directly —
// the temporary detour is no longer needed. This mirrors the equivalent
// update to claim/page.tsx's post-claim redirect (see that file) — same
// resolution, same forward pointer now fulfilled.
// isNonParticipantRole / NON_PARTICIPANT_ROLES are also now the authoritative
// "is this user staff at all" check for src/lib/shell/admin-access.ts's decideAdminAccess
// (the (admin)/layout.tsx chrome gate) — added there as a code-review
// follow-up after isAgendaStaffRole (2 of 4 roles) let 2 genuinely-staff
// roles get redirected here by resolvePostLoginDestination straight into
// an UnauthorizedState dead end at /participants. See admin-access.ts's
// doc comment for the full before/after reasoning. Despite living in
// src/lib/auth/, this pair is intentionally the general-purpose
// "participant vs. any staff role" primitive for the whole app, not
// login-redirect-specific — kept here (rather than moved into
// src/lib/shell/) only because it was built for this file first and
// role-label.ts (which it derives from) already lives in lib/shell,
// avoiding a shell -> auth -> shell import cycle.
import { ROLE_LABEL_KEYS } from '@/lib/shell/role-label';

export const NON_PARTICIPANT_ROLES = (Object.keys(ROLE_LABEL_KEYS) as (keyof typeof ROLE_LABEL_KEYS)[]).filter(
  (role) => role !== 'participant'
);

export function isNonParticipantRole(role: string | null | undefined): boolean {
  return role != null && (NON_PARTICIPANT_ROLES as readonly string[]).includes(role);
}

export type PostLoginDestination = { href: string };

/**
 * @param role the profiles.role value for the just-signed-in user, or
 *   null/undefined if no profile row was found (should not normally
 *   happen — handle_new_user() always creates one — but a missing row is
 *   treated the same as 'participant', never as staff, matching the
 *   fail-closed posture of decideAdminAccess/isAgendaStaffRole/
 *   isAdmissionStaffRole elsewhere in this codebase).
 */
export function resolvePostLoginDestination(role: string | null | undefined): PostLoginDestination {
  // Checked BEFORE the general staff branch below: scanner_device is
  // also in NON_PARTICIPANT_ROLES (it's a real non-participant role), but a
  // scanner terminal has no use for the full admin dashboard shell — its
  // only job is /scanner. super_admin is deliberately NOT special-cased
  // here even though it's also in SCANNER_DEVICE_ROLES
  // (src/lib/validation/scanner-device.ts) elsewhere in this codebase:
  // a super_admin signing in is acting as a staff member first, not a
  // dedicated scanner terminal, so they still land on the full
  // dashboard, exactly as before this change.
  if (role === 'scanner_device') {
    return { href: '/scanner' };
  }
  if (isNonParticipantRole(role)) {
    return { href: '/dashboard' };
  }
  return { href: '/my-dashboard' };
}
