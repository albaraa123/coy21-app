// src/lib/program-attendance/session-alternatives.ts
//
// Phase 9.3 — participant-facing, read-only "alternative sessions in the
// same time slot" for the schedule page. Implements getAlternativesForTimeslot
// exactly as specified in docs/superpowers/specs/2026-07-31-flexible-
// admission-qr-attendance-design.md's "Dynamic Alternatives (not
// persisted)" section — reusing existing logic/data wherever the spec
// says to, inventing nothing new:
//
//   - Candidate filter: sessions in the same time-slot group (via the
//     EXISTING groupSessionsIntoTimeSlots grouping — never a new grouping
//     algorithm), admission_policy in
//     ('open','cross_cutting','priority_then_open'), status='confirmed',
//     excluding the participant's own current session, not already ended.
//   - Per-candidate live availability: the EXISTING, UNMODIFIED
//     resolveAdmissionDecision pure function — same inputs
//     (sessionCounts via the same attendance_records counting shape as
//     scan-attempt.ts's loadSessionCounts/demand-capacity.ts's
//     computeDemandCapacityRows, isRecommended via the EXISTING
//     allocation_assignments status check) it already uses at scan time.
//   - Ranking: allocation_alternatives rows for this participant's own
//     allocation_assignment (found via THEIR OWN active
//     schedule_publications.allocation_run_id — see this file's own
//     header note below on why that's safe here, unlike the Phase 8.5
//     "which run is current" ambiguity) are used purely as a
//     display-priority hint, exactly as the spec requires — never
//     rewritten, never the sole source of eligible alternatives.
//
// Split into a pure computation core (computeAlternatives, directly
// unit-testable — no I/O) and an I/O wrapper (getAlternativesForTimeslotForCaller,
// live-tested), same separation this codebase uses throughout (see
// admission-lookup.ts, demand-capacity.ts).
//
// Nothing here writes anything, ever. No allocation engine, admission
// decision engine, QR/scanner, or attendance-transaction code is
// imported, called, or modified.
//
// Why "which allocation run" is NOT ambiguous here, unlike Phase 8.5's
// aborted "Recommended" metric: Phase 8.5 needed a run scoped across ALL
// participants with no natural anchor, which made "most recently
// confirmed" an unscoped, fragile global MAX(). Here the caller already
// knows exactly which application_id they're asking about, and
// schedule_publications_one_active is a unique index on (application_id)
// WHERE status='active' — i.e. exactly one active publication PER
// PARTICIPANT. Scoping to that participant's own allocation_run_id is
// therefore fully deterministic, not a global race.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { groupSessionsIntoTimeSlots, type SessionForGrouping } from '@/lib/allocation/time-slot-grouping';
import { resolveAdmissionDecision, type SessionForAdmission, type SessionCounts, type AdmissionResult } from '@/lib/attendance/resolve-admission-decision';

type ServiceClient = SupabaseClient<Database>;
type Caller = { userId: string; service: ServiceClient };

const ALTERNATIVE_ELIGIBLE_POLICIES = new Set(['open', 'cross_cutting', 'priority_then_open']);

export type SeatStatus = 'available' | 'almost_full' | 'full';

// "Almost full" threshold: 90% or more of capacity admitted, but not yet
// full. A simple, explainable ratio — not derived from any existing
// constant, since none of this codebase's existing capacity displays
// (demand-capacity.ts) needed a three-state bucket before this feature;
// chosen here specifically for the participant-facing UI's coarser,
// non-numeric status requirement.
export function computeSeatStatus(admittedTotal: number, capacity: number): SeatStatus {
  if (admittedTotal >= capacity) return 'full';
  if (capacity > 0 && admittedTotal / capacity >= 0.9) return 'almost_full';
  return 'available';
}

