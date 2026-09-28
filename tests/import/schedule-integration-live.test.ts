// tests/import/schedule-integration-live.test.ts
//
// Live integration coverage for Task 22 — the first test in this plan that
// exercises Phase 5.1 (this worktree: import -> confirm -> claim) and
// Phase 5 (already-merged: feature extraction -> clustering -> allocation ->
// schedule publication -> the participant-facing /schedule page) together,
// end to end, in one real pipeline run.
//
// What this proves: the participant `/schedule` page's underlying query
// (applications.applicant_id = auth.uid(), then schedule_publications /
// schedule_publication_items gated by schedule_publications_select_own /
// schedule_publication_items_select_own — both keyed purely on
// applications.applicant_id, see supabase/migrations/20260723170000_schedule_rls_policies.sql)
// works identically for a participant whose applicant_id was set by Task 21's
// claim_imported_application_transactional RPC, not just for one who
// self-registered. There is nothing schedule-publication-specific about how
// applicant_id got populated — this test's job is to confirm that by actually
// driving a claimed, imported participant through the real Phase 5 pipeline
// and reading /schedule's real query as them, rather than assuming.
//
// ============================================================================
// NO REAL EMAILS ARE SENT BY THIS SUITE.
// ============================================================================
// Same constraint and same construction as tests/import/claim-live.test.ts:
// this project's default 2-sends-per-hour email quota (no custom SMTP) is
// exhausted, and inviteUserByEmail (or any other real-email-sending Auth
// Admin method) must never be called here. The "invited and claimed" account
// is constructed directly: admin.auth.admin.createUser (sends no email) plus
// a hand-seeded participant_invitations row with status: 'sent' — the exact
// end state Task 20's sendInvitation would have produced on success. The
// claim path itself (claimApplication, called with a REAL anon-key session)
// is exercised for real and is unaffected by how the invited Auth user came
// to exist.
//
// No local Postgres exists for this project — every test here runs against
// the live linked Supabase project, same as every other tests/import/*-live
// test. All seeded/created rows are removed in afterAll, and the suite is
// written to be safely re-runnable back-to-back (verified by running it
// twice in succession, per the plan's process step 5).
//
// Calls the *ForCaller variants (runValidationForCaller,
// startImportForCaller/processImportChunkForCaller,
// runDownstreamProcessingForCaller) rather than the exported 'use server'
// actions, for the same reason documented in every other live test in this
// directory: 'use server' functions call next/headers' cookies() via
// requireAgendaStaffCaller, which throws outside a real Next.js request.
// stagePublication/confirmPublication and claimApplication are called
// directly against their underlying lib functions (they don't go through
// requireAgendaStaffCaller at all — stagePublication/confirmPublication take
// an explicit service client + userId, exactly as
// tests/schedule/publication-lifecycle.test.ts already does; claimApplication
// takes an explicit session client, exactly as claim-live.test.ts does).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import type { Database } from '@/types/database';
import { runValidationForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/preview/actions';
import { startImportForCaller, processImportChunkForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions';
import { runDownstreamProcessingForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/downstream-actions';
import { claimApplication } from '@/app/[locale]/(participant)/(bare)/claim/actions';
import { stagePublication } from '@/lib/schedule/run-stage-publication';
import { confirmPublication } from '@/lib/schedule/run-confirm-publication';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PASSWORD = 'password123';
const STAFF_EMAIL = 'schedule-integration-live-staff@test.local';
const PARTICIPANT_EMAIL_PREFIX = 'schedule-integration-live-';
const EMAIL_DOMAIN = 'test.local';
// runAllocation() intentionally scores every 'accepted' application in the
// whole shared disposable project, not just this test's own fixture (Phase
// 7G-K test-isolation finding) -- with a small capacity, this suite's one
// participant (near-zero cosine-similarity score against most of the
// shared pool) could lose the mandatory session's limited seats to
// unrelated accepted applications from other suites, independent of any
// bug in this test or in production. This suite is verifying import ->
// schedule -> allocation INTEGRATION, not capacity contention (that is
// covered by tests/allocation/priority-pool-validation-live.test.ts and
// tests/allocation/run-behavioral.test.ts), so the mandatory session uses
// a deliberately non-contended capacity well above any realistic shared-
// project accepted-application count, rather than a small realistic
// number. Do not lower this back down without also test-scoping
// runAllocation itself -- see the finding above for why.
const NON_CONTENDED_TEST_CAPACITY = 50000;

let staffId: string;
let tagId: string;
let ruleId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let mandatorySessionId: string;
let storagePath: string;
let importBatchId: string;
let importColumnMappingIds: string[] = [];
let importedApplicationId: string;
let participantAuthUserId: string | undefined;
let featureExtractionRunId: string | undefined;
let clusteringRunId: string | undefined;
let allocationRunId: string | undefined;
let draftId: string | undefined;

/** Removes a leftover staff user (and its audit rows) from a prior aborted
 *  run before beforeAll tries to createUser with the same email again — the
 *  same sweep-first-by-prefix precedent claim-live.test.ts's
 *  sweepByPrefix establishes. Without this, a prior run whose staff
 *  deleteUser call failed (e.g. blocked by a project-wide allocation/
 *  publication run that also swept in OTHER pre-existing accepted
 *  applications this suite doesn't own — the exact scoping behavior
 *  documented and asserted as correct in
 *  tests/import/downstream-processing-live.test.ts) would otherwise make
 *  every subsequent run fail immediately with "already registered". */
async function sweepStaffLeftover() {
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) break;
    for (const u of data.users) {
      if (u.email === STAFF_EMAIL) {
        await admin.from('audit_logs').delete().eq('actor_id', u.id).then(() => undefined, () => undefined);
        const result = await admin.auth.admin.deleteUser(u.id);
        if (result.error) {
          // A leftover staff user can be genuinely undeletable across runs
          // when a project-wide allocation/schedule-publication run it
          // triggered also swept in unrelated pre-existing accepted
          // applications (belonging to OTHER test suites) that this suite
          // must not touch — those foreign rows still reference this
          // staffId via run_by/published_by/updated_by. This is a known,
          // out-of-scope-for-this-task condition (stale debris from other
          // suites, e.g. tests/schedule/*-behavioral.test.ts, whose own
          // cleanup didn't run to completion at some point), not a defect
          // in this suite's own cleanup. Logged, not thrown, so this sweep
          // can never itself block the run.
          console.error('sweepStaffLeftover: leftover staff user could not be deleted (likely blocked by unrelated pre-existing data)', result.error);
        }
      }
    }
    if (data.users.length < perPage) break;
    page += 1;
  }
}

async function signInAs(email: string) {
  const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Failed to sign in as ${email}: ${error.message}`);
  return client;
}

async function buildWorkbookBuffer(email: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Participants');
  ws.addRow(['Full Name', 'Email', 'Organization', 'Interests']);
  ws.addRow(['Schedule Integration Person', email, 'Integration Org', 'Renewables']);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/** FK-safe deletion order for everything downstream of an applications row,
 *  following the precedent established in tests/import/rollback-live.test.ts
 *  and tests/import/downstream-processing-live.test.ts (participant_feature_snapshots
 *  / cluster_memberships / allocation_assignments / allocation_issues before
 *  applications) plus this suite's own schedule_publications /
 *  schedule_publication_drafts, which must go before applications too since
 *  schedule_publications.application_id has no cascade. */
async function cleanupPipelineArtifacts() {
  if (draftId) {
    await admin.from('schedule_publication_draft_items').delete().eq('schedule_publication_draft_id', draftId);
    await admin.from('schedule_publication_drafts').delete().eq('id', draftId);
  }
  if (importedApplicationId) {
    const { data: publications } = await admin.from('schedule_publications').select('id').eq('application_id', importedApplicationId);
    if (publications && publications.length > 0) {
      const pubIds = publications.map((p) => p.id);
      await admin.from('schedule_publication_items').delete().in('schedule_publication_id', pubIds);
      await admin.from('schedule_publications').delete().in('id', pubIds);
    }
  }
  if (allocationRunId) {
    // allocation_issues/allocation_assignments both cascade from
    // allocation_runs (on delete cascade — verified against
    // supabase/migrations/20260723100000_allocation_tables.sql), so deleting
    // the run alone is sufficient for rows created by THIS run. The
    // session_id-scoped delete in sweepFixtureLeftovers is the separate
    // defence needed for a lingering issues row from a run this suite no
    // longer has the id for (e.g. after a mid-test failure).
    await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  }
  if (clusteringRunId) {
    await admin.from('clustering_runs').delete().eq('id', clusteringRunId);
  }
  if (featureExtractionRunId) {
    await admin.from('feature_extraction_runs').delete().eq('id', featureExtractionRunId);
  }
  if (importedApplicationId) {
    await admin.from('participant_feature_snapshots').delete().eq('application_id', importedApplicationId);
    await admin.from('cluster_memberships').delete().eq('application_id', importedApplicationId);
    await admin.from('allocation_assignments').delete().eq('application_id', importedApplicationId);
    await admin.from('allocation_issues').delete().eq('application_id', importedApplicationId);
  }
}

async function cleanupImportArtifacts() {
  if (importBatchId) {
    const { data: rowsToDelete } = await admin.from('import_rows').select('id').eq('import_batch_id', importBatchId);
    if (rowsToDelete && rowsToDelete.length > 0) {
      await admin.from('import_rows').delete().in('id', rowsToDelete.map((r) => r.id));
    }
    if (importColumnMappingIds.length > 0) {
      await admin.from('import_column_mappings').delete().in('id', importColumnMappingIds);
    }
    await admin.from('import_batches').delete().eq('id', importBatchId);
  }
  if (storagePath) {
    await admin.storage.from('import-uploads').remove([storagePath]).catch(() => undefined);
  }
}

async function cleanupApplicationAndAuth() {
  if (importedApplicationId) {
    await admin.from('participant_invitations').delete().eq('application_id', importedApplicationId);
    await admin.from('audit_logs').delete().eq('entity_id', importedApplicationId);
    await admin.from('applications').delete().eq('id', importedApplicationId);
  }
  // Sweep by prefix too, in case a prior aborted run left a straggler with a
  // different id than what this run tracked.
  const { data: byEmail } = await admin.from('applications').select('id').like('imported_email', `${PARTICIPANT_EMAIL_PREFIX}%`);
  if (byEmail && byEmail.length > 0) {
    const ids = byEmail.map((a) => a.id);
    await admin.from('participant_invitations').delete().in('application_id', ids);
    await admin.from('audit_logs').delete().in('entity_id', ids);
    await admin.from('applications').delete().in('id', ids);
  }

  const actorIds = [staffId, participantAuthUserId].filter(Boolean) as string[];
  if (actorIds.length > 0) {
    await admin.from('audit_logs').delete().in('actor_id', actorIds);
  }

  if (participantAuthUserId) {
    const result = await admin.auth.admin.deleteUser(participantAuthUserId);
    if (result.error) console.error('afterAll cleanup: participant auth user delete returned an error', result.error);
  }
  // Sweep any straggler auth users by prefix.
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) break;
    for (const u of data.users) {
      if (u.email?.toLowerCase().startsWith(PARTICIPANT_EMAIL_PREFIX)) {
        await admin.from('audit_logs').delete().eq('actor_id', u.id).then(() => undefined, () => undefined);
        await admin.auth.admin.deleteUser(u.id).catch(() => undefined);
      }
    }
    if (data.users.length < perPage) break;
    page += 1;
  }

  if (staffId) {
    await admin.from('audit_logs').delete().eq('actor_id', staffId);
    const result = await admin.auth.admin.deleteUser(staffId);
    if (result.error) console.error('afterAll cleanup: staff delete returned an error', result.error);
  }
}

async function cleanupSessionFixtures() {
  if (mandatorySessionId) {
    await admin.from('session_tags').delete().eq('session_id', mandatorySessionId);
    await admin.from('schedule_change_events').delete().eq('session_id', mandatorySessionId);
    await admin.from('sessions').delete().eq('id', mandatorySessionId);
  }
  if (conferenceDayId) await admin.from('conference_days').delete().eq('id', conferenceDayId);
  if (roomId) await admin.from('rooms').delete().eq('id', roomId);
  if (trackId) await admin.from('tracks').delete().eq('id', trackId);
  if (sessionTypeId) await admin.from('session_types').delete().eq('id', sessionTypeId);
  if (ruleId) await admin.from('feature_extraction_rules').delete().eq('id', ruleId);
  if (tagId) await admin.from('tags').delete().eq('id', tagId);
}

/** Removes leftover reference fixtures (session/day/room/track/type/tag) from
 *  a prior aborted run, keyed by the fixed unique codes/dates this suite
 *  always uses — otherwise a re-run after a mid-test failure hits a unique-
 *  constraint violation on conference_date/code instead of proceeding. Order
 *  matters: sessions before conference_days/rooms/tracks/session_types
 *  (FK dependents first), feature_extraction_rules before tags. */
async function sweepFixtureLeftovers() {
  const { data: sessions } = await admin.from('sessions').select('id').eq('session_code', 'SCHED-INTEGRATION-MANDATORY-1');
  for (const s of sessions ?? []) {
    await admin.from('schedule_publication_items').delete().eq('session_id', s.id);
    await admin.from('session_tags').delete().eq('session_id', s.id);
    await admin.from('schedule_change_events').delete().eq('session_id', s.id);
    // allocation_issues.session_id has no cascade (it's a plain nullable FK,
    // not `on delete cascade` — confirmed against
    // supabase/migrations/20260723100000_allocation_tables.sql) — deleting
    // an allocation_runs row alone does NOT remove a lingering issues row
    // that still references this session directly, and without this line a
    // re-run after a mid-test failure hits
    // "sessions_conference_day_id_fkey"/"allocation_issues_session_id_fkey"
    // instead of proceeding (found while hardening this suite's re-run
    // safety).
    await admin.from('allocation_issues').delete().eq('session_id', s.id);
    await admin.from('allocation_assignments').delete().eq('session_id', s.id);
  }
  if (sessions && sessions.length > 0) {
    await admin.from('sessions').delete().in('id', sessions.map((s) => s.id));
  }
  const { data: days } = await admin.from('conference_days').select('id').eq('conference_date', '2026-09-17');
  if (days && days.length > 0) await admin.from('conference_days').delete().in('id', days.map((d) => d.id));
  const { data: rooms } = await admin.from('rooms').select('id').eq('code', 'SCHED-INTEGRATION-ROOM');
  if (rooms && rooms.length > 0) await admin.from('rooms').delete().in('id', rooms.map((r) => r.id));
  const { data: tracks } = await admin.from('tracks').select('id').eq('code', 'SCHED-INTEGRATION-TRACK');
  if (tracks && tracks.length > 0) await admin.from('tracks').delete().in('id', tracks.map((t) => t.id));
  const { data: types } = await admin.from('session_types').select('id').eq('code', 'SCHED-INTEGRATION-TYPE');
  if (types && types.length > 0) await admin.from('session_types').delete().in('id', types.map((t) => t.id));
  const { data: tags } = await admin.from('tags').select('id').eq('code', 'SCHED-INTEGRATION-TAG');
  for (const t of tags ?? []) {
    await admin.from('feature_extraction_rules').delete().eq('tag_id', t.id);
    // participant_feature_snapshots.tag_id also references tags(id) with no
    // cascade — found missing here during Task 28's gate 6 verification
    // pass, via a real 403/FK-block reproduced against the live project
    // when a prior interrupted run left this exact tag referenced by
    // snapshot rows this sweep never cleared. Without this, a genuinely
    // interrupted run (crash mid-suite, not just a normal pass/fail) can
    // wedge every subsequent run of this file with an unrecoverable tag
    // delete failure, since sweepFixtureLeftovers has no reuse-on-failure
    // fallback the way sweepStaffLeftover does for the Auth user.
    await admin.from('participant_feature_snapshots').delete().eq('tag_id', t.id);
  }
  if (tags && tags.length > 0) await admin.from('tags').delete().in('id', tags.map((t) => t.id));
}

beforeAll(async () => {
  await sweepStaffLeftover();
  await sweepFixtureLeftovers();

  const { data: staff, error } = await admin.auth.admin.createUser({ email: STAFF_EMAIL, password: PASSWORD, email_confirm: true });
  if (error) {
    // The sweep above could not fully clear a leftover staff user from a
    // prior run (see sweepStaffLeftover's comment) — fall back to reusing
    // that existing user rather than failing the whole suite, exactly as a
    // real re-run of this test would need to. Only reuse-by-lookup on the
    // specific "already registered" error; any other createUser failure
    // still aborts as a real setup problem.
    if (!/already been registered/i.test(error.message)) {
      throw new Error(`Failed to create staff user: ${error.message}`);
    }
    let page = 1;
    let found: string | undefined;
    for (;;) {
      const { data, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (listError) throw new Error(`Failed to list users while recovering leftover staff: ${listError.message}`);
      found = data.users.find((u) => u.email === STAFF_EMAIL)?.id;
      if (found || data.users.length < 1000) break;
      page += 1;
    }
    if (!found) throw new Error('createUser reported "already registered" but no matching user was found');
    staffId = found;
  } else {
    staffId = staff.user!.id;
  }
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  // Reference data: a real mandatory session with capacity for at least this
  // one participant, tagged so feature extraction -> clustering -> allocation
  // has something real to match against (mirrors
  // tests/schedule/publication-lifecycle.test.ts's fixture shape).
  const { data: tag, error: tagError } = await admin
    .from('tags')
    .insert({ code: 'SCHED-INTEGRATION-TAG', name_ar: 'وسم', name_en: 'Tag' })
    .select('id')
    .single();
  if (tagError || !tag) throw new Error(`Failed to create tag: ${tagError?.message}`);
  tagId = tag.id;

  const { data: rule, error: ruleError } = await admin
    .from('feature_extraction_rules')
    .insert({
      version: 1,
      source_field: 'interests',
      match_type: 'array_value',
      match_value: 'Renewables',
      tag_id: tagId,
      weight: 1.0,
      is_active: true,
    })
    .select('id')
    .single();
  if (ruleError || !rule) throw new Error(`Failed to create extraction rule: ${ruleError?.message}`);
  ruleId = rule.id;

  const { data: day, error: dayError } = await admin
    .from('conference_days')
    .insert({ conference_date: '2026-09-17', label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  if (dayError || !day) throw new Error(`Failed to create conference day: ${dayError?.message}`);
  conferenceDayId = day.id;

  const { data: room, error: roomError } = await admin
    .from('rooms')
    // capacity must be >= NON_CONTENDED_TEST_CAPACITY below --
    // enforce_session_room_capacity() (20260723020000_sessions_triggers.sql)
    // rejects a session capacity greater than its room's capacity.
    .insert({ code: 'SCHED-INTEGRATION-ROOM', name_ar: 'قاعة', name_en: 'Room', capacity: NON_CONTENDED_TEST_CAPACITY })
    .select('id')
    .single();
  if (roomError || !room) throw new Error(`Failed to create room: ${roomError?.message}`);
  roomId = room.id;

  const { data: track, error: trackError } = await admin
    .from('tracks')
    .insert({ code: 'SCHED-INTEGRATION-TRACK', name_ar: 'مسار', name_en: 'Track' })
    .select('id')
    .single();
  if (trackError || !track) throw new Error(`Failed to create track: ${trackError?.message}`);
  trackId = track.id;

  const { data: sessionType, error: sessionTypeError } = await admin
    .from('session_types')
    .insert({ code: 'SCHED-INTEGRATION-TYPE', name_ar: 'نوع', name_en: 'Type' })
    .select('id')
    .single();
  if (sessionTypeError || !sessionType) throw new Error(`Failed to create session type: ${sessionTypeError?.message}`);
  sessionTypeId = sessionType.id;

  const { data: mandatory, error: mandatoryError } = await admin
    .from('sessions')
    .insert({
      session_code: 'SCHED-INTEGRATION-MANDATORY-1',
      title_ar: 'إلزامي',
      title_en: 'Mandatory Integration Session',
      conference_day_id: conferenceDayId,
      start_time: '2026-09-17T09:00:00Z',
      end_time: '2026-09-17T10:00:00Z',
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: roomId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: NON_CONTENDED_TEST_CAPACITY,
      is_mandatory: true,
      status: 'confirmed',
      include_in_allocation: true,
    })
    .select('id')
    .single();
  if (mandatoryError || !mandatory) throw new Error(`Failed to create mandatory session: ${mandatoryError?.message}`);
  mandatorySessionId = mandatory.id;

  await admin.from('session_tags').insert({ session_id: mandatorySessionId, tag_id: tagId, weight: 1.0 });
}, 300000);

afterAll(async () => {
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`afterAll cleanup step failed: ${label}`, err);
    }
  };

  await step('cleanup pipeline artifacts (schedule publications, drafts, allocation/clustering/extraction runs)', cleanupPipelineArtifacts);
  await step('cleanup import artifacts (import_rows, mappings, batch, storage)', cleanupImportArtifacts);
  await step('cleanup application and auth users', cleanupApplicationAndAuth);
  await step('cleanup session/reference fixtures', cleanupSessionFixtures);
}, 300000);

describe('schedule integration (live): Phase 5.1 import+claim feeding Phase 5 schedule publication', () => {
  it(
    'imports a participant, runs feature extraction -> clustering -> allocation -> confirm -> publish, claims their account, and reads their own published schedule via /schedule\'s real query',
    async () => {
      const participantEmail = `${PARTICIPANT_EMAIL_PREFIX}participant-${Date.now()}@${EMAIL_DOMAIN}`;

      // -------------------------------------------------------------
      // Stage 1: import a participant via the real Phase 5.1 pipeline
      // (upload -> mappings -> validation -> chunked confirm), producing a
      // real applications row with status: 'accepted', applicant_id: null —
      // exactly what Task 15's RPC leaves behind, not a hand-built row.
      // -------------------------------------------------------------
      const buffer = await buildWorkbookBuffer(participantEmail);
      storagePath = `schedule-integration-live-test/${Date.now()}.xlsx`;
      const { error: uploadError } = await admin.storage.from('import-uploads').upload(storagePath, buffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      if (uploadError) throw new Error(`Failed to upload test workbook: ${uploadError.message}`);

      const { data: batch, error: batchError } = await admin
        .from('import_batches')
        .insert({
          uploaded_by: staffId,
          original_filename: 'schedule-integration-live-test.xlsx',
          file_checksum: `schedule-integration-live-test-${Date.now()}`,
          storage_path: storagePath,
          sheet_name: 'Participants',
          status: 'validating',
          unique_identifier_column_index: 1,
        })
        .select('id')
        .single();
      if (batchError || !batch) throw new Error(`Failed to create batch: ${batchError?.message}`);
      importBatchId = batch.id;

      const { data: mappings, error: mappingError } = await admin
        .from('import_column_mappings')
        .insert([
          { import_batch_id: importBatchId, source_column_index: 0, source_column_header: 'Full Name', target_kind: 'core_field', target_key: 'full_name' },
          { import_batch_id: importBatchId, source_column_index: 1, source_column_header: 'Email', target_kind: 'core_field', target_key: 'email' },
          { import_batch_id: importBatchId, source_column_index: 2, source_column_header: 'Organization', target_kind: 'known_answer', target_key: 'organization' },
          { import_batch_id: importBatchId, source_column_index: 3, source_column_header: 'Interests', target_kind: 'known_answer', target_key: 'interests' },
        ])
        .select('id');
      if (mappingError) throw new Error(`Failed to create mappings: ${mappingError.message}`);
      importColumnMappingIds = (mappings ?? []).map((m) => m.id);

      const caller = { userId: staffId, service: admin };
      await runValidationForCaller(importBatchId, caller);

      const { lockToken } = await startImportForCaller(importBatchId, caller);
      let guard = 0;
      let last = { isComplete: false } as Awaited<ReturnType<typeof processImportChunkForCaller>>;
      while (!last.isComplete && guard++ < 20) {
        last = await processImportChunkForCaller({ batchId: importBatchId, lockToken }, caller);
      }
      expect(last.isComplete).toBe(true);

      const { data: importRows } = await admin
        .from('import_rows')
        .select('destination_application_id, normalized_row')
        .eq('import_batch_id', importBatchId);
      const row = (importRows ?? []).find((r) => (r.normalized_row as { email?: string } | null)?.email === participantEmail);
      expect(row?.destination_application_id).toBeTruthy();
      importedApplicationId = row!.destination_application_id!;

      const { data: importedApp } = await admin
        .from('applications')
        .select('status, applicant_id, imported_email')
        .eq('id', importedApplicationId)
        .single();
      expect(importedApp?.status).toBe('accepted');
      expect(importedApp?.applicant_id).toBeNull();
      expect(importedApp?.imported_email).toBe(participantEmail);

      // -------------------------------------------------------------
      // Stage 2: feature extraction -> clustering -> allocation, the same
      // call pattern downstream-actions.ts uses (Task 17), reused directly.
      // -------------------------------------------------------------
      const downstreamResult = await runDownstreamProcessingForCaller(importBatchId, caller, 1);
      expect(downstreamResult.downstreamStatus).toBe('completed');
      featureExtractionRunId = downstreamResult.featureExtractionRunId;
      clusteringRunId = downstreamResult.clusteringRunId;
      allocationRunId = downstreamResult.allocationRunId;
      expect(allocationRunId).toBeTruthy();

      // This imported participant must actually have been assigned to the
      // mandatory session by the real allocation algorithm (not asserted
      // blindly — the whole point of this pipeline stage).
      const { data: assignment } = await admin
        .from('allocation_assignments')
        .select('id, session_id')
        .eq('allocation_run_id', allocationRunId!)
        .eq('application_id', importedApplicationId)
        .eq('session_id', mandatorySessionId)
        .maybeSingle();
      expect(assignment).toBeTruthy();

      // -------------------------------------------------------------
      // Stage 3: confirm the allocation run, then stage + confirm a real
      // schedule publication — Phase 5's actual orchestrators
      // (stagePublication / confirmPublication from
      // src/lib/schedule/run-stage-publication.ts and run-confirm-publication.ts),
      // the same functions src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/actions.ts
      // calls in production.
      // -------------------------------------------------------------
      const { error: confirmRunError } = await admin.rpc('confirm_allocation_run_transactional', {
        p_run_id: allocationRunId!,
        p_confirmed_by: staffId,
      });
      if (confirmRunError) throw new Error(`Failed to confirm allocation run: ${confirmRunError.message}`);

      const draft = await stagePublication(admin, staffId, { allocationRunId: allocationRunId! });
      draftId = draft.id;

      const { data: draftItem } = await admin
        .from('schedule_publication_draft_items')
        .select('verdict')
        .eq('schedule_publication_draft_id', draftId)
        .eq('application_id', importedApplicationId)
        .single();
      // The imported participant has exactly one assignment (the mandatory
      // session) and no mandatory blocker, so this must be publishable.
      expect(draftItem?.verdict).toBe('publishable');

      await confirmPublication(admin, draftId, staffId);

      const { data: publication } = await admin
        .from('schedule_publications')
        .select('id, status, revision_number')
        .eq('application_id', importedApplicationId)
        .eq('status', 'active')
        .single();
      expect(publication).toBeTruthy();
      expect(publication?.revision_number).toBe(1);

      const { data: publishedItems } = await admin
        .from('schedule_publication_items')
        .select('session_id, session_title_en, is_mandatory')
        .eq('schedule_publication_id', publication!.id);
      expect(publishedItems?.some((i) => i.session_id === mandatorySessionId && i.session_title_en === 'Mandatory Integration Session')).toBe(true);

      // -------------------------------------------------------------
      // Stage 4: "invite and claim their account" WITHOUT sending any real
      // email — createUser (no email) + a hand-seeded 'sent' invitation,
      // exactly the pattern established in tests/import/claim-live.test.ts,
      // then the real claimApplication RPC via a real anon-key session.
      // -------------------------------------------------------------
      const { data: participantAuthUser, error: participantAuthError } = await admin.auth.admin.createUser({
        email: participantEmail,
        password: PASSWORD,
        email_confirm: true,
      });
      if (participantAuthError || !participantAuthUser.user) {
        throw new Error(`Failed to create participant auth user: ${participantAuthError?.message}`);
      }
      participantAuthUserId = participantAuthUser.user.id;

      const { error: invitationError } = await admin.from('participant_invitations').insert({
        application_id: importedApplicationId,
        imported_email: participantEmail,
        invited_user_id: participantAuthUserId,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });
      if (invitationError) throw new Error(`Failed to seed invitation: ${invitationError.message}`);

      const participantSession = await signInAs(participantEmail);
      await claimApplication(importedApplicationId, participantSession);

      const { data: claimedApp } = await admin
        .from('applications')
        .select('applicant_id')
        .eq('id', importedApplicationId)
        .single();
      expect(claimedApp?.applicant_id).toBe(participantAuthUserId);

      // -------------------------------------------------------------
      // Stage 5 + 6: signed in as the claimed participant (the very same
      // session used to claim — no re-sign-in needed, matching how a real
      // browser session persists across the claim redirect), replicate
      // /schedule's actual query sequence exactly as
      // src/app/[locale]/(participant)/schedule/page.tsx performs it, and
      // assert it returns the published schedule.
      // -------------------------------------------------------------
      const { data: ownApplication, error: ownApplicationError } = await participantSession
        .from('applications')
        .select('id')
        .eq('applicant_id', participantAuthUserId)
        .maybeSingle();
      expect(ownApplicationError).toBeNull();
      expect(ownApplication?.id).toBe(importedApplicationId);

      const { data: ownPublication, error: ownPublicationError } = await participantSession
        .from('schedule_publications')
        .select('id')
        .eq('application_id', ownApplication!.id)
        .eq('status', 'active')
        .maybeSingle();
      expect(ownPublicationError).toBeNull();
      expect(ownPublication?.id).toBe(publication!.id);

      const { data: ownItems, error: ownItemsError } = await participantSession
        .from('schedule_publication_items')
        .select('*')
        .eq('schedule_publication_id', ownPublication!.id);
      expect(ownItemsError).toBeNull();
      expect(ownItems?.length).toBeGreaterThan(0);
      expect(ownItems?.some((i) => i.session_id === mandatorySessionId && i.session_title_en === 'Mandatory Integration Session')).toBe(true);

      // Negative control: an unrelated authenticated session (the staff
      // account, which owns no application) must see nothing via the exact
      // same RLS-gated query shape — proves the read above is genuinely
      // gated by applicant_id = auth.uid(), not merely by is-authenticated.
      const staffSession = await signInAs(STAFF_EMAIL);
      const { data: staffOwnApplication } = await staffSession
        .from('applications')
        .select('id')
        .eq('applicant_id', staffId)
        .maybeSingle();
      expect(staffOwnApplication).toBeNull();
    },
    600000
  );
});
