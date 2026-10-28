//
// Single source of truth for lunch eligibility (design spec: delegates/
// volunteers who are accepted+confirmed, or any staff/super_admin
// account). Used identically at credential issuance, My QR Code card
// visibility, and scan-time re-check — never re-derived elsewhere.
import { isStaffRole } from '@/lib/auth/is-staff-role';
import type { Database } from '@/types/database';

const ELIGIBLE_PARTICIPANT_TYPES = ['delegate', 'volunteer'] as const;

export function isLunchEligible(
  application: {
    participant_type: Database['public']['Enums']['participant_type'] | null;
    status: Database['public']['Enums']['application_status'];
    attendance_confirmation: Database['public']['Enums']['attendance_confirmation_status'];
  } | null,
  profile: { role: string | null } | null
): boolean {
  if (profile && isStaffRole(profile.role)) return true;
  if (
    application &&
    application.participant_type != null &&
    (ELIGIBLE_PARTICIPANT_TYPES as readonly string[]).includes(application.participant_type) &&
    application.status === 'accepted' &&
    application.attendance_confirmation === 'confirmed'
  ) {
    return true;
  }
  return false;
}

// Coffee-break eligibility (design spec: 2026-10-28-cafeteria-coffee-break-credit-design.md).
// Strict superset of lunch eligibility, plus speaker — the one
// participant_type excluded from lunch but included here per the
// organizing team's explicit decision. Nobody isLunchEligible already
// admits loses eligibility here; this only ever adds one more case.
export function isCoffeeEligible(
  application: {
    participant_type: Database['public']['Enums']['participant_type'] | null;
    status: Database['public']['Enums']['application_status'];
    attendance_confirmation: Database['public']['Enums']['attendance_confirmation_status'];
  } | null,
  profile: { role: string | null } | null
): boolean {
  if (isLunchEligible(application, profile)) return true;
  return (
    application != null &&
    application.participant_type === 'speaker' &&
    application.status === 'accepted' &&
    application.attendance_confirmation === 'confirmed'
  );
}
