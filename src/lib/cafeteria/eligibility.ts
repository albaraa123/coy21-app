//
// Single source of truth for lunch eligibility (design spec: delegates/
// volunteers who are accepted+confirmed, or any staff/super_admin
// account). Used identically at credential issuance, My QR Code card
// visibility, and scan-time re-check — never re-derived elsewhere.
import { isStaffRole } from '@/lib/auth/is-staff-role';

const ELIGIBLE_PARTICIPANT_TYPES = ['delegate', 'volunteer'] as const;

export function isLunchEligible(
  application: { participant_type: string | null; status: string; attendance_confirmation: string } | null,
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
