// src/lib/dashboard/participant-dashboard-queries.ts
//
// Typed, server-only query layer for the PARTICIPANT's own dashboard (Task
// 11 consumes these). Every function takes `{ userId, service }` where
// userId is the participant's OWN authenticated id (sourced from their own
// session by the Task 11 caller, e.g. `(await createClient()).auth.
// getUser()`), and scopes every query to THAT user's own data — never
// trusting a client-supplied id for anything beyond "this is who the
// caller claims to be", and never reading another participant's row.
// Ownership here is enforced by literally filtering every query on
// `= userId`, not by a role re-check (unlike admin-dashboard-queries.ts,
// where the caller's ROLE — not just their id — has to be re-verified).
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { findMyClaimableApplication } from '@/app/[locale]/(participant)/(bare)/claim/actions';
import type { CardResult } from './dashboard-types';
import type { Database } from '@/types/database';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;
type SessionClient = SupabaseClient<Database>;

export type DashboardParticipantCaller = { userId: string; service: ServiceClient };

export type MyApplicationStatus = {
  applicationId: string;
  status: string;
};

/**
 * Reads the caller's own applications row via `applicant_id = userId` —
 * only meaningful once the application has been claimed (an unclaimed
 * imported application has `applicant_id = null` and cannot belong to any
 * caller). No row for this user -> `{ kind: 'empty' }` (nothing claimed
 * yet, not an error).
 */
export async function getMyApplicationStatus(caller: DashboardParticipantCaller): Promise<CardResult<MyApplicationStatus>> {
  const { data, error } = await caller.service.from('applications').select('id, status').eq('applicant_id', caller.userId).maybeSingle();

  if (error) return { kind: 'error', message: error.message };
  if (!data) return { kind: 'empty' };

  return { kind: 'data', value: { applicationId: data.id, status: data.status } };
}

export type MyClaimState = { claimed: boolean; applicationId: string };

/**
 * CRITICAL, CORRECTED REQUIREMENT (caught during plan review — see Task
 * 10's plan text): this function MUST delegate to the EXISTING
 * findMyClaimableApplication() (src/app/[locale]/(participant)/(bare)/
 * claim/actions.ts) rather than re-deriving an equivalent
 * participant_invitations/applications.applicant_id check here. That
 * function is the ONLY correct way to check claimability — it queries
 * participant_invitations for `invited_user_id = <caller's own
 * auth.uid()> AND status = 'sent'` via a service-role client (necessary
 * because participant_invitations is staff-only under RLS — see that
 * function's own doc comment), and DELIBERATELY returns an
 * undifferentiated empty `{}` for "already claimed by someone else,
 * revoked, failed, or no invitation at all" — an anti-leak design, not an
 * oversight. Duplicating that query here would risk leaking the
 * "why not claimable" distinction it deliberately withholds.
 *
 * `sessionClient` is required (not optional) because
 * findMyClaimableApplication() derives its own caller identity from
 * whichever Supabase client it is given (via that client's own
 * auth.getUser()) — it takes no userId argument, by design, so there is no
 * input to tamper with. This function's own `caller.userId` is used ONLY
 * for the fallback `applications.applicant_id` lookup below, once
 * findMyClaimableApplication() has already returned its undifferentiated
 * empty result — it is never passed to findMyClaimableApplication() itself.
 * The claimable-application branch is therefore ALWAYS scoped by whoever
 * the session client actually authenticates as, never by the userId
 * argument (defense in depth: even a mismatched/tampered userId can never
 * pivot this function onto another participant's claimable application,
 * since that branch never looks at userId at all). Task 11's page/action
 * is responsible for supplying the same signed-in session client whose
 * auth.getUser() resolves to caller.userId (exactly how claim/page.tsx
 * already calls findMyClaimableApplication() with the implicit
 * cookie-backed client in production); the live test supplies a real
 * anon-key client signed in as that same user, mirroring
 * tests/import/claim-live.test.ts's established pattern.
 *
 * Mapping:
 *   - findMyClaimableApplication() returns `{ applicationId }` -> claimable,
 *     not yet claimed -> `{ kind: 'data', value: { claimed: false,
 *     applicationId } }`.
 *   - findMyClaimableApplication() returns `{ error }` -> the lookup itself
 *     failed -> `{ kind: 'error', message }`.
 *   - findMyClaimableApplication() returns `{}` (its deliberate anti-leak
 *     empty case) -> check `applications` for a row with
 *     `applicant_id = caller.userId` (the CALLER's own id, from their own
 *     authenticated session, never a client-supplied id):
 *       - found -> already claimed by ME -> `{ kind: 'data', value:
 *         { claimed: true, applicationId } }`.
 *       - not found -> nothing to claim, no invitation, not an error ->
 *         `{ kind: 'empty' }`.
 *   NEVER exposes the claimed-by-someone-else / revoked / failed
 *   distinction findMyClaimableApplication() deliberately withholds — this
 *   function's return type has no room to represent it, by design.
 */