export type AlternativeSession = {
  sessionId: string;
  titleAr: string | null;
  titleEn: string | null;
  roomNameAr: string | null;
  roomNameEn: string | null;
  startTime: string;
  endTime: string;
  admissionPolicy: string;
  seatStatus: SeatStatus;
  remainingSeats: number;
  // The live availability preview for THIS participant, computed via the
  // unmodified resolveAdmissionDecision — never surfaced as raw internal
  // codes to the participant (the caller/UI layer maps this to
  // plain-language copy, per the spec's explicit terminology exclusion
  // list), but kept here so the UI can decide whether to show the
  // alternative as currently viable vs. informational-only.
  previewResult: AdmissionResult;
};

export type CandidateSessionInput = {
  id: string;
  titleAr: string | null;
  titleEn: string | null;
  roomNameAr: string | null;
  roomNameEn: string | null;
  startTime: string;
  endTime: string;
  status: string;
  admissionPolicy: string;
  capacity: number;
  prioritySeats: number | null;
  priorityReleaseAt: string | null;
  priorityReleaseMinutesBefore: number | null;
  lateEntryCutoffMinutes: number | null;
  flexibleEntryManualOverride: boolean | null;
  conferenceDayId: string;
  isMandatory: boolean;
};

/**
 * Pure computation, no I/O. Given every session on the same conference
 * day as `currentSessionId` plus the attendance/recommendation/ranking
 * data already fetched for them, returns the ordered list of valid
 * alternatives. All filtering/ordering rules live here so they're
 * directly unit-testable without a database.
 */
export function computeAlternatives(params: {
  daySessions: CandidateSessionInput[];
  currentSessionId: string;
  now: Date;
  sessionCountsBySessionId: Map<string, SessionCounts>;
  recommendedSessionIds: Set<string>;
  attendedSessionIdsInSlot: Set<string>;
  rankBySessionId: Map<string, number>;
}): AlternativeSession[] {
  const { daySessions, currentSessionId, now, sessionCountsBySessionId, recommendedSessionIds, attendedSessionIdsInSlot, rankBySessionId } = params;

  const forGrouping: SessionForGrouping[] = daySessions.map((s) => ({
    id: s.id,
    conferenceDayId: s.conferenceDayId,
    startTime: s.startTime,
    endTime: s.endTime,
    isMandatory: s.isMandatory,
  }));
  const groups = groupSessionsIntoTimeSlots(forGrouping);
  const group = groups.find((g) => g.sessionIds.includes(currentSessionId));
  if (!group) return [];

  const candidates = daySessions.filter(
    (s) =>
      group.sessionIds.includes(s.id) &&
      s.id !== currentSessionId &&
      s.status === 'confirmed' &&
      ALTERNATIVE_ELIGIBLE_POLICIES.has(s.admissionPolicy) &&
      // Past sessions excluded — an alternative that has already ended
      // is never useful to a participant looking at their live schedule.
      new Date(s.endTime) > now
  );

  const results: AlternativeSession[] = candidates.map((candidate) => {
    const sessionCounts = sessionCountsBySessionId.get(candidate.id) ?? { totalAdmitted: 0, admittedPriorityCount: 0, admittedFlexibleCount: 0 };
    const sessionForAdmission: SessionForAdmission = {
      status: candidate.status,
      admissionPolicy: candidate.admissionPolicy as SessionForAdmission['admissionPolicy'],
      capacity: candidate.capacity,
      prioritySeats: candidate.prioritySeats,
      priorityReleaseAt: candidate.priorityReleaseAt,
      priorityReleaseMinutesBefore: candidate.priorityReleaseMinutesBefore,
      lateEntryCutoffMinutes: candidate.lateEntryCutoffMinutes,
      flexibleEntryManualOverride: candidate.flexibleEntryManualOverride,
      startTime: candidate.startTime,
    };
    const decision = resolveAdmissionDecision({
      now,
      session: sessionForAdmission,
      isRecommended: recommendedSessionIds.has(candidate.id),
      hasActiveAttendanceForThisSession: attendedSessionIdsInSlot.has(candidate.id),
      hasActiveAttendanceForConflictingSession: attendedSessionIdsInSlot.size > 0 && !attendedSessionIdsInSlot.has(candidate.id),
      sessionCounts,
      isOverrideCaller: false,
    });

    return {
      sessionId: candidate.id,
      titleAr: candidate.titleAr,
      titleEn: candidate.titleEn,
      roomNameAr: candidate.roomNameAr,
      roomNameEn: candidate.roomNameEn,
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      admissionPolicy: candidate.admissionPolicy,
      seatStatus: computeSeatStatus(sessionCounts.totalAdmitted, candidate.capacity),
      remainingSeats: Math.max(0, candidate.capacity - sessionCounts.totalAdmitted),
      previewResult: decision.result,
    };
  });

  // Order: allocation_alternatives-ranked candidates first (ascending
  // rank = better fit), then every other eligible candidate by start
  // time — a stable, deterministic secondary order for candidates with
  // no stored rank (e.g. the participant's schedule predates any
  // allocation_alternatives rows, or none of theirs fell into this
  // slot). De-duplicated by sessionId as a defensive invariant (the
  // input is already unique per session id from a single sessions query,
  // but this keeps the guarantee explicit at the boundary of this pure
  // function).
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    if (seen.has(r.sessionId)) return false;
    seen.add(r.sessionId);
    return true;
  });

  deduped.sort((a, b) => {
    const rankA = rankBySessionId.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rankBySessionId.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });

  return deduped;
}

