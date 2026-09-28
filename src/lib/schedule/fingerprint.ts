import { createHash } from 'crypto';

export interface AssignmentForFingerprint {
  applicationId: string;
  sessionId: string;
  suitabilityScore: number;
  status: string;
  isManualOverride: boolean;
}

export interface IssueForFingerprint {
  issueType: string;
  applicationId: string | null;
  sessionId: string | null;
}

function hash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Mirrors the DB's compute_publication_fingerprint run-publish path (spec:
// Publication Transaction Design). Sort by (applicationId, sessionId) for
// assignments and by (issueType, applicationId, sessionId) for issues, so
// the fingerprint is order-independent on input but deterministic in
// output — same pattern as src/lib/allocation/time-slot-grouping.ts's
// computeTimeSlotGroupKey.
export function computeAssignmentSetFingerprint(
  assignments: AssignmentForFingerprint[],
  issues: IssueForFingerprint[]
): string {
  const sortedAssignments = [...assignments].sort((a, b) =>
    (a.applicationId + a.sessionId).localeCompare(b.applicationId + b.sessionId)
  );
  const sortedIssues = [...issues].sort((a, b) =>
    (a.issueType + (a.applicationId ?? '') + (a.sessionId ?? '')).localeCompare(
      b.issueType + (b.applicationId ?? '') + (b.sessionId ?? '')
    )
  );
  const assignmentPart = sortedAssignments
    .map((a) => `${a.applicationId}|${a.sessionId}|${a.suitabilityScore}|${a.status}|${a.isManualOverride}`)
    .join(';');
  const issuePart = sortedIssues.map((i) => `${i.issueType}|${i.applicationId ?? ''}|${i.sessionId ?? ''}`).join(';');
  return hash(`${assignmentPart}::${issuePart}`);
}

export interface SessionStateForFingerprint {
  sessionId: string;
  startTime: string;
  endTime: string;
  roomId: string;
  status: string;
}

export interface SessionPersonForFingerprint {
  sessionId: string;
  personId: string;
  role: string;
  displayOrder: number;
}

// Mirrors the DB's compute_publication_fingerprint change-propagation path.
// Includes both session fields AND session_people rows for every affected
// session regardless of which change_type triggered the event, so a
// speakers-only event's fingerprint still reflects current time/room too,
// and vice versa (spec: closes the cross-contamination gap).
export function computeSessionStateFingerprint(
  sessions: SessionStateForFingerprint[],
  sessionPeople: SessionPersonForFingerprint[]
): string {
  const sortedSessions = [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const sortedPeople = [...sessionPeople].sort((a, b) =>
    (a.sessionId + a.personId + a.role).localeCompare(b.sessionId + b.personId + b.role)
  );
  const sessionPart = sortedSessions.map((s) => `${s.sessionId}|${s.startTime}|${s.endTime}|${s.roomId}|${s.status}`).join(';');
  const peoplePart = sortedPeople.map((p) => `${p.sessionId}|${p.personId}|${p.role}|${p.displayOrder}`).join(';');
  return hash(`${sessionPart}::${peoplePart}`);
}

export interface VerdictInput {
  issues: { issueType: string; sessionIsMandatory: boolean }[];
  contentDiffersFromActive: boolean;
}

// Spec: Issue/Blocker Policy. An issue blocks only if it leaves a
// MANDATORY slot empty (unassigned/capacity_bottleneck/schedule_conflict/
// no_eligible_sessions affecting a mandatory session). The same issue
// types affecting only an elective session never block. low_confidence
// never blocks (surfaced informationally, gated by a separate batch
// acknowledgment in the UI, not this classification).
const BLOCKING_ISSUE_TYPES = new Set(['unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions']);

export function classifyVerdict(input: VerdictInput): 'publishable' | 'blocked_mandatory' | 'no_change' {
  const hasMandatoryBlocker = input.issues.some((i) => BLOCKING_ISSUE_TYPES.has(i.issueType) && i.sessionIsMandatory);
  if (hasMandatoryBlocker) return 'blocked_mandatory';
  if (!input.contentDiffersFromActive) return 'no_change';
  return 'publishable';
}
