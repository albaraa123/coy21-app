// src/lib/import/known-application-columns.ts
//
// Phase B (design doc section 13.9): the single shared source of truth for
// "which target_key values are legal for target_kind = 'travel_field' /
// 'health_field'". Consumed by confirmMapping (server-side validation,
// rejects a mapping before it ever reaches SQL) so a column cannot be
// mapped as travel_field/health_field pointing at a column that doesn't
// exist on the corresponding table — closing the loophole where an admin
// could otherwise type an arbitrary target_key into the mapping UI's free
// text input.
//
// This does NOT replace apply_import_row_transactional's own hardcoded SQL
// arrays as the runtime authority — that function independently verifies
// what it writes (defense in depth, matching this project's established
// "server actions must verify even when a check exists elsewhere"
// discipline). This manifest exists so the TWO lists (this one, and the
// SQL function's arrays) are each reviewed against the same known set
// rather than drifting independently — keep both in sync when either
// changes.
export const TRAVEL_FIELD_COLUMNS = [
  'support_level_requested',
  'can_attend_without_full_support',
  'departure_airport',
  'visa_required',
  'invitation_letter_required',
  'passport_full_name',
  'passport_full_name_ar',
  'passport_birth_date',
  'passport_place_of_issue',
  'passport_issue_date',
  'passport_expiry_date',
  'passport_copy_url',
  'passport_photo_url',
] as const;

export const HEALTH_FIELD_COLUMNS = [
  'allergies',
  'medical_conditions',
  'emergency_medication',
  'accessibility_requirements',
  'dietary_requirements',
  'accommodation_preference',
  'cultural_or_religious_requirements',
  'emergency_contact_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
  'consent_given',
] as const;

export function isKnownTravelFieldKey(key: string): boolean {
  return (TRAVEL_FIELD_COLUMNS as readonly string[]).includes(key);
}

export function isKnownHealthFieldKey(key: string): boolean {
  return (HEALTH_FIELD_COLUMNS as readonly string[]).includes(key);
}
