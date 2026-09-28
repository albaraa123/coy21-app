/**
 * Filters adminNavGroups down to the items a given staff role can actually
 * navigate to, so the sidebar never shows a link that leads to a page-level
 * notFound() for that role.
 *
 * This is a UX/display concern only — see admin-nav-config.ts's "NOT an
 * authorization mechanism" caveat. The real gate is still, and must remain,
 * each page's own role check (src/lib/validation/*.ts). This module
 * duplicates those checks' RESULTS per href (not their definitions — it
 * imports the real predicate functions) purely to decide visibility; it
 * never replaces or weakens the underlying per-page checks.
 *
 * href -> required check, verified against every page.tsx under (admin)/:
 *  - isAdmissionStaffRole OR isParticipantsCommunicationsStaffRole:
 *    /participants/accounts (participant account management).
 *  - isAdmissionStaffRole only: /applications (and its [id] detail page,
 *    reached by clicking a row rather than a standalone nav item) —
 *    application review/status decisions stay registration_admission_manager
 *    + super_admin only; participants_communications_manager does not
 *    review/decide applications, only imports and provisions accounts for
 *    already-accepted ones.
 *  - isAgendaStaffRole OR isParticipantsCommunicationsStaffRole:
 *    /participants, /participants/import, /participants/imports (the import
 *    pipeline — both agenda staff and the new communications role can run
 *    imports).
 *  - isAgendaStaffRole OR isProgramAttendanceStaffRole: all of /agenda/*,
 *    all of /allocation/* (agenda/session/allocation/schedule-publication
 *    management).
 *  - isProgramAttendanceStaffRole only: /attendance/scanners,
 *    /attendance/admissions, /attendance/demand (scanner assignment,
 *    admission management, and the read-only demand/capacity dashboard —
 *    program_attendance_manager + super_admin only, matches
 *    requireProgramAttendanceStaffCaller exactly).
 *  - isParticipantCareStaffRole only: /participants/care (participant
 *    health/accessibility/dietary/emergency-contact data — a dedicated
 *    sensitive-data role, disjoint from every other admin role's access;
 *    matches requireParticipantCareStaffCaller exactly, see
 *    src/lib/participant-care/server-helpers.ts).
 *  - isTravelOpsStaffRole only: /participants/travel (travel/visa/passport
 *    data — a dedicated sensitive-data role, disjoint from every other
 *    admin role's access, including isParticipantCareStaffRole; matches
 *    requireTravelOpsStaffCaller exactly, see
 *    src/lib/travel-ops/server-helpers.ts).
 *  - no check yet (route doesn't exist as a real page): /dashboard — kept
 *    visible to any staff role reaching this config, since there is no
 *    page-level gate to contradict yet (see admin-nav-config.ts's note on
 *    /dashboard being forward-looking infrastructure for Task 11).
 */

import type { NavGroup } from './nav-types';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isAdmissionStaffRole } from '@/lib/validation/admission-review';
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import { isParticipantCareStaffRole } from '@/lib/validation/participant-care';
import { isTravelOpsStaffRole } from '@/lib/validation/travel-ops';
import { canReadAttendanceConfirmation } from '@/lib/validation/funding-type';

const ACCOUNTS_HREFS = new Set(['/participants/accounts']);
const APPLICATIONS_ONLY_HREFS = new Set(['/applications']);
const IMPORT_HREFS = new Set(['/participants', '/participants/import', '/participants/imports']);
const PROGRAM_ATTENDANCE_ONLY_HREFS = new Set(['/attendance/scanners', '/attendance/admissions', '/attendance/demand']);
const PARTICIPANT_CARE_ONLY_HREFS = new Set(['/participants/care']);
const TRAVEL_OPS_ONLY_HREFS = new Set(['/participants/travel']);
const FUNDING_HREFS = new Set(['/participants/funding']);
// Routes accessible to any authenticated staff role (super_admin always passes,
// plus any role that can reach an admin URL at all).
const ANY_STAFF_HREFS = new Set([
  '/reports', '/communications', '/reports/local-info',
  '/staff', '/staff/assignments',
  '/participants/arrivals',
]);

function isHrefVisible(href: string, role: string | null | undefined): boolean {
  if (ANY_STAFF_HREFS.has(href)) {
    return true;
  }
  if (ACCOUNTS_HREFS.has(href)) {
    return isAdmissionStaffRole(role) || isParticipantsCommunicationsStaffRole(role);
  }
  if (APPLICATIONS_ONLY_HREFS.has(href)) {
    return isAdmissionStaffRole(role);
  }
  if (IMPORT_HREFS.has(href)) {
    return isAgendaStaffRole(role) || isParticipantsCommunicationsStaffRole(role);
  }
  if (PROGRAM_ATTENDANCE_ONLY_HREFS.has(href)) {
    // Scanner assignment management + admission management are
    // program_attendance_manager + super_admin ONLY, unlike /agenda/* and
    // /allocation/* which also accept isAgendaStaffRole — matches each
    // route's own actions.ts's requireProgramAttendanceStaffCaller exactly,
    // not the broader agenda/allocation domain check below.
    return isProgramAttendanceStaffRole(role);
  }
  if (PARTICIPANT_CARE_ONLY_HREFS.has(href)) {
    // A dedicated sensitive-data role with no overlap with any other admin
    // role's own access — matches requireParticipantCareStaffCaller
    // exactly. Deliberately NOT combined with isAdmissionStaffRole or any
    // other check: application_health_info's RLS policy grants access to
    // participant_care_staff/super_admin only (see
    // supabase/migrations/20260730110000_application_travel_and_health_info_tables.sql),
    // and this visibility check must not imply broader access than that.
    return isParticipantCareStaffRole(role);
  }
  if (TRAVEL_OPS_ONLY_HREFS.has(href)) {
    // Same disjoint-role reasoning as PARTICIPANT_CARE_ONLY_HREFS above —
    // application_travel_info's RLS policy grants access to
    // travel_operations_staff/super_admin only (see
    // supabase/migrations/20260730110000_application_travel_and_health_info_tables.sql).
    return isTravelOpsStaffRole(role);
  }
  if (FUNDING_HREFS.has(href)) {
    // "Participant Status" page (funding_type + attendance_confirmation).
    // Gated on the BROADER of the two field-level checks
    // (canReadAttendanceConfirmation = isFundingTypeStaffRole OR
    // participant_care_staff) so care staff can open the page for its
    // read-only attendance view — the console component itself hides
    // funding_type and every write control from a caller who only
    // satisfies the read-only check. See
    // supabase/migrations/20260820100000_add_funding_type.sql and
    // 20260820130000_add_attendance_confirmation.sql.
    return canReadAttendanceConfirmation(role);
  }
  // Everything else (all of /agenda/*, all of /allocation/*, /dashboard).
  return isAgendaStaffRole(role) || isProgramAttendanceStaffRole(role);
}

/**
 * Returns a new NavGroup[] containing only the items visible to `role`.
 * Groups that end up with zero visible items are dropped entirely (no
 * empty group headers rendered in the sidebar).
 */
export function filterAdminNavGroups(
  navGroups: NavGroup[],
  role: string | null | undefined
): NavGroup[] {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isHrefVisible(item.href, role)),
    }))
    .filter((group) => group.items.length > 0);
}
