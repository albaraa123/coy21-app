// src/lib/shell/admin-access.ts
//
// Pure decision logic for (admin)/layout.tsx's authorization gate,
// extracted so it can be unit-tested without a real Server Component
// render / real Supabase call (matching Task 5's established
// extract-and-unit-test pattern — see role-label.ts's doc comment for
// the same rationale applied to the role-label mapping).
//
// (admin)/layout.tsx itself remains responsible for the actual
// data-fetching (auth.getUser(), the profiles.role read) and for calling
// redirect()/rendering UnauthorizedState based on what this function
// returns — this module has zero Next.js/Supabase imports.
//
// STAFF CHECK (Task 7 code-review fix): this gate now uses isStaffRole
// (src/lib/auth/post-login-destination.ts) instead of the narrower
// isAgendaStaffRole (src/lib/validation/agenda.ts). isAgendaStaffRole only
// covers 2 of the 4 non-participant roles (agenda_allocation_manager,
// super_admin) — it is deliberately scoped to agenda-specific
// authorization and is still the correct check at every individual admin
// PAGE's own re-check (participants/page.tsx, agenda/page.tsx, etc. — see
// those files, all still call isAgendaStaffRole directly and are
// UNCHANGED by this fix). But this layout's job is different: it decides
// whether a signed-in user gets into the (admin) URL space AT ALL, before
// any specific page's own narrower check runs. Using isAgendaStaffRole
// here meant a registration_admission_manager or
// communications_attendance_manager — genuine staff, per role-label.ts's
// canonical enumeration — got redirected here to 'unauthorized' the
// moment they reached ANY /participants-style URL, including the one
// Task 7's post-login redirect (resolvePostLoginDestination) now sends
// them to right after signing in, which was a dead end for exactly those
// 2 roles. isStaffRole is the "is this any kind of staff" check (all 4
// non-participant roles, derived from role-label.ts's ROLE_LABEL_KEYS) —
// the correct scope for this layout-level, not-page-specific gate.
import { isStaffRole } from '@/lib/auth/post-login-destination';

export type AdminAccessDecision =
  | { kind: 'redirect-unauthenticated' }
  | { kind: 'unauthorized'; destinationHref: string }
  | { kind: 'authorized' };

/**
 * @param userId the authenticated user's id, or null/undefined if there is
 *   no session (mirrors `data.user?.id` from supabase.auth.getUser()).
 * @param role the profiles.role value for that user, or null/undefined if
 *   no profile row was found.
 */
export function decideAdminAccess(
  userId: string | null | undefined,
  role: string | null | undefined
): AdminAccessDecision {
  if (!userId) {
    return { kind: 'redirect-unauthenticated' };
  }
  if (!isStaffRole(role)) {
    // A participant (or any non-staff role) landed on an admin URL — send
    // them to the participant landing page, per the approved plan.
    return { kind: 'unauthorized', destinationHref: '/my-dashboard' };
  }
  return { kind: 'authorized' };
}
