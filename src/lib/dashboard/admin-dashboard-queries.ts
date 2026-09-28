// src/lib/dashboard/admin-dashboard-queries.ts
//
// Typed, server-only query layer for the STAFF admin dashboard (Task 11
// consumes these; this task builds them in isolation with their own live
// tests). Every function takes the `{ userId, service }` caller object —
// the same established pattern as requireAgendaStaffCaller()
// (src/lib/agenda/server-helpers.ts) — and re-verifies staff authorization
// INTERNALLY as defense in depth: a caller must never be able to skip this
// re-check by constructing the caller object some other way, because the
// service-role client bypasses RLS entirely, so this in-function role
// check — not RLS — is the actual authorization gate here, exactly as
// documented in server-helpers.ts's own doc comment for the same pattern.
//
// STAFF CHECK: uses isStaffRole/STAFF_ROLES from
// src/lib/auth/post-login-destination.ts — the CURRENT, broadened check
// covering all 4 non-participant roles (super_admin,
// registration_admission_manager, agenda_allocation_manager,
// communications_attendance_manager), established as the correct check by
// Task 7's code-review fix to decideAdminAccess (src/lib/shell/
// admin-access.ts). Deliberately NOT isAgendaStaffRole (src/lib/validation/
// agenda.ts), which only covers 2 of the 4 roles and would incorrectly
// return 'unauthorized' for a genuine registration_admission_manager or
// communications_attendance_manager viewing their own dashboard.
//
// PRIVACY: getRecentImportBatches and getPendingInvitationsSummary are
// explicitly documented at each call site as never selecting sensitive
// columns (raw application_answers content, imported_email) — this is the
// most privacy-sensitive task in the whole plan; every select() below is
// an intentional, minimal column list, not `select('*')`.
import { createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/post-login-destination';
import type { CardResult } from './dashboard-types';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export type DashboardStaffCaller = { userId: string; service: ServiceClient };

/**
 * Re-verifies the caller's own profiles.role is a current staff role,
 * independently of whatever the caller object claims. Every exported query
 * below calls this first and returns `{ kind: 'unauthorized' }` immediately
 * if it fails — mirrors requireAgendaStaffCaller()'s fail-closed posture
 * (missing profile row / non-staff role -> not authorized), but returns a
 * CardResult instead of throwing, since these are read-only dashboard
 * queries that should degrade a single card, not crash the whole page.
 */
async function verifyStaffCaller(caller: DashboardStaffCaller): Promise<boolean> {
  const { data: profile, error } = await caller.service.from('profiles').select('role').eq('id', caller.userId).maybeSingle();
  if (error || !profile) return false;
  return isStaffRole(profile.role);
}

export type ImportBatchSummary = {
  id: string;
  filename: string;
  status: string;
  uploadedAt: string;
  rowCount: number | null;
  warningCount: number;
  errorCount: number;
};

/**
 * Last 5 import_batches rows, newest first. Column list is deliberately
 * minimal and explicitly EXCLUDES any application_answers/raw-answer
 * column — import_batches itself has no such column, but this comment
 * documents the constraint so a future edit doesn't widen the select().
 */
export async function getRecentImportBatches(caller: DashboardStaffCaller): Promise<CardResult<ImportBatchSummary[]>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const { data, error } = await caller.service
    .from('import_batches')
    .select('id, original_filename, status, uploaded_at, row_count, warning_count, error_count')
    .order('uploaded_at', { ascending: false })
    .limit(5);

  if (error) return { kind: 'error', message: error.message };
  // Defensive only: supabase-js resolves `data` to [] (not null) on a
  // genuine zero-row success once `error` is null, so this never actually
  // triggers — a real zero-rows result falls through to `{kind: 'data',
  // value: []}` below, which is the semantically correct CardResult here
  // ("no imports yet" is real data, not `empty` in the CardResult sense).
  if (!data) return { kind: 'empty' };

  return {
    kind: 'data',
    value: data.map((row) => ({
      id: row.id,
      filename: row.original_filename,
      status: row.status,
      uploadedAt: row.uploaded_at,
      rowCount: row.row_count,
      warningCount: row.warning_count,
      errorCount: row.error_count,
    })),
  };
}

