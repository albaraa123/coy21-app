// src/lib/allocation/deferred-acceptance.ts
export interface ParticipantPreferences {
  applicationId: string;
  rankedSessionIds: string[]; // caller passes these pre-sorted by score descending
  scores: Record<string, number>;
}

export interface SessionCapacity {
  sessionId: string;
  capacity: number;
}

export interface DeferredAcceptanceAssignment {
  applicationId: string;
  sessionId: string;
  score: number;
}

export interface DeferredAcceptanceResult {
  assignments: DeferredAcceptanceAssignment[];
  unmatched: string[];
}

// Gale-Shapley-style deferred acceptance: participants propose to their
// highest-scored remaining eligible session; sessions hold the top-`capacity`
// proposals by score, bumping the lowest scorer when a higher-scoring
// proposal arrives. Repeats until every participant is matched or has
// exhausted their ranked list (spec: Allocation Algorithm step 5).
export function runDeferredAcceptance(
  participants: ParticipantPreferences[],
  sessions: SessionCapacity[]
): DeferredAcceptanceResult {
  const capacityBySession = new Map(sessions.map((s) => [s.sessionId, s.capacity]));
  const nextProposalIndex = new Map(participants.map((p) => [p.applicationId, 0]));
  const holds = new Map<string, DeferredAcceptanceAssignment[]>(); // sessionId -> held proposals, sorted desc by score

  let freeParticipants = participants.map((p) => p.applicationId);
  const participantById = new Map(participants.map((p) => [p.applicationId, p]));

  while (freeParticipants.length > 0) {
    const stillFree: string[] = [];

    for (const applicationId of freeParticipants) {
      const participant = participantById.get(applicationId)!;
      const idx = nextProposalIndex.get(applicationId)!;

      if (idx >= participant.rankedSessionIds.length) {
        continue; // exhausted eligible set, permanently unmatched
      }

      const sessionId = participant.rankedSessionIds[idx];
      nextProposalIndex.set(applicationId, idx + 1);

      const capacity = capacityBySession.get(sessionId) ?? 0;
      const held = holds.get(sessionId) ?? [];
      const proposal: DeferredAcceptanceAssignment = { applicationId, sessionId, score: participant.scores[sessionId] ?? 0 };

      const combined = [...held, proposal].sort((a, b) => b.score - a.score);

      if (combined.length <= capacity) {
        holds.set(sessionId, combined);
      } else {
        const kept = combined.slice(0, capacity);
        const bumped = combined.slice(capacity);
        holds.set(sessionId, kept);
        // A bumped participant becomes free again to re-propose next round.
        for (const b of bumped) {
          if (!kept.some((k) => k.applicationId === b.applicationId)) {
            stillFree.push(b.applicationId);
          }
        }
      }
    }

    freeParticipants = stillFree.filter((id) => nextProposalIndex.get(id)! < participantById.get(id)!.rankedSessionIds.length);
  }

  const assignments = Array.from(holds.values()).flat();
  const matchedIds = new Set(assignments.map((a) => a.applicationId));
  const unmatched = participants.map((p) => p.applicationId).filter((id) => !matchedIds.has(id));

  return { assignments, unmatched };
}
