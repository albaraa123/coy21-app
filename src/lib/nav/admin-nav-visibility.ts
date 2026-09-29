/**
 * Filters adminNavGroups down to the items visible to a given profile role,
 * so the sidebar never shows a link that leads to a page-level notFound()
 * for that role.
 *
 * This is a UX/display concern only — see admin-nav-config.ts's "NOT an
 * authorization mechanism" caveat. The real gate is still, and must remain,
 * each page's own role check (src/lib/validation/*.ts, or, after the
 * 2026-09-29 staff role consolidation, isStaffRole from
 * src/lib/auth/is-staff-role.ts).
 *
 * HISTORY: before the 2026-09-29 staff role consolidation (see
 * docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md),
 * this file branched per-href across 6 domain-specific role checks
 * (isAdmissionStaffRole, isAgendaStaffRole, isProgramAttendanceStaffRole,
 * isParticipantCareStaffRole, isTravelOpsStaffRole,
 * isParticipantsCommunicationsStaffRole), matching each admin page's own
 * (then-domain-specific) authorization check href-for-href. That
 * consolidation merged all 7 staff-domain roles into a single 'staff'
 * user_role enum value, so every one of those per-href branches now
 * evaluates to the exact same predicate. There is no longer any
 * href-specific visibility difference between staff accounts: every admin
 * nav item is visible to any `staff`/`super_admin` account, or to none, and
 * this module has been simplified accordingly. See the design spec linked
 * above for the historical per-role -> href mapping this replaces.
 *
 * NOTE on tightening: the old ANY_STAFF_HREFS set (/reports, /communications,
 * /reports/local-info, /staff, /staff/assignments, /participants/arrivals)
 * previously returned visible unconditionally, with NO role check at all —
 * not even one of the old domain checks. Collapsing this module to a single
 * isStaffRole(role) check means those hrefs are now role-gated for the
 * first time. This is a deliberate tightening, not an oversight, and is a
 * no-op in practice: filterAdminNavGroups is only ever called from
 * (admin)/layout.tsx after decideAdminAccess has already required
 * isNonParticipantRole (src/lib/auth/post-login-destination.ts — a
 * separate, WIDER check than this module's isStaffRole) to reach this code
 * at all.
 */

import type { NavGroup } from './nav-types';
import { isStaffRole } from '@/lib/auth/is-staff-role';

function isHrefVisible(role: string | null | undefined): boolean {
  return isStaffRole(role);
}

/**
 * Returns a new NavGroup[] containing only the items visible to `role`.
 * Groups that end up with zero visible items are dropped entirely (no
 * empty group headers rendered in the sidebar). Visibility no longer
 * varies by href (see this file's top doc comment), so every item within
 * a group is included or excluded uniformly based on `role` alone.
 */
export function filterAdminNavGroups(
  navGroups: NavGroup[],
  role: string | null | undefined
): NavGroup[] {
  if (!isHrefVisible(role)) {
    return [];
  }
  return navGroups.filter((group) => group.items.length > 0);
}
