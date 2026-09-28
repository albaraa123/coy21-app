// src/lib/validation/import.ts
import { z } from 'zod';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB — generous for a 5,000-row participant sheet with no embedded images
export const CHUNK_SIZE = 250;
export const LOCK_TTL_SECONDS = 120;
export const MAPPING_CONFIDENCE_THRESHOLD = 0.7;

export const idSchema = z.string().uuid();

export const columnMappingInputSchema = z.object({
  sourceColumnIndex: z.number().int().min(0),
  targetKind: z.enum(['core_field', 'known_answer', 'generic_answer', 'ignored', 'travel_field', 'health_field']),
  targetKey: z.string().min(1).nullable(),
  isManualOverride: z.boolean().default(false),
});

export const confirmMappingSchema = z.object({
  batchId: idSchema,
  mappings: z.array(columnMappingInputSchema).min(1),
  uniqueIdentifierColumnIndex: z.number().int().min(0),
  saveAsTemplateName: z.string().trim().min(1).max(120).optional(),
});

export const processChunkSchema = z.object({
  batchId: idSchema,
  lockToken: z.string().uuid(),
});

export const enableAutoProcessSchema = z.object({
  batchId: idSchema,
  clusterK: z.number().int().positive(),
});

export const sendInvitationSchema = z.object({
  applicationId: idSchema,
});

export const claimApplicationSchema = z.object({
  applicationId: idSchema,
});

// Known question_key values whose application_answers rows are marked
// is_sensitive = true at write time — single source of truth, imported by
// both the import-write server action (Task 14) and the RLS-adjacent test
// (Task 5) so the two never drift.
//
// Phase B addition: every key redirected to application_health_info
// (design doc section 13.2, footnote 3) keeps its application_answers copy
// marked is_sensitive = true — that answers-table copy is audit-only
// (application_answers_sensitive_staff_all restricts is_sensitive rows to
// super_admin only, NOT travel_operations_staff/participant_care_staff;
// those two roles read the real, current value through the dedicated
// application_travel_info/application_health_info tables instead, which
// have their own, broader RLS). This list intentionally does NOT include
// the new travel_field keys (passport numbers, etc.) — travel data was
// never part of this pre-existing sensitive-answers mechanism and Phase A's
// application_travel_info table is its own, separate protection boundary.
export const SENSITIVE_QUESTION_KEYS = [
  'accessibility_requirements',
  'dietary_requirements',
  'emergency_contact_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
  'allergies',
  'medical_conditions',
  'emergency_medication',
  'accommodation_preference',
  'cultural_or_religious_requirements',
  'consent_given',
  'special_needs',
] as const;