export async function getMyClaimState(
  caller: DashboardParticipantCaller,
  sessionClient: SessionClient
): Promise<CardResult<MyClaimState>> {
  const result = await findMyClaimableApplication(sessionClient);

  if (result.error) return { kind: 'error', message: result.error };

  if (result.applicationId) {
    return { kind: 'data', value: { claimed: false, applicationId: result.applicationId } };
  }

  // Undifferentiated empty case: could be already-claimed-by-me, or
  // claimed-by-someone-else/revoked/failed/no-invitation-at-all — all of
  // which findMyClaimableApplication() deliberately collapses into `{}`.
  // Disambiguate ONLY the "claimed by me" case via the caller's own id.
  const { data, error } = await caller.service.from('applications').select('id').eq('applicant_id', caller.userId).maybeSingle();
  if (error) return { kind: 'error', message: error.message };
  if (data) return { kind: 'data', value: { claimed: true, applicationId: data.id } };

  return { kind: 'empty' };
}

export type MySchedulePublicationState = {
  publicationId: string;
  status: string;
  revisionNumber: number;
  publishedAt: string;
};

/**
 * The participant's own schedule-publication state — the currently
 * `active` schedule_publications row (per
 * schedule_publications_one_active's partial unique index, there is at
 * most one) scoped to `application_id` belonging to the caller's own
 * applications row (`applicant_id = userId`). Two-step lookup (own
 * application id, then its schedule_publications row) rather than a
 * client-side join, matching this codebase's established pattern of
 * explicit sequential queries over service-role clients elsewhere in this
 * task.
 *
 * No claimed application at all, or a claimed application with no active
 * publication yet -> `{ kind: 'empty' }` (nothing published yet, not an
 * error).
 */
export async function getMySchedulePublicationState(
  caller: DashboardParticipantCaller
): Promise<CardResult<MySchedulePublicationState>> {
  const { data: application, error: applicationError } = await caller.service
    .from('applications')
    .select('id')
    .eq('applicant_id', caller.userId)
    .maybeSingle();

  if (applicationError) return { kind: 'error', message: applicationError.message };
  if (!application) return { kind: 'empty' };

  const { data: publication, error: publicationError } = await caller.service
    .from('schedule_publications')
    .select('id, status, revision_number, published_at')
    .eq('application_id', application.id)
    .eq('status', 'active')
    .maybeSingle();

  if (publicationError) return { kind: 'error', message: publicationError.message };
  if (!publication) return { kind: 'empty' };

  return {
    kind: 'data',
    value: {
      publicationId: publication.id,
      status: publication.status,
      revisionNumber: publication.revision_number,
      publishedAt: publication.published_at,
    },
  };
}

export type MyTravelCompleteness = { submitted: boolean };

