// Comma-separated-text <-> text[] conversion for the General
// Information editor's 6 array-typed applications columns (design
// spec: docs/superpowers/specs/2026-10-28-participant-general-info-editor-design.md).
//
// Accepted, documented tradeoff (per the spec's "Residual risk"
// section): safe for all current data in these 6 columns (traced every
// write path into them -- the CSV import pipeline's splitMultiSelect(),
// and the self-registration autosave's fixed, comma-free checkbox
// option list, both independently guarantee no existing element
// contains a literal comma), but NOT safe in general for a future
// free-text value that happens to contain a human-typed comma within
// one semantic item. Do not "fix" this with a different delimiter or
// escaping scheme -- that would be unrequested scope creep per the
// spec; this is a known, accepted limitation of an infrequent
// correction tool, not a defect.

export function arrayFieldToInput(value: string[] | null): string {
  if (!value || value.length === 0) return '';
  return value.join(', ');
}

export function inputToArrayField(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
