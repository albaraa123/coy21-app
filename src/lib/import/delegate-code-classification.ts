// src/lib/import/delegate-code-classification.ts
//
// Fixed prefix -> classification lookup for the one-time delegate/
// volunteer CSV import (design spec:
// docs/superpowers/specs/2026-10-28-delegate-volunteer-csv-import-design.md).
// Deliberately a fixed in-code table, not a database table or a column
// read from the source file -- matches this codebase's existing
// field-dictionary.ts convention for fixed import-time lookups.
//
// Every prefix is mutually non-prefixing with every other (verified by
// hand and by a dedicated test in this file's sibling test suite) --
// DEL-YNG- is not a substring-prefix of DEL-LCOY-/DEL-RCOY-/etc, so
// longest-match-first ordering is not required for correctness, but the
// entries are still checked in this fixed array order for determinism.
const PREFIX_CLASSIFICATION: Array<{
  prefix: string;
  participantType: 'delegate' | 'volunteer';
  registrationCategory: string;
}> = [
  { prefix: 'DEL-INT-', participantType: 'delegate', registrationCategory: 'Delegates' },
  { prefix: 'VOL-TUR-', participantType: 'volunteer', registrationCategory: 'Onground Volunteers' },
  { prefix: 'VOL-YNG-', participantType: 'volunteer', registrationCategory: 'COY21 Organizing Team Volunteers' },
  { prefix: 'DEL-UNW-', participantType: 'delegate', registrationCategory: 'UN Women Delegates' },
  { prefix: 'DEL-IOM-', participantType: 'delegate', registrationCategory: 'IOM Youth Delegates' },
  { prefix: 'DEL-PYCC-', participantType: 'delegate', registrationCategory: 'PYCC Delegates' },
  { prefix: 'DEL-YNG-', participantType: 'delegate', registrationCategory: 'Policy Team On-ground Delegates' },
  { prefix: 'DEL-LCOY-', participantType: 'delegate', registrationCategory: 'LCOY Delegates' },
  { prefix: 'DEL-RCOY-', participantType: 'delegate', registrationCategory: 'RCOY Delegates' },
];

export function classifyDelegateCode(
  code: string
): { participantType: 'delegate' | 'volunteer'; registrationCategory: string } | null {
  const trimmed = code.trim();
  for (const entry of PREFIX_CLASSIFICATION) {
    if (trimmed.startsWith(entry.prefix)) {
      return { participantType: entry.participantType, registrationCategory: entry.registrationCategory };
    }
  }
  return null;
}
