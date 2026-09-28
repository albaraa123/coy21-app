// src/lib/allocation/run-allocation.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/types/database';
import { checkStaticHardConstraints, type ParticipantForConstraints, type SessionForConstraints, type ConstraintCheck } from './hard-constraints';
import { cosineSimilarity } from './scoring';
import { groupSessionsIntoTimeSlots, type SessionForGrouping } from './time-slot-grouping';
import { runDeferredAcceptance, type ParticipantPreferences, type SessionCapacity } from './deferred-acceptance';
import { deriveIssues, type AssignmentForIssues, type TimeSlotGroupForIssues } from './issues';
import { derivePriorityPoolIssues } from './priority-pool-validation';
import { ALTERNATIVES_COUNT, LOW_CONFIDENCE_THRESHOLD } from '@/lib/validation/allocation';
import { fetchAllRowsPaginated } from './paginated-fetch';

type ServiceClient = SupabaseClient<Database>;

type SessionRow = Pick<
  Database['public']['Tables']['sessions']['Row'],
  | 'id'
  | 'conference_day_id'
  | 'start_time'
  | 'end_time'
  | 'status'
  | 'include_in_allocation'
  | 'language'
  | 'difficulty_level'
  | 'is_mandatory'
  | 'capacity'
  | 'priority_seats'
>;

type ScoredPair = { applicationId: string; sessionId: string; score: number; isLowConfidence: boolean };

interface PendingAssignment {
  applicationId: string;
  sessionId: string;
  timeSlotGroupKey: string;
  suitabilityScore: number;
  isLowConfidence: boolean;
  isMandatoryAssignment: boolean;
  eligibleSessionIds: string[]; // for alternatives
  scoresBySession: Record<string, number>; // for alternatives
}

