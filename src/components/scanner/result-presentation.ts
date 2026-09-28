// src/components/scanner/result-presentation.ts
//
// Centralized, exhaustively-typed presentation mapping for the 9 live
// scan_attempts.result values. Classifies by OPERATOR MEANING (what
// should the operator do next), not by backend implementation detail —
// derived from docs/superpowers/specs/
// 2026-07-31-flexible-admission-qr-attendance-design.md's own "Scan
// Results (color coding)" table (the authoritative source for these
// semantics; NOT guessed), adapted from that doc's originally-planned
// two-step preview/confirm color scheme to this codebase's actual
// one-step scan-and-commit architecture — same meanings, same color
// families, no invented categories:
//   admitted            Green   -> success
//   flexible_admitted    Blue    -> success
//   override_admitted    (same admitted family, distinctly labeled) -> success
//   priority_hold        Orange  -> attention (recoverable: wait / alternative / supervisor request)
//   duplicate            Gray    -> attention (informational, not an error — they're already in)
//   timeslot_conflict     Yellow  -> attention (warning, needs staff correction/transfer/override)
//   full                 Red     -> denied
//   restricted_denied     Red     -> denied
//   invalid_qr            Red     -> denied
//
// TypeScript exhaustiveness (PRESENTATIONS is typed as
// Record<LiveResultKind, ...>, a mapped type over the literal union
// below) is what proves "no unknown live result silently renders as
// success": if a 10th value were ever added to the live
// scan_attempts_result_check without updating this file, TypeScript
// fails to compile PRESENTATIONS as incomplete. getResultPresentation
// (the runtime half of the same guarantee) returns null for any value
// outside this set — callers must treat null as its own explicit
// "unrecognized result" case, never fall through to a default look.
export const LIVE_RESULT_KINDS = [
  'admitted',
  'flexible_admitted',
  'override_admitted',
  'priority_hold',
  'duplicate',
  'timeslot_conflict',
  'full',
  'restricted_denied',
  'invalid_qr',
] as const;

export type LiveResultKind = (typeof LIVE_RESULT_KINDS)[number];

export type ResultSeverity = 'success' | 'attention' | 'denied';

export interface ResultPresentation {
  severity: ResultSeverity;
  /** i18n message key under the `scanner.result.*` namespace for the headline. */
  headlineKey: string;
  /** i18n message key for the short operator instruction line. */
  instructionKey: string;
  /** Whether this outcome created an attendance_records row — informs whether "checked in" language is accurate. */
  admitted: boolean;
}

const PRESENTATIONS: Record<LiveResultKind, ResultPresentation> = {
  admitted: { severity: 'success', headlineKey: 'result.admitted.headline', instructionKey: 'result.admitted.instruction', admitted: true },
  flexible_admitted: {
    severity: 'success',
    headlineKey: 'result.flexible_admitted.headline',
    instructionKey: 'result.flexible_admitted.instruction',
    admitted: true,
  },
  override_admitted: {
    severity: 'success',
    headlineKey: 'result.override_admitted.headline',
    instructionKey: 'result.override_admitted.instruction',
    admitted: true,
  },
  priority_hold: {
    severity: 'attention',
    headlineKey: 'result.priority_hold.headline',
    instructionKey: 'result.priority_hold.instruction',
    admitted: false,
  },
  duplicate: { severity: 'attention', headlineKey: 'result.duplicate.headline', instructionKey: 'result.duplicate.instruction', admitted: false },
  timeslot_conflict: {
    severity: 'attention',
    headlineKey: 'result.timeslot_conflict.headline',
    instructionKey: 'result.timeslot_conflict.instruction',
    admitted: false,
  },
  full: { severity: 'denied', headlineKey: 'result.full.headline', instructionKey: 'result.full.instruction', admitted: false },
  restricted_denied: {
    severity: 'denied',
    headlineKey: 'result.restricted_denied.headline',
    instructionKey: 'result.restricted_denied.instruction',
    admitted: false,
  },
  invalid_qr: { severity: 'denied', headlineKey: 'result.invalid_qr.headline', instructionKey: 'result.invalid_qr.instruction', admitted: false },
};

function isLiveResultKind(value: string): value is LiveResultKind {
  return (LIVE_RESULT_KINDS as readonly string[]).includes(value);
}

/**
 * Returns the presentation for a live result value, or null for any
 * value outside the known 9. Runtime counterpart to PRESENTATIONS'
 * compile-time exhaustiveness — together they guarantee an unrecognized
 * result can never silently render as a success/neutral look.
 */
export function getResultPresentation(result: string): ResultPresentation | null {
  if (!isLiveResultKind(result)) return null;
  return PRESENTATIONS[result];
}
