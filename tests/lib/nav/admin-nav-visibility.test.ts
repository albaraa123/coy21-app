import { describe, expect, it } from 'vitest';
import { filterAdminNavGroups } from '@/lib/nav/admin-nav-visibility';
import { adminNavGroups } from '@/lib/nav/admin-nav-config';

// Pure-logic unit coverage: filterAdminNavGroups has zero Next.js/Supabase
// imports (it only calls isAgendaStaffRole/isAdmissionStaffRole), so this is
// a plain synchronous test — same pattern as
// tests/lib/shell/admin-access.test.ts. Each case is cross-checked against
// the real per-page role check (src/lib/validation/agenda.ts,
// src/lib/validation/admission-review.ts) so this test fails if a page's
// actual gate ever diverges from what the sidebar shows for that role.
describe('filterAdminNavGroups', () => {
  it('shows every group to super_admin (union of both role checks)', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'super_admin');
    expect(result).toEqual(adminNavGroups);
  });

  it('shows Agenda/Allocation/Schedule Publication groups but hides /applications and Attendance for agenda_allocation_manager (not an admission or program-attendance staff role)', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'agenda_allocation_manager');
    expect(result.map((g) => g.labelKey)).toEqual([
      'nav.groups.participants',
      'nav.groups.agenda',
      'nav.groups.allocation',
      'nav.groups.schedulePublication',
    ]);
    expect(result.map((g) => g.labelKey)).not.toContain('nav.groups.attendance');
    const participantsGroup = result.find((g) => g.labelKey === 'nav.groups.participants')!;
    expect(participantsGroup.items.map((i) => i.href)).toEqual([
      '/participants',
      '/participants/import',
      '/participants/imports',
    ]);
  });

  it('hides Agenda/Allocation/Schedule Publication groups but shows /applications and /participants/accounts for registration_admission_manager', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'registration_admission_manager');
    expect(result.map((g) => g.labelKey)).toEqual(['nav.groups.participants']);
    const participantsGroup = result[0];
    expect(participantsGroup.items.map((i) => i.href)).toEqual(['/applications', '/participants/accounts']);
  });

  it('hides every group for communications_attendance_manager (no admin pages exist for this role yet)', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'communications_attendance_manager');
    expect(result).toEqual([]);
  });

  it('shows only the import pipeline + accounts for participants_communications_manager, hides /applications and every agenda/allocation/schedule group', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'participants_communications_manager');
    expect(result.map((g) => g.labelKey)).toEqual(['nav.groups.participants']);
    const participantsGroup = result[0];
    expect(participantsGroup.items.map((i) => i.href)).toEqual([
      '/participants',
      '/participants/import',
      '/participants/imports',
      '/participants/accounts',
    ]);
    expect(participantsGroup.items.map((i) => i.href)).not.toContain('/applications');
  });

  it('shows agenda/allocation/schedule-publication/attendance groups for program_attendance_manager, hides the participants group entirely (no import or account access)', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'program_attendance_manager');
    expect(result.map((g) => g.labelKey)).toEqual([
      'nav.groups.agenda',
      'nav.groups.allocation',
      'nav.groups.schedulePublication',
      'nav.groups.attendance',
    ]);
    expect(result.map((g) => g.labelKey)).not.toContain('nav.groups.participants');
    const attendanceGroup = result.find((g) => g.labelKey === 'nav.groups.attendance')!;
    expect(attendanceGroup.items.map((i) => i.href)).toEqual(['/attendance/scanners', '/attendance/admissions', '/attendance/demand']);
  });

  it('hides the Attendance group for every role except program_attendance_manager/super_admin', () => {
    for (const role of ['agenda_allocation_manager', 'registration_admission_manager', 'communications_attendance_manager', 'participants_communications_manager', 'participant']) {
      const result = filterAdminNavGroups(adminNavGroups, role);
      expect(result.map((g) => g.labelKey)).not.toContain('nav.groups.attendance');
    }
  });

  it('shows only /participants/care (within the Participants group) for participant_care_staff, hiding every other item and group', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'participant_care_staff');
    expect(result.map((g) => g.labelKey)).toEqual(['nav.groups.participants']);
    const participantsGroup = result[0];
    expect(participantsGroup.items.map((i) => i.href)).toEqual(['/participants/care']);
  });

  it('hides /participants/care for every role except participant_care_staff/super_admin', () => {
    for (const role of [
      'agenda_allocation_manager',
      'registration_admission_manager',
      'communications_attendance_manager',
      'participants_communications_manager',
      'program_attendance_manager',
      'participant',
    ]) {
      const result = filterAdminNavGroups(adminNavGroups, role);
      const participantsGroup = result.find((g) => g.labelKey === 'nav.groups.participants');
      expect(participantsGroup?.items.map((i) => i.href) ?? []).not.toContain('/participants/care');
    }
  });

  it('shows only /participants/travel (within the Participants group) for travel_operations_staff, hiding every other item and group', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'travel_operations_staff');
    expect(result.map((g) => g.labelKey)).toEqual(['nav.groups.participants']);
    const participantsGroup = result[0];
    expect(participantsGroup.items.map((i) => i.href)).toEqual(['/participants/travel']);
  });

  it('hides /participants/travel for every role except travel_operations_staff/super_admin (including participant_care_staff, a disjoint sensitive-data role)', () => {
    for (const role of [
      'agenda_allocation_manager',
      'registration_admission_manager',
      'communications_attendance_manager',
      'participants_communications_manager',
      'program_attendance_manager',
      'participant_care_staff',
      'participant',
    ]) {
      const result = filterAdminNavGroups(adminNavGroups, role);
      const participantsGroup = result.find((g) => g.labelKey === 'nav.groups.participants');
      expect(participantsGroup?.items.map((i) => i.href) ?? []).not.toContain('/participants/travel');
    }
  });

  it('hides every group for a participant/null/undefined role', () => {
    expect(filterAdminNavGroups(adminNavGroups, 'participant')).toEqual([]);
    expect(filterAdminNavGroups(adminNavGroups, null)).toEqual([]);
    expect(filterAdminNavGroups(adminNavGroups, undefined)).toEqual([]);
  });

  it('drops a group entirely (no empty group header) when it has zero visible items', () => {
    const result = filterAdminNavGroups(adminNavGroups, 'registration_admission_manager');
    const groupLabels = result.map((g) => g.labelKey);
    expect(groupLabels).not.toContain('nav.groups.agenda');
    expect(groupLabels).not.toContain('nav.groups.allocation');
    expect(groupLabels).not.toContain('nav.groups.schedulePublication');
  });

  it('never mutates the original adminNavGroups array', () => {
    const before = JSON.parse(JSON.stringify(adminNavGroups));
    filterAdminNavGroups(adminNavGroups, 'registration_admission_manager');
    expect(adminNavGroups).toEqual(before);
  });
});