async function loadSessionCounts(service: ServiceClient, sessionId: string): Promise<SessionCounts> {
  const { data } = await service.from('attendance_records').select('entry_type').eq('session_id', sessionId).eq('status', 'admitted');
  const rows = data ?? [];
  return {
    totalAdmitted: rows.length,
    admittedPriorityCount: rows.filter((r) => r.entry_type === 'priority').length,
    admittedFlexibleCount: rows.filter((r) => r.entry_type === 'flexible').length,
  };
}

/**
 * Every valid alternative session for `applicationId` in the same time
 * slot as `currentSessionId`. Returns an empty array (never throws) if
 * the application doesn't belong to the caller, has no current session,
 * or genuinely has no eligible alternatives — all normal, displayable
 * "nothing to show" states, not errors.
 */
export async function getAlternativesForTimeslotForCaller(
  caller: Caller,
  applicationId: string,
  currentSessionId: string
): Promise<AlternativeSession[]> {
  const { service, userId } = caller;

  // Ownership check FIRST, before anything else touches this
  // applicationId — same pattern as getMyAttendanceForApplication
  // (participant-dashboard-queries.ts). A mismatched applicationId (this
  // participant asking about someone else's application) returns an
  // empty result, never another participant's data.
  const { data: application } = await service.from('applications').select('id').eq('id', applicationId).eq('applicant_id', userId).maybeSingle();
  if (!application) return [];

  const { data: currentSession } = await service.from('sessions').select('id, conference_day_id, status').eq('id', currentSessionId).maybeSingle();
  if (!currentSession || currentSession.status !== 'confirmed') return [];

  // Same time-slot grouping the scan flow itself uses — computed fresh
  // (live), not read from a stored column (sessions.time_slot_group_key
  // does not exist — see time-slot-lookup.ts's own header comment).
  const { data: daySessionRows } = await service
    .from('sessions')
    .select(
      'id, title_ar, title_en, start_time, end_time, status, admission_policy, capacity, priority_seats, priority_release_at, priority_release_minutes_before, late_entry_cutoff_minutes, flexible_entry_manual_override, conference_day_id, is_mandatory, rooms(name_ar, name_en)'
    )
    .eq('conference_day_id', currentSession.conference_day_id);

  const daySessions: CandidateSessionInput[] = (daySessionRows ?? []).map((s) => ({
    id: s.id,
    titleAr: s.title_ar,
    titleEn: s.title_en,
    roomNameAr: s.rooms?.name_ar ?? null,
    roomNameEn: s.rooms?.name_en ?? null,
    startTime: s.start_time,
    endTime: s.end_time,
    status: s.status,
    admissionPolicy: s.admission_policy,
    capacity: s.capacity,
    prioritySeats: s.priority_seats,
    priorityReleaseAt: s.priority_release_at,
    priorityReleaseMinutesBefore: s.priority_release_minutes_before,
    lateEntryCutoffMinutes: s.late_entry_cutoff_minutes,
    flexibleEntryManualOverride: s.flexible_entry_manual_override,
    conferenceDayId: s.conference_day_id,
    isMandatory: s.is_mandatory,
  }));

  // Compute the group once here (before the DB round-trips below) purely
  // to scope those round-trips to the actual candidate set — the pure
  // computeAlternatives() below re-derives the same group internally from
  // daySessions, so this is not duplicated business logic, just an
  // early exit / query-scoping optimization.
  const forGrouping: SessionForGrouping[] = daySessions.map((s) => ({ id: s.id, conferenceDayId: s.conferenceDayId, startTime: s.startTime, endTime: s.endTime, isMandatory: s.isMandatory }));
  const groups = groupSessionsIntoTimeSlots(forGrouping);
  const group = groups.find((g) => g.sessionIds.includes(currentSessionId));
  if (!group) return [];

  const now = new Date();
  const candidateIds = daySessions
    .filter((s) => group.sessionIds.includes(s.id) && s.id !== currentSessionId && s.status === 'confirmed' && ALTERNATIVE_ELIGIBLE_POLICIES.has(s.admissionPolicy) && new Date(s.endTime) > now)
    .map((s) => s.id);
  if (candidateIds.length === 0) return [];

  // Ranking hint: this participant's own allocation_alternatives rows,
  // found via THEIR OWN active schedule_publications.allocation_run_id
  // (deterministic per participant — see this file's own header comment)
  // and their own allocation_assignments row for the current session's
  // time-slot group. Used only to order candidates already deemed
  // eligible — never to add or remove a candidate.
  const rankBySessionId = new Map<string, number>();
  const { data: publication } = await service
    .from('schedule_publications')
    .select('allocation_run_id')
    .eq('application_id', applicationId)
    .eq('status', 'active')
    .maybeSingle();
  if (publication) {
    const { data: assignment } = await service
      .from('allocation_assignments')
      .select('id')
      .eq('allocation_run_id', publication.allocation_run_id)
      .eq('application_id', applicationId)
      .eq('time_slot_group_key', group.timeSlotGroupKey)
      .maybeSingle();
    if (assignment) {
      const { data: alternatives } = await service.from('allocation_alternatives').select('session_id, rank').eq('allocation_assignment_id', assignment.id).in('session_id', candidateIds);
      for (const alt of alternatives ?? []) {
        rankBySessionId.set(alt.session_id, alt.rank);
      }
    }
  }

  // isRecommended per spec: an allocation_assignments row exists for
  // (application_id, session_id) with status in ('proposed','confirmed').
  // Checked once for all candidates via a single .in() query rather than
  // one round-trip per candidate.
  const { data: recommendedRows } = await service
    .from('allocation_assignments')
    .select('session_id')
    .eq('application_id', applicationId)
    .in('session_id', candidateIds)
    .in('status', ['proposed', 'confirmed']);
  const recommendedSessionIds = new Set((recommendedRows ?? []).map((r) => r.session_id));

  const { data: thisSlotAttendance } = await service
    .from('attendance_records')
    .select('session_id')
    .eq('application_id', applicationId)
    .eq('status', 'admitted')
    .in('session_id', [...group.sessionIds]);
  const attendedSessionIdsInSlot = new Set((thisSlotAttendance ?? []).map((r) => r.session_id));

  const sessionCountsBySessionId = new Map<string, SessionCounts>();
  for (const id of candidateIds) {
    sessionCountsBySessionId.set(id, await loadSessionCounts(service, id));
  }

  return computeAlternatives({
    daySessions,
    currentSessionId,
    now,
    sessionCountsBySessionId,
    recommendedSessionIds,
    attendedSessionIdsInSlot,
    rankBySessionId,
  });
}
