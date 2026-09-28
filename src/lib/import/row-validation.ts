// src/lib/import/row-validation.ts
import { normalizeEmail, isValidEmail, normalizePhone, normalizeYesNo, splitMultiSelect, normalizeTrackLabel, normalizeFundingType, normalizeAttendanceConfirmation } from './normalization';

export interface ColumnMapping {
  sourceColumnIndex: number;
  targetKind: 'core_field' | 'known_answer' | 'generic_answer' | 'ignored' | 'travel_field' | 'health_field';
  targetKey: string | null;
}

export interface ValidationIssue {
  column: string;
  originalValue: string | null;
  error: string;
}

export interface RowValidationResult {
  status: 'valid' | 'warning' | 'invalid';
  normalizedRow: Record<string, unknown>;
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
}

// Fields that get special-cased transforms beyond plain trim/pass-through.
// Extending this is how a future known_answer/core_field gets richer
// normalization without touching the generic loop below.
const MULTISELECT_KEYS = new Set([
  'interests', 'topics_to_learn', 'track_interests',
  // Phase B: allocation-relevant multi-select columns (design doc section
  // 13.2/13.5) — same splitMultiSelect separator convention (comma,
  // semicolon, newline) as the existing multi-select fields.
  'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
]);
const YES_NO_KEYS = new Set<string>([]); // reserved for future known boolean fields; none in this phase's known-field list yet

// Track terminology correction: primary_track/secondary_track are the only
// two fields representing "which track is this participant's preference" —
// track_1/2/3_focus_areas (per-track free-text answer lists) and
// track_interests are unaffected. Values are normalized against every known
// spelling (canonical code, official name, historical alias) via
// normalizeTrackLabel; a value that resolves to Track 4 is rejected as an
// error (Track 4 is a real agenda track but not a valid participant
// specialization preference), never silently dropped or downgraded to a
// warning.
const TRACK_PREFERENCE_KEYS = new Set(['primary_track', 'secondary_track']);

// funding_type: normalized against every known spelling (canonical code,
// plain wording, common real-world phrasing) via normalizeFundingType. An
// unrecognized value is preserved as-is and flagged only as a warning
// (never blocking) — same permissive treatment as an unrecognized track
// label, since funding data quality shouldn't block an otherwise-valid
// participant import.
const FUNDING_TYPE_KEYS = new Set(['funding_type']);

// attendance_confirmation: same permissive treatment as funding_type — an
// unrecognized value is preserved as-is and flagged only as a warning,
// never blocking.
const ATTENDANCE_CONFIRMATION_KEYS = new Set(['attendance_confirmation']);

// Phase B (design doc section 13.5): dates outside applications' existing
// birth_date (which has no JS-layer validation today — an intentionally
// unchanged, pre-existing gap, not repeated here) get an explicit,
// warning-level (never blocking) format check, so a malformed passport date
// is flagged for admin review in the preview UI rather than silently
// discarded three layers downstream inside the SQL apply function's cast.
const DATE_KEYS = new Set(['passport_issue_date', 'passport_expiry_date', 'passport_birth_date']);
// A plain, permissive ISO-ish check — deliberately not stricter than
// necessary. Accepts YYYY-MM-DD and lets an unambiguous native Date parse
// through as a fallback for other common spreadsheet date renderings; both
// paths converge on rejecting an unparseable/nonsensical value only.
function isPlausibleDate(raw: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return !Number.isNaN(d.getTime());
  }
  const d = new Date(raw);
  return !Number.isNaN(d.getTime());
}

// Phase B (design doc section 13.5): permissive phone-shape check for the
// two new phone-bearing keys, warning-level only — matches normalizePhone's
// existing "preserve original formatting" philosophy; this never rewrites
// the value, it only flags an implausible one for admin review. Accepts an
// optional leading '+', digits, and common separators (space/dash/paren),
// requires at least 7 digits total (short enough to admit real
// international numbers, long enough to reject obvious garbage like a
// single stray digit).
const PHONE_SHAPE = /^\+?[\d\s\-()]+$/;
function isPlausiblePhone(raw: string): boolean {
  if (!PHONE_SHAPE.test(raw)) return false;
  const digitCount = (raw.match(/\d/g) ?? []).length;
  return digitCount >= 7;
}