/**
 * Count of import_batches rows whose status needs staff attention
 * ('failed' or 'completed_with_warnings' — the two terminal statuses that
 * are not clean successes, per the check constraint in
 * 20260726102000_import_staging_tables.sql). A real 0 is `{ kind: 'data',
 * value: 0 }` — no imports needing attention is a genuine, common, good
 * state, not an "empty" one.
 */
export async function getImportsRequiringAttention(caller: DashboardStaffCaller): Promise<CardResult<number>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const { count, error } = await caller.service
    .from('import_batches')
    .select('id', { count: 'exact', head: true })
    .in('status', ['failed', 'completed_with_warnings']);

  if (error) return { kind: 'error', message: error.message };
  return { kind: 'data', value: count ?? 0 };
}

/**
 * Count of applications with status = 'accepted'. Always `data` (never
 * `empty`) — zero accepted applications is a real, countable fact about
 * the world, not the absence of the concept "accepted applications".
 */
export async function getAcceptedParticipantCount(caller: DashboardStaffCaller): Promise<CardResult<number>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const { count, error } = await caller.service.from('applications').select('id', { count: 'exact', head: true }).eq('status', 'accepted');

  if (error) return { kind: 'error', message: error.message };
  return { kind: 'data', value: count ?? 0 };
}

export type PendingInvitationsSummary = {
  notSent: number;
  failed: number;
  sent: number;
};

/**
 * Counts grouped by the REAL participant_invitations.status values (per
 * 20260726104000_participant_invitations_table.sql's check constraint:
 * 'not_sent' | 'sending' | 'sent' | 'accepted' | 'expired' | 'revoked' |
 * 'failed'). This dashboard card surfaces exactly 3 of those buckets —
 * not_sent, failed, and sent ("sent but not yet claimed" — 'sent' is
 * already a distinct terminal status separate from 'accepted', so no
 * extra accepted_at check is needed to mean "not yet claimed"). NEVER
 * selects imported_email (or any other PII column) — only status is read,
 * via head:true count queries.
 */
export async function getPendingInvitationsSummary(caller: DashboardStaffCaller): Promise<CardResult<PendingInvitationsSummary>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const [notSentResult, failedResult, sentResult] = await Promise.all([
    caller.service.from('participant_invitations').select('id', { count: 'exact', head: true }).eq('status', 'not_sent'),
    caller.service.from('participant_invitations').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    caller.service.from('participant_invitations').select('id', { count: 'exact', head: true }).eq('status', 'sent'),
  ]);

  if (notSentResult.error) return { kind: 'error', message: notSentResult.error.message };
  if (failedResult.error) return { kind: 'error', message: failedResult.error.message };
  if (sentResult.error) return { kind: 'error', message: sentResult.error.message };

  return {
    kind: 'data',
    value: {
      notSent: notSentResult.count ?? 0,
      failed: failedResult.count ?? 0,
      sent: sentResult.count ?? 0,
    },
  };
}

export type UpcomingPublishedSession = {
  scheduleItemId: string;
  sessionId: string | null;
  titleAr: string | null;
  titleEn: string | null;
  startTime: string | null;
  roomNameAr: string | null;
  roomNameEn: string | null;
};

const UPCOMING_SESSIONS_LIMIT = 10;

/**
 * Upcoming sessions surfaced via schedule_publication_items where
 * item_status = 'active' and start_time is in the future, small limit.
 * This is the STAFF-AUTHENTICATED admin dashboard's own query — a
 * different authorization context than Task 9's public agenda page (which
 * concluded no safe PUBLIC/anonymous query exists over this join path).
 * Staff are authorized to see this data; this function's own
 * verifyStaffCaller() re-check is what enforces that, not RLS (the
 * service-role client bypasses RLS entirely).
 */
export async function getUpcomingPublishedSessions(caller: DashboardStaffCaller): Promise<CardResult<UpcomingPublishedSession[]>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const nowIso = new Date().toISOString();
  const { data, error } = await caller.service
    .from('schedule_publication_items')
    .select('id, session_id, session_title_ar, session_title_en, start_time, room_name_ar, room_name_en')
    .eq('item_status', 'active')
    .gt('start_time', nowIso)
    .order('start_time', { ascending: true })
    .limit(UPCOMING_SESSIONS_LIMIT);

  if (error) return { kind: 'error', message: error.message };
  // Defensive only — see getRecentImportBatches's identical comment above:
  // a real zero-rows success falls through to `{kind: 'data', value: []}`.
  if (!data) return { kind: 'empty' };

  return {
    kind: 'data',
    value: data.map((row) => ({
      scheduleItemId: row.id,
      sessionId: row.session_id,
      titleAr: row.session_title_ar,
      titleEn: row.session_title_en,
      startTime: row.start_time,
      roomNameAr: row.room_name_ar,
      roomNameEn: row.room_name_en,
    })),
  };
}

