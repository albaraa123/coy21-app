// src/lib/allocation/priority-pool-validation.ts
//
// Sibling to src/lib/allocation/issues.ts's deriveIssues — a separate pure
// function, not a modification of deriveIssues, since it needs
// priority_seats data that deriveIssues' existing input shape doesn't
// carry. Report-only: never blocks run confirmation (design spec's
// "Recommendation-to-Priority-Pool Validation" section).
export interface PriorityPoolIssue {
  issueType: 'priority_pool_exceeded';
  sessionId: string;
  applicationId: null;
  details: Record<string, unknown>;
}

export interface PriorityPoolValidationInput {
  recommendedCountBySession: Record<string, number>;
  prioritySeatsBySession: Record<string, number | null>;
  capacityBySession: Record<string, number>;
}

export function derivePriorityPoolIssues(input: PriorityPoolValidationInput): PriorityPoolIssue[] {
  const issues: PriorityPoolIssue[] = [];
  for (const [sessionId, recommendedCount] of Object.entries(input.recommendedCountBySession)) {
    const prioritySeats = input.prioritySeatsBySession[sessionId];
    const capacity = input.capacityBySession[sessionId];
    // A session without an explicit priority pool has no priority-specific
    // ceiling to exceed — only the hard capacity limit applies.
    const effectivePool = prioritySeats ?? capacity;
    if (recommendedCount > effectivePool) {
      issues.push({
        issueType: 'priority_pool_exceeded',
        sessionId,
        applicationId: null,
        details: { recommended_count: recommendedCount, priority_seats: prioritySeats, capacity, session_id: sessionId },
      });
    }
  }
  return issues;
}
