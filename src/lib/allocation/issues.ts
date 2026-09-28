// src/lib/allocation/issues.ts
export type IssueType = 'unassigned' | 'low_confidence' | 'capacity_bottleneck' | 'schedule_conflict' | 'no_eligible_sessions';

export interface DerivedIssue {
  issueType: IssueType;
  applicationId: string | null;
  sessionId: string | null;
  details: Record<string, unknown>;
}

export interface AssignmentForIssues {
  id: string;
  applicationId: string;
  sessionId: string;
  timeSlotGroupKey: string;
  suitabilityScore: number;
}

export interface TimeSlotGroupForIssues {
  timeSlotGroupKey: string;
  eligibleSessionIdsByParticipant: Record<string, string[]>;
}

export interface ScheduleConflictPair {
  assignmentIds: [string, string];
  conferenceDayId: string;
}

export interface IssueDerivationInput {
  timeSlotGroups: TimeSlotGroupForIssues[];
  assignments: AssignmentForIssues[];
  lowConfidenceThreshold: number;
  sessionCapacities: Record<string, number>;
  assignedCountBySession: Record<string, number>;
  allParticipantIds: string[];
  // Pairs of assignment ids whose sessions were found to overlap in time for
  // the same participant, plus the shared conference_day_id they overlap on
  // — computed by the orchestrator's defensive post-hoc query (spec step 8's
  // schedule_conflict definition, Data Model's details shape), passed in
  // here already-detected.
  scheduleConflictPairs?: ScheduleConflictPair[];
  // Per-constraint failure counts for a (applicationId, timeSlotGroupKey)
  // pair with zero eligible sessions, keyed `${applicationId}:${timeSlotGroupKey}`
  // — computed by the orchestrator from checkStaticHardConstraints(...).checks
  // across every candidate session in that slot (spec Data Model:
  // no_eligible_sessions.details.failed_constraints_summary). Optional:
  // omitted entries default to an empty summary.
  failedConstraintsSummary?: Record<string, Record<string, number>>;
}

// Derives all 5 allocation_issues types (spec: Allocation Algorithm step 8,
// Data Model's details-shape-per-type list) from a completed run's
// in-memory state. Pure — takes already-computed run state, does no DB I/O.
export function deriveIssues(input: IssueDerivationInput): DerivedIssue[] {
  const issues: DerivedIssue[] = [];
  const assignmentByApplicationAndSlot = new Map<string, AssignmentForIssues>();
  for (const a of input.assignments) {
    assignmentByApplicationAndSlot.set(`${a.applicationId}:${a.timeSlotGroupKey}`, a);
  }

  // unassigned / no_eligible_sessions: per participant per slot group.
  for (const group of input.timeSlotGroups) {
    for (const [applicationId, eligibleSessionIds] of Object.entries(group.eligibleSessionIdsByParticipant)) {
      const key = `${applicationId}:${group.timeSlotGroupKey}`;
      const hasAssignment = assignmentByApplicationAndSlot.has(key);
      if (hasAssignment) continue;

      if (eligibleSessionIds.length === 0) {
        const summary = input.failedConstraintsSummary?.[`${applicationId}:${group.timeSlotGroupKey}`] ?? {};
        issues.push({
          issueType: 'no_eligible_sessions',
          applicationId,
          sessionId: null,
          details: { time_slot_group_key: group.timeSlotGroupKey, failed_constraints_summary: summary },
        });
      } else {
        issues.push({
          issueType: 'unassigned',
          applicationId,
          sessionId: null,
          details: { time_slot_group_key: group.timeSlotGroupKey, eligible_session_ids: eligibleSessionIds, reason: 'capacity_exhausted' },
        });
      }
    }
  }

  // low_confidence: per assignment below threshold.
  for (const a of input.assignments) {
    if (a.suitabilityScore < input.lowConfidenceThreshold) {
      issues.push({
        issueType: 'low_confidence',
        applicationId: a.applicationId,
        sessionId: a.sessionId,
        details: { allocation_assignment_id: a.id, suitability_score: a.suitabilityScore, threshold: input.lowConfidenceThreshold },
      });
    }
  }

  // capacity_bottleneck: any session filled to capacity while eligible
  // participants remain unmatched to it.
  const eligibleCountBySession = new Map<string, number>();
  for (const group of input.timeSlotGroups) {
    for (const eligibleSessionIds of Object.values(group.eligibleSessionIdsByParticipant)) {
      for (const sessionId of eligibleSessionIds) {
        eligibleCountBySession.set(sessionId, (eligibleCountBySession.get(sessionId) ?? 0) + 1);
      }
    }
  }
  for (const [sessionId, capacity] of Object.entries(input.sessionCapacities)) {
    const assigned = input.assignedCountBySession[sessionId] ?? 0;
    const eligible = eligibleCountBySession.get(sessionId) ?? 0;
    if (assigned >= capacity && eligible > assigned) {
      issues.push({
        issueType: 'capacity_bottleneck',
        applicationId: null,
        sessionId,
        details: {
          session_id: sessionId,
          capacity,
          eligible_count: eligible,
          assigned_count: assigned,
          excluded_application_ids: [],
        },
      });
    }
  }

  // schedule_conflict: defensive, from precomputed overlap pairs.
  const assignmentById = new Map(input.assignments.map((a) => [a.id, a]));
  for (const pair of input.scheduleConflictPairs ?? []) {
    const [idA, idB] = pair.assignmentIds;
    const a = assignmentById.get(idA);
    const b = assignmentById.get(idB);
    if (!a || !b) continue;
    issues.push({
      issueType: 'schedule_conflict',
      applicationId: a.applicationId,
      sessionId: null,
      details: { application_id: a.applicationId, conflicting_assignment_ids: [idA, idB], conference_day_id: pair.conferenceDayId },
    });
  }

  return issues;
}