export function validateRow(
  rawRow: (string | null)[],
  mapping: ColumnMapping[],
  opts: { uniqueIdentifierColumnIndex: number }
): RowValidationResult {
  const normalizedRow: Record<string, unknown> = {};
  const warnings: ValidationIssue[] = [];
  const errors: ValidationIssue[] = [];

  // Track the raw value actually present in the column mapped to `email`,
  // rather than blindly reading opts.uniqueIdentifierColumnIndex. The two
  // usually coincide (email is typically the unique identifier column), but
  // reading the email-mapped column directly is the correct source of truth
  // for "what did the admin actually type in the email column" — sourcing
  // this from uniqueIdentifierColumnIndex unconditionally would silently
  // report the wrong column's value (or a redundant blank, since in the
  // common case where uniqueIdentifierColumnIndex IS the email column, the
  // missing-email error case would just read the same already-blank cell)
  // whenever the unique identifier is mapped to something other than email.
  // Fall back to the raw unique-identifier column only if no mapping entry
  // targets 'email' at all, so an error is still as informative as possible.
  let rawEmailValue: string | null = null;
  let mappingHasEmailColumn = false;

  for (const col of mapping) {
    if (col.targetKind === 'ignored' || col.targetKey === null) continue;
    const raw = rawRow[col.sourceColumnIndex] ?? null;
    if (col.targetKey === 'email') {
      rawEmailValue = raw;
      mappingHasEmailColumn = true;
    }
    if (raw === null || raw.trim() === '') continue; // blank cell: nothing to normalize, required-ness checked separately below

    let value: unknown = raw.trim();
    if (col.targetKey === 'email') {
      value = normalizeEmail(raw);
    } else if (
      col.targetKey === 'phone' ||
      col.targetKey === 'whatsapp' ||
      col.targetKey === 'whatsapp_number' ||
      col.targetKey.includes('phone')
    ) {
      value = normalizePhone(raw);
      // Phase B: warning-level shape check, never blocking — preserves the
      // original value exactly (see normalizePhone's own doc comment)
      // while flagging an implausible number for admin review.
      if (!isPlausiblePhone(raw)) {
        warnings.push({ column: col.targetKey, originalValue: raw, error: `"${raw}" does not look like a valid phone number` });
      }
    } else if (MULTISELECT_KEYS.has(col.targetKey)) {
      value = splitMultiSelect(raw);
    } else if (DATE_KEYS.has(col.targetKey)) {
      value = raw.trim();
      if (!isPlausibleDate(raw)) {
        warnings.push({ column: col.targetKey, originalValue: raw, error: `"${raw}" does not look like a valid date` });
      }
    } else if (YES_NO_KEYS.has(col.targetKey)) {
      const parsed = normalizeYesNo(raw);
      if (parsed === null) {
        warnings.push({ column: col.targetKey, originalValue: raw, error: `Unrecognized yes/no value "${raw}"` });
      }
      value = parsed;
    } else if (TRACK_PREFERENCE_KEYS.has(col.targetKey)) {
      const result = normalizeTrackLabel(raw);
      if (result.status === 'recognized_1_to_3') {
        value = result.code;
      } else if (result.status === 'recognized_track_4') {
        // Track 4 is a real agenda track but not a valid participant
        // specialization preference — reject rather than silently import.
        errors.push({
          column: col.targetKey,
          originalValue: raw,
          error: `"${raw}" resolves to Track 4, which cannot be imported as a ${col.targetKey === 'primary_track' ? 'primary' : 'secondary'} track preference (Tracks 1-3 only)`,
        });
        value = raw.trim();
      } else {
        // Free text that doesn't match any known track spelling: preserved
        // as-is (matching this field's pre-existing permissive behavior),
        // flagged only as a warning so an admin can review it in the
        // preview UI rather than the row being silently accepted or blocked.
        warnings.push({ column: col.targetKey, originalValue: raw, error: `"${raw}" does not match a known track (Tracks 1-3)` });
        value = raw.trim();
      }
    } else if (FUNDING_TYPE_KEYS.has(col.targetKey)) {
      const result = normalizeFundingType(raw);
      if (result.status === 'recognized') {
        value = result.code;
      } else {
        warnings.push({ column: col.targetKey, originalValue: raw, error: `"${raw}" does not match a known funding type (self-funded, partially funded, fully funded)` });
        value = raw.trim();
      }
    } else if (ATTENDANCE_CONFIRMATION_KEYS.has(col.targetKey)) {
      const result = normalizeAttendanceConfirmation(raw);
      if (result.status === 'recognized') {
        value = result.code;
      } else {
        warnings.push({ column: col.targetKey, originalValue: raw, error: `"${raw}" does not match a known attendance confirmation value (confirmed, not confirmed, declined)` });
        value = raw.trim();
      }
    }
    normalizedRow[col.targetKey] = value;
  }

  // Required-field checks: full_name and email are the baseline per the
  // design spec's "at minimum, each participant must have enough
  // information to create a unique accepted-participant record."
  //
  // Note: normalizedRow retains whatever WAS successfully parsed from other
  // columns (e.g. full_name, known_answer fields) even when the row fails
  // these checks — invalid rows must not be silently discarded, since a
  // later preview UI needs to show admins what was actually extracted.
  if (!normalizedRow.full_name || String(normalizedRow.full_name).trim() === '') {
    errors.push({ column: 'full_name', originalValue: null, error: 'Full name is required' });
  }
  // Safe as long as 'email' is never added to MULTISELECT_KEYS/YES_NO_KEYS
  // and its dispatch branch above continues to assign a string — nothing
  // enforces that invariant at the type level.
  const email = normalizedRow.email as string | undefined;
  const emailOriginalValue = mappingHasEmailColumn
    ? rawEmailValue
    : (rawRow[opts.uniqueIdentifierColumnIndex] ?? null);
  if (!email) {
    errors.push({ column: 'email', originalValue: emailOriginalValue, error: 'Email is required' });
  } else if (!isValidEmail(email)) {
    errors.push({ column: 'email', originalValue: emailOriginalValue, error: `"${email}" is not a valid email address` });
  }

  const status: RowValidationResult['status'] = errors.length > 0 ? 'invalid' : warnings.length > 0 ? 'warning' : 'valid';
  return { status, normalizedRow, warnings, errors };
}