export async function runAllocation(service: ServiceClient, runBy: string, featureExtractionRunId: string): Promise<{ id: string }> {
  // --- Step 1: gather snapshots (extraction already ran; this run reuses it) ---
  const { data: snapshotRows, error: snapshotErr } = await service
    .from('participant_feature_snapshots')
    .select('application_id, tag_id, weight')
    .eq('feature_extraction_run_id', featureExtractionRunId);
  if (snapshotErr) throw new Error(`Failed to load feature snapshots: ${snapshotErr.message}`);

  const participantVectors = new Map<string, Record<string, number>>();
  for (const row of snapshotRows ?? []) {
    if (!participantVectors.has(row.application_id)) participantVectors.set(row.application_id, {});
    participantVectors.get(row.application_id)![row.tag_id] = row.weight;
  }

  // Ordered by id: Postgres gives no row-order guarantee without an explicit
  // ORDER BY, and this order feeds tie-breaking in the deferred-acceptance
  // pass and which mandatory session is processed first when two overlap —
  // both of which are stored output. Without a deterministic order here, the
  // "identical params -> identical output" reproducibility guarantee is only
  // incidental (relies on Postgres's typical-but-unguaranteed physical
  // return order), not real. Flagged by whole-branch code review.
  //
  // Keyset-paginated (see paginated-fetch.ts): PostgREST caps an
  // unpaginated select() at a server-configured max (1000 rows on this
  // project) — beyond that, accepted applications were being silently
  // omitted from allocation with no error, so the run's correctness
  // depended on total participant count (Phase 7G-K finding). The same
  // `id asc` order used for tie-break determinism above also serves as the
  // keyset cursor, which — unlike offset/range pagination — is stable
  // against concurrent admission-review/import writes racing this scan
  // (confirmed reproducible with offset pagination against the live
  // disposable project; keyset pagination closes that specific hazard,
  // though it remains a live multi-request read, not an atomic snapshot —
  // accepted by design for the current allocation workflow).
  const applications = await fetchAllRowsPaginated((lastSeenId, pageSize) => {
    let query = service
      .from('applications')
      .select('id, preferred_language, experience_level')
      .eq('status', 'accepted')
      .order('id', { ascending: true })
      .limit(pageSize);
    if (lastSeenId !== null) query = query.gt('id', lastSeenId);
    return query;
  });
  const participantIds = applications.map((a) => a.id);
  const participantMeta = new Map(applications.map((a) => [a.id, a]));

  // --- sessions + session tag vectors ---
  // Keyset-paginated for the same reason as applications above — confirmed
  // sessions are well under 1000 on this project today, but nothing in the
  // schema bounds that, and an unpaginated read here would fail silently
  // in the identical way if it ever grew past the page cap.
  const sessionRows = await fetchAllRowsPaginated((lastSeenId, pageSize) => {
    let query = service
      .from('sessions')
      .select(
        'id, conference_day_id, start_time, end_time, status, include_in_allocation, language, difficulty_level, is_mandatory, capacity, priority_seats'
      )
      .eq('status', 'confirmed')
      .eq('include_in_allocation', true)
      .order('id', { ascending: true })
      .limit(pageSize);
    if (lastSeenId !== null) query = query.gt('id', lastSeenId);
    return query;
  });

  const { data: sessionTagRows, error: sessionTagsErr } = await service.from('session_tags').select('session_id, tag_id, weight');
  if (sessionTagsErr) throw new Error(`Failed to load session tags: ${sessionTagsErr.message}`);
  const sessionVectors = new Map<string, Record<string, number>>();
  for (const row of sessionTagRows ?? []) {
    if (!sessionVectors.has(row.session_id)) sessionVectors.set(row.session_id, {});
    sessionVectors.get(row.session_id)![row.tag_id] = row.weight;
  }

  // --- Step 2: time-slot grouping (includes mandatory sessions) ---
  const groupingInput: SessionForGrouping[] = (sessionRows ?? []).map((s) => ({
    id: s.id,
    conferenceDayId: s.conference_day_id,
    startTime: s.start_time,
    endTime: s.end_time,
    isMandatory: s.is_mandatory,
  }));
  const timeSlotGroups = groupSessionsIntoTimeSlots(groupingInput);
  const slotKeyBySessionId = new Map<string, string>();
  for (const group of timeSlotGroups) for (const sessionId of group.sessionIds) slotKeyBySessionId.set(sessionId, group.timeSlotGroupKey);

  // --- Step 3: score precomputation for every hard-eligible (participant, session) pair ---
  const mandatorySessions = (sessionRows ?? []).filter((s) => s.is_mandatory);
  const electiveSessions = (sessionRows ?? []).filter((s) => !s.is_mandatory);

  const scoresByApplication = new Map<string, ScoredPair[]>(); // per application, all hard-eligible sessions with scores

  // Every (participant, session) constraint check computed while scoring is
  // cached here, keyed by `${applicationId}:${sessionId}`, so Step 7's
  // failed_constraints_summary and Step 8's explanations (below) reuse the
  // same result instead of re-running checkStaticHardConstraints for pairs
  // that were already checked here — this loop already covers every
  // (participant, session) pair in the run, eligible or not.
  const constraintChecksByPair = new Map<string, ConstraintCheck[]>();

  for (const applicationId of participantIds) {
    const meta = participantMeta.get(applicationId)!;
    const participant: ParticipantForConstraints = {
      applicationId,
      preferredLanguage: meta.preferred_language,
      experienceLevel: meta.experience_level,
    };
    const pairs: ScoredPair[] = [];
    for (const s of sessionRows ?? []) {
      const sessionForConstraints: SessionForConstraints = {
        id: s.id,
        status: s.status,
        includeInAllocation: s.include_in_allocation,
        language: s.language,
        difficultyLevel: s.difficulty_level,
        isMandatory: s.is_mandatory,
      };
      const constraintResult = checkStaticHardConstraints(participant, sessionForConstraints);
      constraintChecksByPair.set(`${applicationId}:${s.id}`, constraintResult.checks);
      if (!constraintResult.eligible) continue;

      const participantVector = participantVectors.get(applicationId) ?? {};
      const sessionVector = sessionVectors.get(s.id) ?? {};
      const { score } = cosineSimilarity(participantVector, sessionVector);
      pairs.push({ applicationId, sessionId: s.id, score, isLowConfidence: score < LOW_CONFIDENCE_THRESHOLD });
    }
    scoresByApplication.set(applicationId, pairs);
  }

  const pending: PendingAssignment[] = [];
  const filledSlotByApplication = new Set<string>(); // `${applicationId}:${timeSlotGroupKey}`

  // --- Step 4: mandatory pass ---
  for (const session of mandatorySessions) {
    const slotKey = slotKeyBySessionId.get(session.id)!;
    // A participant already filled for this slot group by an earlier
    // mandatory session in the same connected component (two overlapping
    // mandatory sessions) is not eligible here — a participant is matched
    // at most once per slot-group, same invariant the elective pass
    // enforces below. Without this filter, such a participant could be
    // pushed into `pending` twice for the same (application, slot) pair,
    // violating allocation_assignments_unique and failing the whole run's
    // insert instead of surfacing a capacity_bottleneck/unassigned issue.
    const eligible = participantIds
      .filter((id) => !filledSlotByApplication.has(`${id}:${slotKey}`))
      .map((id) => ({ id, pair: (scoresByApplication.get(id) ?? []).find((p) => p.sessionId === session.id) }))
      .filter((x): x is { id: string; pair: ScoredPair } => x.pair !== undefined)
      .sort((a, b) => b.pair.score - a.pair.score);

    const capacity = session.capacity;
    const winners = eligible.slice(0, capacity);

    for (const w of winners) {
      pending.push({
        applicationId: w.id,
        sessionId: session.id,
        timeSlotGroupKey: slotKey,
        suitabilityScore: w.pair.score,
        isLowConfidence: w.pair.isLowConfidence,
        isMandatoryAssignment: true,
        eligibleSessionIds: [session.id],
        scoresBySession: { [session.id]: w.pair.score },
      });
      filledSlotByApplication.add(`${w.id}:${slotKey}`);
    }
  }

  // --- Step 5: elective pass, per remaining time-slot group ---
  const electiveSlotKeys = new Set(electiveSessions.map((s) => slotKeyBySessionId.get(s.id)!));
  for (const slotKey of electiveSlotKeys) {
    const sessionsInGroup = electiveSessions.filter((s) => slotKeyBySessionId.get(s.id) === slotKey);
    const sessionIdsInGroup = new Set(sessionsInGroup.map((s) => s.id));

    const preferences: ParticipantPreferences[] = [];
    for (const applicationId of participantIds) {
      if (filledSlotByApplication.has(`${applicationId}:${slotKey}`)) continue;
      const pairsInGroup = (scoresByApplication.get(applicationId) ?? [])
        .filter((p) => sessionIdsInGroup.has(p.sessionId))
        .sort((a, b) => b.score - a.score);
      if (pairsInGroup.length === 0) continue;
      preferences.push({
        applicationId,
        rankedSessionIds: pairsInGroup.map((p) => p.sessionId),
        scores: Object.fromEntries(pairsInGroup.map((p) => [p.sessionId, p.score])),
      });
    }

    const capacities: SessionCapacity[] = sessionsInGroup.map((s) => ({ sessionId: s.id, capacity: s.capacity }));
    const result = runDeferredAcceptance(preferences, capacities);

    for (const a of result.assignments) {
      const scorePairs = (scoresByApplication.get(a.applicationId) ?? []).filter((p) => sessionIdsInGroup.has(p.sessionId));
      pending.push({
        applicationId: a.applicationId,
        sessionId: a.sessionId,
        timeSlotGroupKey: slotKey,
        suitabilityScore: a.score,
        isLowConfidence: a.score < LOW_CONFIDENCE_THRESHOLD,
        isMandatoryAssignment: false,
        eligibleSessionIds: scorePairs.map((p) => p.sessionId),
        scoresBySession: Object.fromEntries(scorePairs.map((p) => [p.sessionId, p.score])),
      });
    }
  }

  // --- persist the run ---
  const { data: run, error: runErr } = await service
    .from('allocation_runs')
    .insert({ feature_extraction_run_id: featureExtractionRunId, status: 'draft', run_by: runBy })
    .select('id')
    .single();
  if (runErr || !run) throw new Error(`Failed to create allocation_runs row: ${runErr?.message}`);

  // Everything below writes rows that reference allocation_runs.id with
  // `on delete cascade` (allocation_assignments -> alternatives/explanations,
  // allocation_issues). The Supabase JS client has no cross-table transaction,
  // so if any insert below fails partway through, we delete the run row here
  // to cascade-clean every dependent row instead of leaving a partial run
  // (assignments with no alternatives/explanations/issues) for callers to
  // trip over.
  try {
    return await persistAllocationResults(service, run.id, runBy, {
      pending,
      participantIds,
      participantMeta,
      sessionRows: sessionRows ?? [],
      timeSlotGroups,
      scoresByApplication,
      constraintChecksByPair,
    });
  } catch (err) {
    const { error: cleanupErr } = await service.from('allocation_runs').delete().eq('id', run.id);
    if (cleanupErr) {
      throw new Error(
        `Allocation run ${run.id} failed and could not be cleaned up (manual deletion required): ${cleanupErr.message}. Original error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    throw err;
  }
}

async function persistAllocationResults(
  service: ServiceClient,
  runId: string,
  runBy: string,
  ctx: {
    pending: PendingAssignment[];
    participantIds: string[];
    participantMeta: Map<string, { id: string; preferred_language: string | null; experience_level: string | null }>;
    sessionRows: SessionRow[];
    timeSlotGroups: ReturnType<typeof groupSessionsIntoTimeSlots>;
    scoresByApplication: Map<string, ScoredPair[]>;
    constraintChecksByPair: Map<string, ConstraintCheck[]>;
  }
): Promise<{ id: string }> {
  const { pending, participantIds, participantMeta, sessionRows, timeSlotGroups, scoresByApplication, constraintChecksByPair } = ctx;
  const run = { id: runId };
  const sessionsById = new Map(sessionRows.map((s) => [s.id, s]));
  // allocation_assignments_unique is (allocation_run_id, application_id,
  // time_slot_group_key), so that pair's applicationId+sessionId+
  // timeSlotGroupKey combination is exactly the pending row's natural key.
  const pendingByKey = new Map(pending.map((p) => [`${p.applicationId}:${p.sessionId}:${p.timeSlotGroupKey}`, p]));

  const assignmentRows = pending.map((p) => ({
    allocation_run_id: run.id,
    application_id: p.applicationId,
    session_id: p.sessionId,
    time_slot_group_key: p.timeSlotGroupKey,
    suitability_score: p.suitabilityScore,
    is_low_confidence: p.isLowConfidence,
    is_mandatory_assignment: p.isMandatoryAssignment,
    updated_by: runBy,
  }));

  const insertedAssignments: { id: string; application_id: string; session_id: string; time_slot_group_key: string }[] = [];
  if (assignmentRows.length > 0) {
    const { data: inserted, error: insertErr } = await service
      .from('allocation_assignments')
      .insert(assignmentRows)
      .select('id, application_id, session_id, time_slot_group_key');
    if (insertErr) throw new Error(`Failed to write allocation assignments: ${insertErr.message}`);
    insertedAssignments.push(...(inserted ?? []));
  }

  // --- Step 6: alternatives (top-N excluding the winner) ---
  const alternativeRows: { allocation_assignment_id: string; session_id: string; suitability_score: number; rank: number }[] = [];
  for (const inserted of insertedAssignments) {
    const p = pendingByKey.get(`${inserted.application_id}:${inserted.session_id}:${inserted.time_slot_group_key}`);
    if (!p) continue;
    const alternatives = Object.entries(p.scoresBySession)
      .filter(([sessionId]) => sessionId !== p.sessionId)
      .sort((a, b) => b[1] - a[1])
      .slice(0, ALTERNATIVES_COUNT);
    alternatives.forEach(([sessionId, score], index) => {
      alternativeRows.push({ allocation_assignment_id: inserted.id, session_id: sessionId, suitability_score: score, rank: index + 1 });
    });
  }
  if (alternativeRows.length > 0) {
    const { error: altErr } = await service.from('allocation_alternatives').insert(alternativeRows);
    if (altErr) throw new Error(`Failed to write alternatives: ${altErr.message}`);
  }

  // --- Step 8: explanations ---
  const explanationRows: { allocation_assignment_id: string; constraint_type: string; passed: boolean; detail: string }[] = [];
  for (const inserted of insertedAssignments) {
    // Reuses the check already computed for this exact (participant, session)
    // pair during Step 3's scoring pass instead of re-running
    // checkStaticHardConstraints — every pair scored there is cached in
    // constraintChecksByPair, and an inserted assignment's pair was
    // necessarily scored (it's how it became eligible for assignment).
    const checks = constraintChecksByPair.get(`${inserted.application_id}:${inserted.session_id}`)!;
    for (const check of checks) {
      explanationRows.push({ allocation_assignment_id: inserted.id, constraint_type: check.constraintType, passed: check.passed, detail: check.detail });
    }
    const p = pendingByKey.get(`${inserted.application_id}:${inserted.session_id}:${inserted.time_slot_group_key}`);
    explanationRows.push({
      allocation_assignment_id: inserted.id,
      constraint_type: 'tag_similarity',
      passed: true,
      detail: `Cosine similarity score: ${p?.suitabilityScore.toFixed(3) ?? '0.000'}`,
    });
  }
  if (explanationRows.length > 0) {
    const { error: explErr } = await service.from('allocation_assignment_explanations').insert(explanationRows);
    if (explErr) throw new Error(`Failed to write explanations: ${explErr.message}`);
  }

  // --- Step 7 (part 1): unassigned / no_eligible_sessions / capacity_bottleneck via deriveIssues ---
  const timeSlotGroupsForIssues: TimeSlotGroupForIssues[] = timeSlotGroups.map((g) => {
    const eligibleSessionIdsByParticipant: Record<string, string[]> = {};
    for (const applicationId of participantIds) {
      const pairsInGroup = (scoresByApplication.get(applicationId) ?? []).filter((p) => g.sessionIds.includes(p.sessionId));
      eligibleSessionIdsByParticipant[applicationId] = pairsInGroup.map((p) => p.sessionId);
    }
    return { timeSlotGroupKey: g.timeSlotGroupKey, eligibleSessionIdsByParticipant };
  });

  // Per-constraint failure counts for every (participant, slot) pair with
  // zero eligible sessions, feeding no_eligible_sessions.details.failed_constraints_summary
  // (spec Data Model). Only computed for pairs that actually have zero
  // eligible sessions. Reuses constraintChecksByPair (built during Step 3's
  // scoring pass, which already ran checkStaticHardConstraints for every
  // (participant, session) pair) instead of re-running it here.
  const failedConstraintsSummary: Record<string, Record<string, number>> = {};
  for (const g of timeSlotGroups) {
    for (const applicationId of participantIds) {
      const eligibleInGroup = eligibleSessionIdsByParticipantForKey(timeSlotGroupsForIssues, g.timeSlotGroupKey, applicationId);
      if (eligibleInGroup.length > 0) continue;
      const summary: Record<string, number> = {};
      for (const sessionId of g.sessionIds) {
        const session = sessionsById.get(sessionId);
        if (!session || session.is_mandatory) continue;
        const checks = constraintChecksByPair.get(`${applicationId}:${sessionId}`) ?? [];
        for (const check of checks) {
          if (!check.passed) summary[check.constraintType] = (summary[check.constraintType] ?? 0) + 1;
        }
      }
      failedConstraintsSummary[`${applicationId}:${g.timeSlotGroupKey}`] = summary;
    }
  }

  function eligibleSessionIdsByParticipantForKey(groups: TimeSlotGroupForIssues[], key: string, applicationId: string): string[] {
    return groups.find((x) => x.timeSlotGroupKey === key)?.eligibleSessionIdsByParticipant[applicationId] ?? [];
  }

  const assignmentsForIssues: AssignmentForIssues[] = insertedAssignments.map((a) => {
    const p = pendingByKey.get(`${a.application_id}:${a.session_id}:${a.time_slot_group_key}`)!;
    return { id: a.id, applicationId: a.application_id, sessionId: a.session_id, timeSlotGroupKey: a.time_slot_group_key, suitabilityScore: p.suitabilityScore };
  });

  const sessionCapacities: Record<string, number> = Object.fromEntries(sessionRows.map((s) => [s.id, s.capacity]));
  const assignedCountBySession: Record<string, number> = {};
  for (const a of insertedAssignments) assignedCountBySession[a.session_id] = (assignedCountBySession[a.session_id] ?? 0) + 1;

  // --- Step 7 (part 2): schedule_conflict defensive post-hoc check ---
  const assignmentsByParticipant = new Map<string, typeof insertedAssignments>();
  for (const a of insertedAssignments) {
    if (!assignmentsByParticipant.has(a.application_id)) assignmentsByParticipant.set(a.application_id, []);
    assignmentsByParticipant.get(a.application_id)!.push(a);
  }
  const scheduleConflictPairs: { assignmentIds: [string, string]; conferenceDayId: string }[] = [];
  for (const [, assignmentsForParticipant] of assignmentsByParticipant) {
    if (assignmentsForParticipant.length < 2) continue;
    const withTimes = assignmentsForParticipant.map((a) => ({ ...a, session: sessionsById.get(a.session_id)! }));
    for (let i = 0; i < withTimes.length; i++) {
      for (let j = i + 1; j < withTimes.length; j++) {
        const a = withTimes[i];
        const b = withTimes[j];
        if (a.session.conference_day_id !== b.session.conference_day_id) continue;
        const overlap = new Date(a.session.start_time) < new Date(b.session.end_time) && new Date(b.session.start_time) < new Date(a.session.end_time);
        if (overlap) scheduleConflictPairs.push({ assignmentIds: [a.id, b.id], conferenceDayId: a.session.conference_day_id });
      }
    }
  }

  const issues = deriveIssues({
    timeSlotGroups: timeSlotGroupsForIssues,
    assignments: assignmentsForIssues,
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
    sessionCapacities,
    assignedCountBySession,
    allParticipantIds: participantIds,
    scheduleConflictPairs,
    failedConstraintsSummary,
  });

  if (issues.length > 0) {
    const { error: issuesErr } = await service.from('allocation_issues').insert(
      issues.map((i) => ({
        allocation_run_id: run.id,
        issue_type: i.issueType,
        application_id: i.applicationId,
        session_id: i.sessionId,
        // `details` is a Record<string, unknown> from deriveIssues, but the
        // generated Insert type for this jsonb column is `Json | null`, which
        // plain object literals aren't structurally assignable to. Cast,
        // matching the `centroid: cluster.centroid as Json` pattern in
        // run-clustering.ts — the value is always JSON-serializable at runtime.
        details: i.details as Json,
      }))
    );
    if (issuesErr) throw new Error(`Failed to write allocation issues: ${issuesErr.message}`);
  }

  // Second, independent issue-derivation pass — see design spec's
  // "Recommendation-to-Priority-Pool Validation" section. Deliberately not
  // merged into deriveIssues' input/output shape above. Reuses sessionRows
  // (already fetched above) rather than re-querying sessions by id set.
  const recommendedCountBySession: Record<string, number> = {};
  for (const a of assignmentsForIssues) {
    recommendedCountBySession[a.sessionId] = (recommendedCountBySession[a.sessionId] ?? 0) + 1;
  }
  const prioritySeatsBySession: Record<string, number | null> = Object.fromEntries(
    (sessionRows ?? []).map((s) => [s.id, s.priority_seats])
  );

  const priorityPoolIssues = derivePriorityPoolIssues({ recommendedCountBySession, prioritySeatsBySession, capacityBySession: sessionCapacities });
  if (priorityPoolIssues.length > 0) {
    const { error: priorityIssuesErr } = await service.from('allocation_issues').insert(
      priorityPoolIssues.map((i) => ({
        allocation_run_id: run.id,
        issue_type: i.issueType,
        application_id: i.applicationId,
        session_id: i.sessionId,
        details: i.details as Json,
      }))
    );
    if (priorityIssuesErr) throw new Error(`Failed to write priority-pool issues: ${priorityIssuesErr.message}`);
  }

  return { id: run.id };
}
