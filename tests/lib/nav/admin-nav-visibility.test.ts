import { describe, expect, it } from 'vitest';
import { filterAdminNavGroups } from '@/lib/nav/admin-nav-visibility';
import { adminNavGroups } from '@/lib/nav/admin-nav-config';

// Pure-logic unit coverage: filterAdminNavGroups has zero Next.js/Supabase
// imports (it only calls isStaffRole / isRouteAllowedForStaff), so this is
// a plain synchronous test — same pattern as tests/lib/shell/admin-access.test.ts.
//
// HISTORY: before the 2026-09-29 staff role consolidation
// (docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md),
// this suite asserted per-domain-role visibility (agenda_allocation_manager,
// registration_admission_manager, communications_attendance_manager,
// participants_communications_manager, program_attendance_manager,
// participant_care_staff, travel_operations_staff). That consolidation
// merged all 7 staff-domain roles into a single 'staff' user_role enum
// value, and adminNavGroups/filterAdminNavGroups were updated accordingly
// (commit 36906af) — but this test file was never updated to match at the
// time, leaving it asserting against role names that no longer appear in
// isStaffRole/adminNavGroups at all (pre-existing breakage, unrelated to
// the 2026-10-25 staff-narrowing work below; discovered and fixed here).
//
// UPDATE (2026-10-25 staff narrowing,
// docs/superpowers/specs/2026-10-25-profile-accommodation-staff-narrowing-design.md):
// `staff` is now filtered per-href down to isRouteAllowedForStaff's
// allowlist (/attendance/walk-in, /attendance/admissions only), reversing
// part of the 2026-09-29 consolidation for this one role. `super_admin`
// is unaffected and still sees every group/item uniformly.
describe('filterAdminNavGroups', () => {
  it('shows every group and item to super_admin, unfiltered', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'super_admin');
    expect(result).toEqual(adminNavGroups);
  });

  it('hides every group for a participant/null/undefined role', () => {
    expect(filterAdminNavGroups(adminNavGroups, 'participant')).toEqual([]);
    expect(filterAdminNavGroups(adminNavGroups, null)).toEqual([]);
    expect(filterAdminNavGroups(adminNavGroups, undefined)).toEqual([]);
  });

  it('hides every group for scanner_device (not a staff role per isStaffRole)', () => {
    expect(filterAdminNavGroups(adminNavGroups, 'scanner_device')).toEqual([]);
  });

  it('never mutates the original adminNavGroups array', () => {
    const before = JSON.parse(JSON.stringify(adminNavGroups));
    filterAdminNavGroups(adminNavGroups, 'super_admin');
    filterAdminNavGroups(adminNavGroups, 'staff');
    expect(adminNavGroups).toEqual(before);
  });

  describe('staff (2026-10-25 narrowing)', () => {
    it('shows only the Attendance group', () => {
      const result = filterAdminNavGroups(adminNavGroups, 'staff');
      expect(result.map((g) => g.labelKey)).toEqual(['nav.groups.attendance']);
    });

    it('within the Attendance group, shows only walkIn and admissions items', () => {
      const result = filterAdminNavGroups(adminNavGroups, 'staff');
      const attendanceGroup = result.find((g) => g.labelKey === 'nav.groups.attendance')!;
      expect(attendanceGroup.items.map((i) => i.href)).toEqual(['/attendance/admissions', '/attendance/walk-in']);
    });

    it('hides scanners, demand, and opsDashboard items', () => {
      const result = filterAdminNavGroups(adminNavGroups, 'staff');
      const attendanceGroup = result.find((g) => g.labelKey === 'nav.groups.attendance');
      const hrefs = attendanceGroup?.items.map((i) => i.href) ?? [];
      expect(hrefs).not.toContain('/attendance/scanners');
      expect(hrefs).not.toContain('/attendance/demand');
      expect(hrefs).not.toContain('/attendance/ops-dashboard');
    });

    it('drops every other group entirely (Participants, Agenda, Reporting, Staff, Settings)', () => {
      const result = filterAdminNavGroups(adminNavGroups, 'staff');
      const groupLabels = result.map((g) => g.labelKey);
      expect(groupLabels).not.toContain('nav.groups.participants');
      expect(groupLabels).not.toContain('nav.groups.agenda');
      expect(groupLabels).not.toContain('nav.groups.reporting');
      expect(groupLabels).not.toContain('nav.groups.staff');
      expect(groupLabels).not.toContain('nav.groups.settings');
    });
  });
});
