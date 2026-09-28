// Pure TypeScript mirror of the scan_attempt_transactional RPC's decision
// logic (supabase/migrations/20260804160000_scan_attempt_transactional_
// function.sql). Used for: (a) the read-only preview call before operator
// confirmation, (b) getAlternativesForTimeslot's availability preview.
// The RPC is the sole source of truth for what actually gets WRITTEN —
// this function must never be used to justify a write itself, only to
// preview one. Keep the two implementations logically identical; if you
// change one, change the other and re-run both test suites.
export type AdmissionPolicy = 'open' | 'priority_then_open' | 'restricted' | 'plenary' | 'cross_cutting';
// Exactly the 9 values in scan_attempts.result's check constraint (Task
// 4) plus 'override_admitted' — deliberately no separate "not open"/
// "late entry blocked" codes: both collapse into 'invalid_qr' below, to
// stay byte-for-byte in sync with what scan_attempt_transactional (Task
// 11) actually writes.
export type AdmissionResult =
  | 'admitted'
  | 'flexible_admitted'
  | 'priority_hold'
  | 'full'
  | 'restricted_denied'
  | 'duplicate'
  | 'timeslot_conflict'
  | 'invalid_qr';
export type EntryType = 'priority' | 'flexible' | 'override' | null;

export interface SessionForAdmission {
  status: string;
  admissionPolicy: AdmissionPolicy;
  capacity: number;
  prioritySeats: number | null;
  priorityReleaseAt: string | null;
  priorityReleaseMinutesBefore: number | null;
  lateEntryCutoffMinutes: number | null;
  flexibleEntryManualOverride: boolean | null;
  startTime: string;
}

export interface SessionCounts {
  totalAdmitted: number;
  admittedPriorityCount: number;
  admittedFlexibleCount: number;
}

export interface AdmissionDecisionInput {
  now: Date;
  session: SessionForAdmission;
  isRecommended: boolean;
  hasActiveAttendanceForThisSession: boolean;
  hasActiveAttendanceForConflictingSession: boolean;
  sessionCounts: SessionCounts;
  isOverrideCaller: boolean;
}

export interface AdmissionDecision {
  result: AdmissionResult;
  entryType: EntryType;
}

function effectivePriorityPool(session: SessionForAdmission): number {
  return session.prioritySeats ?? session.capacity;
}

function isPastLateEntryCutoff(session: SessionForAdmission, now: Date): boolean {
  if (session.lateEntryCutoffMinutes == null) return false;
  const cutoff = new Date(session.startTime);
  cutoff.setMinutes(cutoff.getMinutes() + session.lateEntryCutoffMinutes);
  return now > cutoff;
}

function isPriorityReleased(session: SessionForAdmission, now: Date): boolean {
  if (session.flexibleEntryManualOverride === true) return true;
  if (session.flexibleEntryManualOverride === false) return false;
  if (session.priorityReleaseAt != null) return now >= new Date(session.priorityReleaseAt);
  if (session.priorityReleaseMinutesBefore != null) {
    const releaseAt = new Date(session.startTime);
    releaseAt.setMinutes(releaseAt.getMinutes() - session.priorityReleaseMinutesBefore);
    return now >= releaseAt;
  }
  return false; // never auto-releases without explicit timing or manual override
}

export function resolveAdmissionDecision(input: AdmissionDecisionInput): AdmissionDecision {
  const { session, now, sessionCounts } = input;

  if (input.hasActiveAttendanceForThisSession) return { result: 'duplicate', entryType: null };
  if (input.hasActiveAttendanceForConflictingSession) return { result: 'timeslot_conflict', entryType: null };
  // Both "session not confirmed" and "past late-entry cutoff" collapse to
  // 'invalid_qr' — see the AdmissionResult type's comment above for why.
  if (session.status !== 'confirmed') return { result: 'invalid_qr', entryType: null };
  if (isPastLateEntryCutoff(session, now) && !input.isOverrideCaller) {
    return { result: 'invalid_qr', entryType: null };
  }
  if (sessionCounts.totalAdmitted >= session.capacity) return { result: 'full', entryType: null };

  switch (session.admissionPolicy) {
    case 'restricted':
      if (!input.isRecommended) return { result: 'restricted_denied', entryType: null };
      return { result: 'admitted', entryType: 'priority' };

    case 'plenary':
    case 'open':
    case 'cross_cutting':
      return { result: 'flexible_admitted', entryType: 'flexible' };

    case 'priority_then_open': {
      if (input.isRecommended) return { result: 'admitted', entryType: 'priority' };

      const pool = effectivePriorityPool(session);
      const released = isPriorityReleased(session, now);
      const flexiblePool = session.capacity - pool + (released ? Math.max(0, pool - sessionCounts.admittedPriorityCount) : 0);

      if (sessionCounts.totalAdmitted < session.capacity && sessionCounts.admittedFlexibleCount < flexiblePool) {
        return { result: 'flexible_admitted', entryType: 'flexible' };
      }
      return { result: 'priority_hold', entryType: null };
    }
  }
}