export type AllocationRunStatus = {
  id: string;
  status: string;
  runAt: string;
  confirmedAt: string | null;
};

/**
 * Most recent allocation_runs row (by run_at), or `{ kind: 'empty' }` if no
 * allocation run has EVER been kicked off — a structurally different fact
 * than "the latest run has status X".
 */
export async function getAllocationRunStatus(caller: DashboardStaffCaller): Promise<CardResult<AllocationRunStatus>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const { data, error } = await caller.service
    .from('allocation_runs')
    .select('id, status, run_at, confirmed_at')
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { kind: 'error', message: error.message };
  if (!data) return { kind: 'empty' };

  return {
    kind: 'data',
    value: { id: data.id, status: data.status, runAt: data.run_at, confirmedAt: data.confirmed_at },
  };
}

export type SchedulePublicationSummary = {
  staged: number;
  needsResolution: number;
  active: number;
};

/**
 * Counts by the REAL status values across the schedule-publication
 * pipeline (per 20260723140000_schedule_publication_tables.sql and
 * 20260723160000_schedule_publication_draft_tables.sql's check
 * constraints):
 *   - staged: schedule_publication_drafts.status = 'staged' — drafts
 *     generated but not yet confirmed/published.
 *   - needsResolution: schedule_publication_items.item_status IN
 *     ('stale', 'changed', 'pending_review') — items needing staff
 *     resolution before/after publication.
 *   - active: schedule_publications.status = 'active' — currently live
 *     publications.
 */
export async function getSchedulePublicationSummary(caller: DashboardStaffCaller): Promise<CardResult<SchedulePublicationSummary>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const [stagedResult, needsResolutionResult, activeResult] = await Promise.all([
    caller.service.from('schedule_publication_drafts').select('id', { count: 'exact', head: true }).eq('status', 'staged'),
    caller.service
      .from('schedule_publication_items')
      .select('id', { count: 'exact', head: true })
      .in('item_status', ['stale', 'changed', 'pending_review']),
    caller.service.from('schedule_publications').select('id', { count: 'exact', head: true }).eq('status', 'active'),
  ]);

  if (stagedResult.error) return { kind: 'error', message: stagedResult.error.message };
  if (needsResolutionResult.error) return { kind: 'error', message: needsResolutionResult.error.message };
  if (activeResult.error) return { kind: 'error', message: activeResult.error.message };

  return {
    kind: 'data',
    value: {
      staged: stagedResult.count ?? 0,
      needsResolution: needsResolutionResult.count ?? 0,
      active: activeResult.count ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// COY21 Phase 6 additions — session bookings + travel submission metrics
// ---------------------------------------------------------------------------

export type SessionBookingsSummary = {
  active: number;
  cancelled: number;
};

/** Active vs cancelled session booking counts. */
export async function getSessionBookingsSummary(caller: DashboardStaffCaller): Promise<CardResult<SessionBookingsSummary>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const [activeResult, cancelledResult] = await Promise.all([
    caller.service.from('session_bookings').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    caller.service.from('session_bookings').select('id', { count: 'exact', head: true }).eq('status', 'cancelled'),
  ]);

  if (activeResult.error) return { kind: 'error', message: activeResult.error.message };
  if (cancelledResult.error) return { kind: 'error', message: cancelledResult.error.message };

  return {
    kind: 'data',
    value: { active: activeResult.count ?? 0, cancelled: cancelledResult.count ?? 0 },
  };
}

/** Count of travel legs submitted by all participants. */
export async function getTravelLegCount(caller: DashboardStaffCaller): Promise<CardResult<number>> {
  if (!(await verifyStaffCaller(caller))) return { kind: 'unauthorized' };

  const { count, error } = await caller.service
    .from('travel_legs')
    .select('id', { count: 'exact', head: true });

  if (error) return { kind: 'error', message: error.message };
  return { kind: 'data', value: count ?? 0 };
}