export type DuplicateClassification =
  | { status: 'duplicate_in_file'; duplicateOfRowIndex: number }
  | { status: 'existing_unclaimed'; applicationId: string }
  | { status: 'existing_claimed'; applicationId: string }
  | { status: 'blocked_downstream'; applicationId: string };

export function classifyDuplicateStatus(
  normalizedEmail: string,
  ctx: {
    // This function never writes to seenEmailsInFile itself — the CALLER is
    // responsible for calling seenEmailsInFile.set(normalizedEmail, rowIndex)
    // after classifying each row, so later rows in the same file can be
    // detected as duplicates of earlier ones. Forgetting this per-row update
    // would silently break within-file dedup for row 3+ with no error from
    // this function — nothing here can detect or enforce that the caller
    // did it.
    seenEmailsInFile: Map<string, number>;
    rowIndex: number;
    existingApplication: { id: string; applicantId: string | null; hasDownstreamReference: boolean } | null;
  }
): DuplicateClassification | null {
  // Within-file duplicates are checked FIRST, ahead of any existing-database
  // match. A within-file duplicate is a data-entry problem in THIS upload
  // (two rows in the sheet claim the same email) and is what the admin needs
  // to resolve first; it takes precedence even if that same email also
  // happens to match a blocked-downstream existing application in the
  // database, per the design spec's stated checking order (within-file,
  // then existing-claimed/unclaimed, with blocked_downstream overriding
  // claimed/unclaimed status only within that second check).
  const priorRowIndex = ctx.seenEmailsInFile.get(normalizedEmail);
  if (priorRowIndex !== undefined) {
    return { status: 'duplicate_in_file', duplicateOfRowIndex: priorRowIndex };
  }
  if (ctx.existingApplication) {
    if (ctx.existingApplication.hasDownstreamReference) {
      return { status: 'blocked_downstream', applicationId: ctx.existingApplication.id };
    }
    return ctx.existingApplication.applicantId === null
      ? { status: 'existing_unclaimed', applicationId: ctx.existingApplication.id }
      : { status: 'existing_claimed', applicationId: ctx.existingApplication.id };
  }
  return null;
}
