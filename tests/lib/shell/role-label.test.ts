import { describe, expect, it } from 'vitest';
import { roleLabelKey, ROLE_LABEL_KEYS } from '@/lib/shell/role-label';

// Pure-logic unit coverage for the raw user_role -> i18n message key
// mapping used by both (admin)/layout.tsx and
// (participant)/(shell)/layout.tsx to build `userDisplay.roleLabel`
// before it ever reaches AppShell/Topbar/UserMenu. No Next.js/Supabase
// imports here either, so a plain synchronous test suffices (see
// admin-access.test.ts's doc comment for the same rationale).
//
// Keys are namespace-RELATIVE (`roles.<role>`, not `shell.roles.<role>`)
// because both real call sites already scope their `t` to the `shell`
// namespace via getTranslations({ namespace: 'shell' }) before calling
// t(key) — a fully-qualified key here would double the namespace prefix
// and crash (this was a real, confirmed MISSING_MESSAGE production bug:
// `shell.shell.roles.participant`), which is exactly what these
// assertions guard against regressing.
describe('roleLabelKey', () => {
  it('maps every real user_role enum value to a namespace-relative roles.* key', () => {
    // Mirrors the enum as originally defined in
    // supabase/migrations/20260721200747_roles_and_profiles.sql, plus the
    // roles added since: travel_operations_staff and participant_care_staff
    // (20260730100000), participants_communications_manager and
    // program_attendance_manager (20260803100000), and scanner_device
    // (20260804110000). Previously this list only had the original 5 and
    // was out of sync with both the real enum and
    // tests/lib/auth/post-login-destination.test.ts's NON_PARTICIPANT_ROLES
    // list (renamed from STAFF_ROLES as of the 2026-09-29 staff role
    // consolidation).
    const REAL_ENUM_VALUES = [
      'participant',
      'super_admin',
      'registration_admission_manager',
      'agenda_allocation_manager',
      'communications_attendance_manager',
      'travel_operations_staff',
      'participant_care_staff',
      'participants_communications_manager',
      'program_attendance_manager',
      'scanner_device',
    ] as const;

    for (const role of REAL_ENUM_VALUES) {
      expect(roleLabelKey(role)).toBe(`roles.${role}`);
      expect(roleLabelKey(role)).not.toMatch(/^shell\./);
    }
  });

  it('returns undefined for null/undefined (no profile row found)', () => {
    expect(roleLabelKey(null)).toBeUndefined();
    expect(roleLabelKey(undefined)).toBeUndefined();
  });

  it('returns undefined for an unrecognized role value rather than throwing', () => {
    expect(roleLabelKey('some_future_role')).toBeUndefined();
    expect(roleLabelKey('')).toBeUndefined();
  });

  it('ROLE_LABEL_KEYS has no raw enum value leaking through as its own key label', () => {
    // Every value in the map must itself be a translation KEY (a
    // namespace-relative `roles.*` path), never the raw enum value
    // re-exposed unchanged — this is the exact privacy boundary the
    // layouts rely on.
    for (const [role, key] of Object.entries(ROLE_LABEL_KEYS)) {
      expect(key).toBe(`roles.${role}`);
      expect(key.startsWith('roles.')).toBe(true);
    }
  });

  it('keys are namespace-relative, not fully-qualified with the shell. prefix', () => {
    // Regression guard for the real production crash: both call sites
    // scope `t` to the `shell` namespace already, so a fully-qualified
    // key here would resolve to `shell.shell.roles.<role>` and throw
    // MISSING_MESSAGE.
    for (const key of Object.values(ROLE_LABEL_KEYS)) {
      expect(key.startsWith('shell.')).toBe(false);
    }
  });
});
