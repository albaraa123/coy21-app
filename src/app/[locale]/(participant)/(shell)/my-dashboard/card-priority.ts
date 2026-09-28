// src/app/[locale]/(participant)/(shell)/my-dashboard/card-priority.ts
//
// Pure function implementing the 3 representative states from
// docs/superpowers/specs/2026-09-28-participant-portal-ux-simplification-
// design.md §2. Deliberately NOT an exhaustive state machine (per spec's
// "Out of scope" note) — extend this function's cases if a future spec
// enumerates more states; do not special-case beyond what's listed here
// without updating the design doc first.
export type DashboardCardId = 'applicationStatus' | 'completeTravelInfo' | 'myQr' | 'myProgram';

export interface DashboardCardInputs {
  applicationStatus: 'draft' | 'submitted' | 'under_review' | 'accepted' | 'waitlisted' | 'rejected' | 'withdrawn';
  travelSubmitted: boolean;
  qrAvailable: boolean;
}

export function computeDashboardCardOrder(inputs: DashboardCardInputs): DashboardCardId[] {
  const notYetAccepted = ['submitted', 'under_review', 'waitlisted'].includes(inputs.applicationStatus);

  if (notYetAccepted) {
    return ['applicationStatus', 'myProgram'];
  }

  if (inputs.applicationStatus === 'accepted' && !inputs.travelSubmitted) {
    return ['completeTravelInfo', 'myQr', 'myProgram'];
  }

  if (inputs.applicationStatus === 'accepted' && inputs.travelSubmitted && inputs.qrAvailable) {
    return ['myQr', 'myProgram'];
  }

  // Fallback for accepted+travelSubmitted+!qrAvailable, and draft/rejected/
  // withdrawn — not covered as a named state by the spec's 3 examples.
  // Application status card first is the safest default (matches the
  // not-yet-accepted case) until this is refined against real usage.
  return ['applicationStatus', 'myProgram'];
}
