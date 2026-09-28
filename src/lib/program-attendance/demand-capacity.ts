// src/lib/program-attendance/demand-capacity.ts
//
// Phase 8.5 — read-only demand/capacity computation for
// program_attendance_manager's dashboard. Split into a pure computation
// function (computeDemandCapacityRows, directly unit-testable) and a
// *ForCaller fetch function (fetchDemandCapacityForCaller, live-tested),
// same separation this codebase uses throughout (see admission-lookup.ts,
// scanner-assignment-management.ts).
//
// Metrics are strictly session-scoped and derived only from data that
// already exists — no new backend architecture, no global "which
// allocation run is current" concept:
//   - "Admitted" (with priority/flexible breakdown) reuses the exact same
//     attendance_records counting shape as scan-attempt.ts's
//     loadSessionCounts (status='admitted', grouped by entry_type).
//   - "Capacity"/"Remaining" reads sessions.capacity directly.
//
// An earlier version of this module also computed a "Recommended" count
// from allocation_assignments, scoped to either (a) the allocation_run_id
// behind "the active schedule_publications row" or (b) "the most recently
// confirmed allocation_runs row." Both were rejected during live testing:
// (a) is wrong because schedule_publications_one_active is a unique index
// on (application_id) WHERE status='active' — i.e. unique PER PARTICIPANT,
// not globally, so there is no single "the active publication." (b) is
// fragile because "most recently confirmed" is an unscoped global MAX()
// over a table any other confirmed run (a stale test fixture, or in
// production a staff member re-running allocation for an unrelated reason)
// can silently become "the winner" of. No allocation_assignments-derived
// metric is included in this dashboard as a result — see the Phase 8.5
// investigation notes for the full reasoning. This is a deliberate scope
// reduction, not an oversight.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;
type Caller = { userId: string; service: ServiceClient };

export type DemandCapacitySessionInput = {
  id: string;
  session_code: string;
  title_ar: string | null;
  title_en: string | null;
  capacity: number;
  min_capacity: number;
  priority_seats: number | null;
  admission_policy: string;
};

export type DemandCapacityAttendanceRow = { session_id: string; entry_type: string };

export type DemandCapacityRow = {
  sessionId: string;
  code: string;
  title: string | null;
  capacity: number;
  minCapacity: number;
  prioritySeats: number | null;
  admissionPolicy: string;
  admittedTotal: number;
  admittedPriority: number;
  admittedFlexible: number;
  remaining: number;
  atOrOverCapacity: boolean;
};

/**
 * Pure computation, no I/O — every metric is derived only from the rows
 * passed in. `locale` selects which title field to surface; callers of
 * this function are responsible for scoping `attendanceRows` to the
 * sessions they care about (the *ForCaller fetch function below does
 * this).
 */
export function computeDemandCapacityRows(sessions: DemandCapacitySessionInput[], attendanceRows: DemandCapacityAttendanceRow[], locale: string): DemandCapacityRow[] {
  const admittedBySession = new Map<string, { total: number; priority: number; flexible: number }>();
  for (const row of attendanceRows) {
    const entry = admittedBySession.get(row.session_id) ?? { total: 0, priority: 0, flexible: 0 };
    entry.total += 1;
    if (row.entry_type === 'priority') entry.priority += 1;
    if (row.entry_type === 'flexible') entry.flexible += 1;
    admittedBySession.set(row.session_id, entry);
  }

  return sessions.map((s) => {
    const admitted = admittedBySession.get(s.id) ?? { total: 0, priority: 0, flexible: 0 };
    return {
      sessionId: s.id,
      code: s.session_code,
      title: locale === 'ar' ? s.title_ar : s.title_en,
      capacity: s.capacity,
      minCapacity: s.min_capacity,
      prioritySeats: s.priority_seats,
      admissionPolicy: s.admission_policy,
      admittedTotal: admitted.total,
      admittedPriority: admitted.priority,
      admittedFlexible: admitted.flexible,
      remaining: Math.max(0, s.capacity - admitted.total),
      atOrOverCapacity: admitted.total >= s.capacity,
    };
  });
}

/**
 * Fetches every input computeDemandCapacityRows needs, scoped to
 * status='confirmed' sessions only (matches every other admission/scan
 * surface in this codebase, which only ever operates on confirmed
 * sessions), and computes the result. Read-only: no writes anywhere in
 * this function.
 */
export async function fetchDemandCapacityForCaller(caller: Caller, locale: string): Promise<DemandCapacityRow[]> {
  const { service } = caller;

  const { data: sessions } = await service
    .from('sessions')
    .select('id, session_code, title_ar, title_en, capacity, min_capacity, priority_seats, admission_policy')
    .eq('status', 'confirmed')
    .order('session_code', { ascending: true });
  const sessionRows = sessions ?? [];
  const sessionIds = sessionRows.map((s) => s.id);

  const { data: attendanceRows } =
    sessionIds.length > 0
      ? await service.from('attendance_records').select('session_id, entry_type').eq('status', 'admitted').in('session_id', sessionIds)
      : { data: [] };

  return computeDemandCapacityRows(sessionRows, attendanceRows ?? [], locale);
}