/**
 * Whether the caller has a travel-info submission on file, for the
 * status-aware home screen's card-priority logic (Task 8, not this task).
 * Two-step lookup matching getMySchedulePublicationState's established
 * pattern above: the caller's own `applications.id` via
 * `applicant_id = userId`, then a dependent query against
 * `application_travel_info` scoped to that `application_id`.
 *
 * application_travel_info (supabase/migrations/20260730110000_application_
 * travel_and_health_info_tables.sql) is a strict 1:1 extension of
 * `applications`: `application_id` is BOTH its primary key and its foreign
 * key — there is no separate surrogate `id` column, unlike
 * schedule_publications above. Existence of that row (regardless of which
 * of its nullable fields are actually filled in) is what "submitted" means
 * here, mirroring how travel-ops/travel-info-management.ts's own
 * fetchTravelInfoForCaller looks the row up (`.eq('application_id',
 * applicationId).maybeSingle()`).
 *
 * No claimed application at all -> `{ kind: 'empty' }` (nothing to have
 * submitted travel info against, not an error). A claimed application with
 * no application_travel_info row yet -> `{ kind: 'data', value:
 * { submitted: false } }` — a real, known "not submitted" answer, not an
 * absence of data.
 */
export async function getMyTravelCompleteness(caller: DashboardParticipantCaller): Promise<CardResult<MyTravelCompleteness>> {
  const { data: application, error: applicationError } = await caller.service
    .from('applications')
    .select('id')
    .eq('applicant_id', caller.userId)
    .maybeSingle();

  if (applicationError) return { kind: 'error', message: applicationError.message };
  if (!application) return { kind: 'empty' };

  const { data: travelInfo, error: travelError } = await caller.service
    .from('application_travel_info')
    .select('application_id')
    .eq('application_id', application.id)
    .maybeSingle();

  if (travelError) return { kind: 'error', message: travelError.message };
  return { kind: 'data', value: { submitted: Boolean(travelInfo) } };
}

export type MyAttendanceForSession = { status: string; entryType: string; admittedAt: string };

/**
 * The caller's own actual attendance state per session, for the Phase 8.4
 * schedule-page display ("actual attendance alongside the recommended
 * session," never overwriting it — see docs/superpowers/specs/2026-07-31-
 * flexible-admission-qr-attendance-design.md's Participant Experience &
 * Dashboard section). Keyed by session_id so the caller (schedule/page.tsx)
 * can look up each rendered item's own attendance state without a second
 * per-item query.
 *
 * attendance_records has no participant-self RLS policy today (only
 * program_attendance_manager/super_admin and scanner_device — see
 * supabase/migrations/20260804150000_attendance_rls_policies.sql), so this
 * goes through the service-role client with an explicit applicant_id-owned
 * application_id filter, matching this file's own established pattern
 * (getMySchedulePublicationState above) rather than adding a new RLS
 * policy for a single read path.
 *
 * Only the most recent row per session_id is kept (attendance_records can
 * accumulate transferred_out/corrected history rows for the same session —
 * see admission-management.ts) — a participant should see their current
 * state, not every historical row. "Current" here means most recent by
 * admitted_at, which is correct for status transitions written by
 * correctAttendanceForCaller (same row, status updated in place) and for
 * transferAttendanceForCaller (a new row superseding the old one, with a
 * later admitted_at) alike.
 */
export async function getMyAttendanceForApplication(
  caller: DashboardParticipantCaller,
  applicationId: string
): Promise<CardResult<Record<string, MyAttendanceForSession>>> {
  const { data: application, error: applicationError } = await caller.service
    .from('applications')
    .select('id')
    .eq('id', applicationId)
    .eq('applicant_id', caller.userId)
    .maybeSingle();
  if (applicationError) return { kind: 'error', message: applicationError.message };
  if (!application) return { kind: 'empty' };

  const { data: rows, error } = await caller.service
    .from('attendance_records')
    .select('session_id, status, entry_type, admitted_at')
    .eq('application_id', application.id)
    .order('admitted_at', { ascending: false });
  if (error) return { kind: 'error', message: error.message };
  if (!rows || rows.length === 0) return { kind: 'empty' };

  const bySession: Record<string, MyAttendanceForSession> = {};
  for (const row of rows) {
    if (bySession[row.session_id]) continue; // already kept the most recent (rows are newest-first)
    bySession[row.session_id] = { status: row.status, entryType: row.entry_type, admittedAt: row.admitted_at };
  }
  return { kind: 'data', value: bySession };
}
