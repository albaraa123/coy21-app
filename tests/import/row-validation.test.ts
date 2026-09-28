// tests/import/row-validation.test.ts
import { describe, expect, it } from 'vitest';
import { validateRow, classifyDuplicateStatus, type ColumnMapping } from '@/lib/import/row-validation';

const baseMapping: ColumnMapping[] = [
  { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
  { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
  { sourceColumnIndex: 2, targetKind: 'known_answer', targetKey: 'accessibility_requirements' },
  { sourceColumnIndex: 3, targetKind: 'ignored', targetKey: null },
];

describe('validateRow', () => {
  it('marks a row with full name and valid email as valid', () => {
    const result = validateRow(['Jane Doe', 'jane@example.com', '', 'noise'], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('valid');
    expect(result.errors).toHaveLength(0);
  });

  it('marks a row with a missing required field (email) as invalid', () => {
    const result = validateRow(['Jane Doe', '', '', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid');
    expect(result.errors.some((e) => e.column === 'email')).toBe(true);
  });

  it('marks a row with an invalid email format as invalid, with a human-readable reason', () => {
    const result = validateRow(['Jane Doe', 'not-an-email', '', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid');
    expect(result.errors[0].error).toMatch(/email/i);
    expect(result.errors[0].column).toBe('email');
    expect(result.errors[0].originalValue).toBe('not-an-email');
  });

  it('produces a normalized_row with mapped core fields keyed by target', () => {
    const result = validateRow(['Jane Doe', 'JANE@EXAMPLE.COM', 'wheelchair access', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.normalizedRow.full_name).toBe('Jane Doe');
    expect(result.normalizedRow.email).toBe('jane@example.com');
  });

  it('ignores columns mapped to target_kind ignored', () => {
    const result = validateRow(['Jane Doe', 'jane@example.com', '', 'this should not appear anywhere'], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(JSON.stringify(result.normalizedRow)).not.toContain('this should not appear anywhere');
  });

  it('preserves a fully blank row as a distinct, non-crashing case', () => {
    const result = validateRow(['', '', '', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid'); // blank required field
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('reports independent errors for both required fields when both are missing, not just one', () => {
    const result = validateRow(['', '', '', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.errors.some((e) => e.column === 'full_name')).toBe(true);
    expect(result.errors.some((e) => e.column === 'email')).toBe(true);
    expect(result.errors).toHaveLength(2);
  });

  it('preserves successfully-parsed fields in normalizedRow even when the row overall fails validation', () => {
    // full_name is present and valid; email is missing. The row is invalid,
    // but the preview UI (a later task) needs to show what WAS extracted —
    // full_name and the known_answer column should still show up.
    const result = validateRow(['Jane Doe', '', 'wheelchair access', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid');
    expect(result.normalizedRow.full_name).toBe('Jane Doe');
    expect(result.normalizedRow.accessibility_requirements).toBe('wheelchair access');
    expect(result.normalizedRow.email).toBeUndefined();
  });

  it('reports the raw original value for an invalid email even when other columns are blank', () => {
    // originalValue for a required-field error should reflect what was
    // actually typed in the mapped email column, not some other column.
    const result = validateRow(['Jane Doe', 'not-an-email', '', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    const emailError = result.errors.find((e) => e.column === 'email');
    expect(emailError?.originalValue).toBe('not-an-email');
  });
});

describe('validateRow — primary_track/secondary_track normalization', () => {
  const trackMapping: ColumnMapping[] = [
    { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
    { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
    { sourceColumnIndex: 2, targetKind: 'core_field', targetKey: 'primary_track' },
    { sourceColumnIndex: 3, targetKind: 'core_field', targetKey: 'secondary_track' },
  ];

  it('normalizes an old-wording primary_track value to its canonical code, valid row', () => {
    const result = validateRow(
      ['Jane Doe', 'jane@example.com', 'Track 1: Adaptation, Resilience, and Human Well-Being', ''],
      trackMapping,
      { uniqueIdentifierColumnIndex: 1 }
    );
    expect(result.status).toBe('valid');
    expect(result.normalizedRow.primary_track).toBe('adaptation_resilience_communities');
  });

  it('normalizes a short-form secondary_track value ("Track 2") to its canonical code', () => {
    const result = validateRow(['Jane Doe', 'jane@example.com', '', 'Track 2'], trackMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('valid');
    expect(result.normalizedRow.secondary_track).toBe('just_transition_green_economy_climate_innovation');
  });

  it('rejects Track 4 as a primary_track preference with a blocking error, not a warning', () => {
    const result = validateRow(['Jane Doe', 'jane@example.com', 'Track 4: Cross-Cutting Track', ''], trackMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid');
    expect(result.errors.some((e) => e.column === 'primary_track' && /track 4/i.test(e.error))).toBe(true);
    expect(result.warnings.some((w) => w.column === 'primary_track')).toBe(false);
  });

  it('rejects Track 4 as a secondary_track preference with a blocking error', () => {
    const result = validateRow(['Jane Doe', 'jane@example.com', '', 'cross_cutting_track'], trackMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid');
    expect(result.errors.some((e) => e.column === 'secondary_track')).toBe(true);
  });

  it('treats an unrecognized track value as a non-blocking warning, preserving the original text', () => {
    const result = validateRow(['Jane Doe', 'jane@example.com', 'Some unrelated free text', ''], trackMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('warning');
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.column === 'primary_track')).toBe(true);
    expect(result.normalizedRow.primary_track).toBe('Some unrelated free text');
  });

  it('does not confuse the admission_policy value "cross_cutting" with Track 4 when it appears in a track column', () => {
    // 'cross_cutting' alone is not a track label — it should fall through to
    // the unrecognized/warning path, never be treated as Track 4.
    const result = validateRow(['Jane Doe', 'jane@example.com', 'cross_cutting', ''], trackMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('warning');
    expect(result.errors).toHaveLength(0);
  });
});

describe('classifyDuplicateStatus', () => {
  it('classifies two rows in the same file with the same normalized email as duplicate_in_file', () => {
    const seen = new Map<string, number>();
    const first = classifyDuplicateStatus('jane@example.com', { seenEmailsInFile: seen, rowIndex: 0, existingApplication: null });
    expect(first).toBeNull(); // first occurrence is not itself a duplicate
    seen.set('jane@example.com', 0);
    const second = classifyDuplicateStatus('jane@example.com', { seenEmailsInFile: seen, rowIndex: 5, existingApplication: null });
    expect(second).toEqual({ status: 'duplicate_in_file', duplicateOfRowIndex: 0 });
  });

  it('classifies a match against an unclaimed existing application as existing_unclaimed', () => {
    const result = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: new Map(), rowIndex: 0,
      existingApplication: { id: 'app-1', applicantId: null, hasDownstreamReference: false },
    });
    expect(result).toEqual({ status: 'existing_unclaimed', applicationId: 'app-1' });
  });

  it('classifies a match against a claimed existing application as existing_claimed', () => {
    const result = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: new Map(), rowIndex: 0,
      existingApplication: { id: 'app-1', applicantId: 'user-1', hasDownstreamReference: false },
    });
    expect(result).toEqual({ status: 'existing_claimed', applicationId: 'app-1' });
  });

  it('classifies a match with downstream references as blocked_downstream regardless of claim status', () => {
    const claimed = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: new Map(), rowIndex: 0,
      existingApplication: { id: 'app-1', applicantId: 'user-1', hasDownstreamReference: true },
    });
    expect(claimed).toEqual({ status: 'blocked_downstream', applicationId: 'app-1' });
    const unclaimed = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: new Map(), rowIndex: 0,
      existingApplication: { id: 'app-2', applicantId: null, hasDownstreamReference: true },
    });
    expect(unclaimed).toEqual({ status: 'blocked_downstream', applicationId: 'app-2' });
  });

  it('classifies a within-file duplicate that ALSO matches a blocked-downstream existing application as duplicate_in_file (within-file takes precedence)', () => {
    // Per the design spec, checking order is: within-file first, THEN
    // existing-database matches. A within-file duplicate is a data-entry
    // problem in THIS upload and should surface first — the second (and
    // any subsequent) occurrence of an email within the same file is
    // flagged duplicate_in_file even if that email also happens to match
    // a blocked-downstream existing application in the database.
    const seen = new Map<string, number>([['jane@example.com', 0]]);
    const result = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: seen,
      rowIndex: 5,
      existingApplication: { id: 'app-1', applicantId: 'user-1', hasDownstreamReference: true },
    });
    expect(result).toEqual({ status: 'duplicate_in_file', duplicateOfRowIndex: 0 });
  });
});
