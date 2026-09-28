// tests/import/downstream-processing-live.test.ts
//
// Live integration coverage for Task 17 — the automatic (but admin-
// configured) downstream feature-extraction -> clustering -> allocation
// trigger that runs after an import batch finishes importing.
//
// No local Postgres exists for this project — every test here runs against
// the live linked Supabase project, same as tests/import/rollback-live.test.ts
// and tests/import/confirm-import-live.test.ts, whose fixture patterns this
// file reuses (real workbook -> real validation -> real chunked import, never
// hand-built import_rows/applications state).
//
// Calls the *ForCaller variant of runDownstreamProcessing rather than the
// exported 'use server' action: 'use server' functions call next/headers'
// cookies() via requireAgendaStaffCaller, which throws outside a real
// Next.js request — the same constraint documented in every other live test
// in this directory.
//
// THE REGRESSION THIS FILE EXISTS TO PROVE (per the plan's own language):
// runFeatureExtraction/runAllocation scope their work by `.eq('status',
// 'accepted')` over the WHOLE applications table — there is no batch-id
// filter anywhere in those functions (confirmed by reading
// src/lib/allocation/run-extraction.ts and run-allocation.ts). So an
// application imported via this batch's flow (status set to 'accepted' by
// apply_import_row_transactional) is automatically picked up by the
// existing, unmodified pipeline with zero glue code required. This suite
// seeds one pre-existing accepted application NOT from this batch to prove
// both directions at once: the imported rows ARE included, and so is the
// pre-existing one (proving there is no accidental narrowing to the batch
// either) — that is the real, documented scoping behavior of the pipeline
// this task must not change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import type { Database } from '@/types/database';
import { runValidationForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/preview/actions';
import { startImportForCaller, processImportChunkForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions';
import { runDownstreamProcessingForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/downstream-actions';
import { deriveSeedFromBatchId } from '@/lib/import/seed-derivation';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const STAFF_EMAIL = 'downstream-live-staff@test.local';
const PASSWORD = 'password123';
const EMAIL_PREFIX = 'downstream-live-';

let staffId: string;
let tagId: string;
let ruleId: string;
let preexistingApplicantUserId: string;
let preexistingApplicationId: string;
const createdBatchIds: string[] = [];
const createdStoragePaths: string[] = [];
const createdFeatureExtractionRunIds: string[] = [];
const createdClusteringRunIds: string[] = [];
const createdAllocationRunIds: string[] = [];

async function buildWorkbook(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Participants');
  ws.addRow(['Full Name', 'Email', 'Organization', 'Interests']);
  for (const r of rows) ws.addRow(r);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Seeds a batch and runs it through the REAL validation + import flow (same
 * as rollback-live.test.ts), so the resulting applications rows are exactly
 * what production writes — including status = 'accepted', which is the
 * column runFeatureExtraction/runAllocation actually filter on.
 */
async function importBatch(
  label: string,
  rows: string[][],
  opts?: { autoProcessDownstream?: boolean; autoProcessClusterK?: number | null }
): Promise<{ batchId: string; applicationIdsByEmail: Map<string, string> }> {
  const buffer = await buildWorkbook(rows);
  const storagePath = `downstream-live-test/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`;
  const { error: uploadError } = await admin.storage.from('import-uploads').upload(storagePath, buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (uploadError) throw new Error(`Failed to upload test workbook: ${uploadError.message}`);
  createdStoragePaths.push(storagePath);

  const { data: batch, error: batchError } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffId,
      original_filename: `downstream-live-${label}.xlsx`,
      file_checksum: `downstream-live-${label}-${Date.now()}`,
      storage_path: storagePath,
      sheet_name: 'Participants',
      status: 'validating',
      unique_identifier_column_index: 1,
      auto_process_downstream: opts?.autoProcessDownstream ?? false,
      auto_process_cluster_k: opts?.autoProcessClusterK ?? null,
    })
    .select('id')
    .single();
  if (batchError) throw new Error(`Failed to create batch: ${batchError.message}`);
  const batchId = batch!.id;
  createdBatchIds.push(batchId);

  const { error: mappingError } = await admin.from('import_column_mappings').insert([
    { import_batch_id: batchId, source_column_index: 0, source_column_header: 'Full Name', target_kind: 'core_field', target_key: 'full_name' },
    { import_batch_id: batchId, source_column_index: 1, source_column_header: 'Email', target_kind: 'core_field', target_key: 'email' },
    { import_batch_id: batchId, source_column_index: 2, source_column_header: 'Organization', target_kind: 'known_answer', target_key: 'organization' },
    { import_batch_id: batchId, source_column_index: 3, source_column_header: 'Interests', target_kind: 'known_answer', target_key: 'interests' },
  ]);
  if (mappingError) throw new Error(`Failed to create mappings: ${mappingError.message}`);

  const caller = { userId: staffId, service: admin };
  await runValidationForCaller(batchId, caller);

  const { lockToken } = await startImportForCaller(batchId, caller);
  let guard = 0;
  for (;;) {
    const result = await processImportChunkForCaller({ batchId, lockToken }, caller);
    if (result.isComplete) break;
    if (++guard > 50) throw new Error('Import did not complete within the expected number of chunks');
  }

  const { data: importRows } = await admin
    .from('import_rows')
    .select('destination_application_id, normalized_row')
    .eq('import_batch_id', batchId);

  const applicationIdsByEmail = new Map<string, string>();
  for (const r of importRows ?? []) {
    const email = (r.normalized_row as { email?: string } | null)?.email;
    if (email && r.destination_application_id) applicationIdsByEmail.set(email, r.destination_application_id);
  }

  return { batchId, applicationIdsByEmail };
}

async function deleteAllocationArtifacts() {
  // allocation_runs cascades to allocation_assignments/allocation_issues,
  // which cascade to allocation_alternatives/allocation_assignment_explanations
  // (verified against supabase/migrations/20260723100000_allocation_tables.sql
  // — every FK from those tables back to allocation_runs/allocation_assignments
  // is `on delete cascade`). Deleting by id here is still explicit (not left
  // purely to a cascade from the staff-profile delete) so a leak surfaces as
  // a foreign-key error rather than being silently masked.
  if (createdAllocationRunIds.length > 0) {
    await admin.from('allocation_runs').delete().in('id', createdAllocationRunIds);
  }
  // clustering_runs cascades to clusters, which cascades to cluster_memberships
  // (verified against 20260723090000_clustering_tables.sql).
  if (createdClusteringRunIds.length > 0) {
    await admin.from('clustering_runs').delete().in('id', createdClusteringRunIds);
  }
  // feature_extraction_runs cascades to participant_feature_snapshots
  // (verified against 20260723080000_feature_extraction_tables.sql).
  if (createdFeatureExtractionRunIds.length > 0) {
    await admin.from('feature_extraction_runs').delete().in('id', createdFeatureExtractionRunIds);
  }
}

async function deleteAllSuiteApplications() {
  const ids = new Set<string>();
  if (preexistingApplicationId) ids.add(preexistingApplicationId);

  for (const batchId of createdBatchIds) {
    const { data: rows } = await admin.from('import_rows').select('destination_application_id').eq('import_batch_id', batchId);
    for (const r of rows ?? []) if (r.destination_application_id) ids.add(r.destination_application_id);
    const { data: byBatch } = await admin.from('applications').select('id').eq('import_batch_id', batchId);
    for (const a of byBatch ?? []) ids.add(a.id);
  }

  const { data: byEmail } = await admin.from('applications').select('id').like('imported_email', `${EMAIL_PREFIX}%`);
  for (const a of byEmail ?? []) ids.add(a.id);

  const idList = [...ids];
  if (idList.length === 0) return;

  for (let i = 0; i < idList.length; i += 100) {
    const slice = idList.slice(i, i + 100);
    // participant_feature_snapshots.application_id is NO ACTION — must be
    // cleared before the applications delete, or it's refused. Already swept
    // by deleteAllocationArtifacts's feature_extraction_runs cascade in the
    // normal case, but this direct delete is kept as a safety net in case a
    // test failed before that cascade ran.
    await admin.from('participant_feature_snapshots').delete().in('application_id', slice);
    await admin.from('cluster_memberships').delete().in('application_id', slice);
    await admin.from('allocation_assignments').delete().in('application_id', slice);
    await admin.from('allocation_issues').delete().in('application_id', slice);
  }
  for (let i = 0; i < idList.length; i += 100) {
    await admin.from('applications').delete().in('id', idList.slice(i, i + 100));
  }
}

// Reuse-on-failure instead of sweep-then-create: verified directly against
// this live project (Task 28's final verification pass) that
// admin.auth.admin.deleteUser can fail with the documented
// AuthRetryableFetchError (500, empty message) PERSISTENTLY, not just
// transiently, for a given user id — retrying does not help, and a prior
// run's user surviving this file's own afterAll would otherwise wedge every
// subsequent run with "email already registered" and no self-healing path.
// Matches the fix applied to tests/rls/import.test.ts in the same pass.
async function getOrCreateFixedUser(email: string) {
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) break;
    const stale = data.users.find((u) => u.email?.toLowerCase() === email);
    if (stale) {
      try {
        await admin.from('audit_logs').delete().eq('actor_id', stale.id);
        const { error: deleteError } = await admin.auth.admin.deleteUser(stale.id);
        if (!deleteError) break;
      } catch {
        // fall through to reuse
      }
      const { error: updateError } = await admin.auth.admin.updateUserById(stale.id, { password: PASSWORD, email_confirm: true });
      if (updateError) throw new Error(`Failed to reuse stale staff user: ${updateError.message}`);
      return stale.id;
    }
    if (data.users.length < perPage) break;
    page += 1;
  }
  const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (createError || !created.user) throw new Error(`Failed to create staff user: ${createError?.message}`);
  return created.user.id;
}

beforeAll(async () => {
  staffId = await getOrCreateFixedUser(STAFF_EMAIL);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  // Sweep any leftover tag/rule from a prior interrupted run of THIS
  // SPECIFIC SUITE before creating fresh — matching getOrCreateFixedUser's
  // own reuse-on-failure rationale above (this file uses fixed
  // identifiers by design, not runId randomization). Rule first (it FKs
  // tag_id with no cascade), then the tag itself, then any orphaned
  // feature snapshots the rule's tag_id might still be referenced by.
  const { data: existingTag } = await admin.from('tags').select('id').eq('code', 'DOWNSTREAM-TEST-TAG').maybeSingle();
  if (existingTag) {
    await admin.from('feature_extraction_rules').delete().eq('tag_id', existingTag.id);
    await admin.from('participant_feature_snapshots').delete().eq('tag_id', existingTag.id);
    await admin.from('tags').delete().eq('id', existingTag.id);
  }

  const { data: tag, error: tagError } = await admin
    .from('tags')
    .insert({ code: 'DOWNSTREAM-TEST-TAG', name_ar: 'وسم', name_en: 'Tag' })
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

  // A pre-existing accepted application NOT part of any import batch —
  // proves runFeatureExtraction/runAllocation scope by status='accepted'
  // across the whole table, not by import_batch_id, which is the exact
  // regression this suite exists to close.
  preexistingApplicantUserId = await getOrCreateFixedUser(`${EMAIL_PREFIX}preexisting@test.local`);
  // A reused user id can carry an orphaned applications row from an
  // interrupted prior run of THIS SPECIFIC SUITE (applications.applicant_id
  // is unique) — and because this suite's whole purpose is exercising
  // feature extraction/clustering/allocation, that orphaned row is
  // plausibly still referenced by exactly those downstream tables, which
  // block a plain applications delete. Clear the full downstream chain
  // before deleting, mirroring deleteAllocationArtifacts's cascade
  // reasoning below but scoped to this one application via a fresh lookup
  // rather than the run-tracking arrays (which don't exist yet at this
  // point in beforeAll).
  {
    // Complete set of non-cascading application_id FK tables, verified
    // against every `references applications(id)` occurrence across
    // supabase/migrations/*.sql (the cascading ones — application_answers,
    // application_status_history, application_notes, participant_invitations
    // — need no explicit clearing here). An earlier version of this fix only
    // cleared 4 of these 6 tables and still failed twice in a row against
    // this same orphaned row before all 6 were identified.
    const { data: orphaned } = await admin.from('applications').select('id').eq('applicant_id', preexistingApplicantUserId);
    for (const app of orphaned ?? []) {
      await admin.from('allocation_issues').delete().eq('application_id', app.id);
      await admin.from('allocation_assignments').delete().eq('application_id', app.id);
      await admin.from('cluster_memberships').delete().eq('application_id', app.id);
      await admin.from('participant_feature_snapshots').delete().eq('application_id', app.id);
      await admin.from('schedule_publications').delete().eq('application_id', app.id);
      await admin.from('schedule_publication_draft_items').delete().eq('application_id', app.id);
      await admin.from('applications').delete().eq('id', app.id);
    }
  }

  const { data: preexistingApp, error: preexistingAppError } = await admin
    .from('applications')
    .insert({ applicant_id: preexistingApplicantUserId, status: 'accepted', interests: ['Renewables'] })
    .select('id')
    .single();
  if (preexistingAppError || !preexistingApp) throw new Error(`Failed to seed pre-existing application: ${preexistingAppError?.message}`);
  preexistingApplicationId = preexistingApp.id;
}, 300000);

afterAll(async () => {
  await deleteAllocationArtifacts();
  await deleteAllSuiteApplications();

  for (const batchId of createdBatchIds) {
    const { data: rowsToDelete } = await admin.from('import_rows').select('id').eq('import_batch_id', batchId);
    const ids = (rowsToDelete ?? []).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      await admin.from('import_rows').delete().in('id', ids.slice(i, i + 100));
    }
    await admin.from('import_column_mappings').delete().eq('import_batch_id', batchId);
    await admin.from('import_batches').delete().eq('id', batchId);
  }

  if (createdStoragePaths.length > 0) {
    await admin.storage.from('import-uploads').remove(createdStoragePaths).catch(() => undefined);
  }

  // Any feature_extraction_runs/clustering_runs/allocation_runs left over
  // from a failed assertion mid-test (not captured in the tracked-id arrays
  // because the throw happened before the id was recorded) are swept by
  // run_by, matching the run-behavioral.test.ts / rollback-live.test.ts
  // precedent of a belt-and-suspenders sweep in addition to id-tracked
  // deletes.
  await admin.from('allocation_runs').delete().eq('run_by', staffId);
  await admin.from('clustering_runs').delete().eq('run_by', staffId);
  await admin.from('feature_extraction_runs').delete().eq('run_by', staffId);

  if (ruleId) await admin.from('feature_extraction_rules').delete().eq('id', ruleId);
  if (tagId) await admin.from('tags').delete().eq('id', tagId);

  // audit_logs.actor_id has no FK cascade (pre-existing Phase 5 gap,
  // documented identically in rollback-live.test.ts) — must be cleared
  // before the hard-deletes below or they 500.
  const actorIds = [staffId, preexistingApplicantUserId].filter(Boolean);
  if (actorIds.length > 0) {
    await admin.from('audit_logs').delete().in('actor_id', actorIds);
  }

  // deleteUser's second argument is shouldSoftDelete (default false) — the
  // SDK already hard-deletes with no second argument. Never pass `true`.
  for (const id of [staffId, preexistingApplicantUserId]) {
    if (!id) continue;
    const result = await admin.auth.admin.deleteUser(id);
    if (result.error) console.error('afterAll cleanup: user delete returned an error', result.error);
  }
}, 300000);

describe('downstream processing (live)', () => {
  it('runs feature extraction -> clustering -> allocation, correctly scoped to status=accepted applications project-wide (imported batch rows + pre-existing accepted row, both included)', async () => {
    const emails = [0, 1, 2].map((i) => `${EMAIL_PREFIX}scoping-${i}@example.com`);
    const { batchId, applicationIdsByEmail } = await importBatch(
      'scoping',
      emails.map((e, i) => [`Scoping Person ${i}`, e, `Org ${i}`, 'Renewables']),
      { autoProcessDownstream: true, autoProcessClusterK: 2 }
    );
    const importedAppIds = emails.map((e) => applicationIdsByEmail.get(e)!);
    expect(importedAppIds.every(Boolean)).toBe(true);

    const caller = { userId: staffId, service: admin };
    const result = await runDownstreamProcessingForCaller(batchId, caller);

    expect(result.downstreamStatus).toBe('completed');
    expect(result.featureExtractionRunId).toBeTruthy();
    expect(result.clusteringRunId).toBeTruthy();
    expect(result.allocationRunId).toBeTruthy();
    createdFeatureExtractionRunIds.push(result.featureExtractionRunId!);
    createdClusteringRunIds.push(result.clusteringRunId!);
    createdAllocationRunIds.push(result.allocationRunId!);

    // feature_extraction_runs: the imported applications AND the
    // pre-existing accepted application must all appear — proving the
    // regression this task exists to close (no accidental batch-id
    // narrowing, and no accidental global-only scan that misses the batch).
    const { data: snapshots } = await admin
      .from('participant_feature_snapshots')
      .select('application_id')
      .eq('feature_extraction_run_id', result.featureExtractionRunId!);
    const snapshotAppIds = new Set((snapshots ?? []).map((s) => s.application_id));
    for (const id of importedAppIds) expect(snapshotAppIds.has(id)).toBe(true);
    expect(snapshotAppIds.has(preexistingApplicationId)).toBe(true);

    // clustering_runs: completed status, memberships cover the same set of
    // applications that had feature snapshots.
    const { data: clusteringRun } = await admin.from('clustering_runs').select('status, k').eq('id', result.clusteringRunId!).single();
    expect(clusteringRun?.status).toBe('completed');
    expect(clusteringRun?.k).toBe(2);

    const { data: memberships } = await admin
      .from('cluster_memberships')
      .select('application_id, clusters!inner(clustering_run_id)')
      .eq('clusters.clustering_run_id', result.clusteringRunId!);
    const memberAppIds = new Set((memberships ?? []).map((m) => m.application_id));
    for (const id of importedAppIds) expect(memberAppIds.has(id)).toBe(true);
    expect(memberAppIds.has(preexistingApplicationId)).toBe(true);

    // allocation_runs: draft status (never auto-confirmed).
    const { data: allocationRun } = await admin.from('allocation_runs').select('status').eq('id', result.allocationRunId!).single();
    expect(allocationRun?.status).toBe('draft');

    // import_batches reflects completion.
    const { data: finalBatch } = await admin
      .from('import_batches')
      .select('status, downstream_status')
      .eq('id', batchId)
      .single();
    expect(finalBatch?.downstream_status).toBe('completed');
    expect(finalBatch?.status).toBe('completed');
  }, 300000);

  it('deriveSeedFromBatchId is reproducible for the same batch id across two calls', async () => {
    const { batchId } = await importBatch('seed-repro', [[`Seed Person`, `${EMAIL_PREFIX}seed-repro@example.com`, 'Org', 'Renewables']]);
    const first = deriveSeedFromBatchId(batchId);
    const second = deriveSeedFromBatchId(batchId);
    expect(first).toBe(second);
  }, 300000);

  it('a forced clustering-stage failure (k exceeding available feature vectors) leaves the completed feature_extraction_runs row intact and sets downstream_status = failed', async () => {
    // runFeatureExtraction scores every 'accepted' application in the whole
    // shared disposable project (Phase 7G-K test-isolation finding, same
    // root cause as tests/import/schedule-integration-live.test.ts's
    // NON_CONTENDED_TEST_CAPACITY fix) -- k=99 assumed "this test's own row
    // is the only feature vector", which was only ever true when the
    // shared vector pool was small/truncated. The keyset-pagination fix
    // (src/lib/allocation/paginated-fetch.ts) now correctly returns the
    // FULL pool, so a small k like 99 no longer reliably exceeds
    // vectors.length. Forcing the failure now requires k comfortably above
    // any realistic shared-project vector count, not a small fixed number.
    const CLUSTER_K_ABOVE_SHARED_POOL = 50000;
    const { batchId } = await importBatch(
      'forced-fail',
      [[`Forced Fail Person`, `${EMAIL_PREFIX}forced-fail@example.com`, 'Org', 'Renewables']],
      { autoProcessDownstream: true, autoProcessClusterK: CLUSTER_K_ABOVE_SHARED_POOL }
    );

    const caller = { userId: staffId, service: admin };
    await expect(runDownstreamProcessingForCaller(batchId, caller)).rejects.toThrow();

    const { data: finalBatch } = await admin
      .from('import_batches')
      .select('status, downstream_status')
      .eq('id', batchId)
      .single();
    expect(finalBatch?.downstream_status).toBe('failed');
    expect(finalBatch?.status).toBe('completed_with_warnings');

    // The feature_extraction_runs row from the (successful) first stage must
    // still exist — clustering failing must not roll it back.
    const { data: extractionRuns } = await admin.from('feature_extraction_runs').select('id').eq('run_by', staffId).order('run_at', { ascending: false }).limit(1);
    expect(extractionRuns && extractionRuns.length > 0).toBe(true);
    if (extractionRuns && extractionRuns[0]) createdFeatureExtractionRunIds.push(extractionRuns[0].id);

    // The clustering_runs row itself was still created (with status
    // 'failed') — track it for cleanup.
    const { data: clusteringRuns } = await admin
      .from('clustering_runs')
      .select('id, status')
      .eq('run_by', staffId)
      .eq('status', 'failed')
      .order('run_at', { ascending: false })
      .limit(1);
    expect(clusteringRuns && clusteringRuns.length > 0).toBe(true);
    expect(clusteringRuns?.[0]?.status).toBe('failed');
    if (clusteringRuns && clusteringRuns[0]) createdClusteringRunIds.push(clusteringRuns[0].id);
  }, 300000);

  it('rejects a concurrent call while downstream processing is already running for the batch', async () => {
    // Code-quality review finding: there is no processing_lock_token-style
    // mechanism here the way Task 15's chunk loop has one, so two concurrent
    // calls (a double-click past the client-side disabled guard, a second
    // tab, a replayed request) would otherwise each independently call
    // runFeatureExtraction/runClustering/runAllocation, producing duplicate
    // runs. Fixed with a conditional-UPDATE claim on downstream_status.
    // Simulate "already running" by seeding downstream_status directly
    // (cheaper and more deterministic than racing two real invocations,
    // which would be flaky under network/DB timing) — the guard reads this
    // exact column, so this exercises the real code path.
    const { batchId } = await importBatch(
      'reentrancy',
      [[`Reentrancy Person`, `${EMAIL_PREFIX}reentrancy@example.com`, 'Org', 'Renewables']],
      { autoProcessDownstream: true, autoProcessClusterK: 1 }
    );
    await admin.from('import_batches').update({ downstream_status: 'clustering' }).eq('id', batchId);

    const caller = { userId: staffId, service: admin };
    await expect(runDownstreamProcessingForCaller(batchId, caller)).rejects.toThrow(/already running/i);

    // Nothing was written: no feature_extraction_runs row was created by
    // the rejected call (the guard fires before runFeatureExtraction is
    // ever invoked), and downstream_status is untouched from the seeded
    // value — proving the claim's conditional UPDATE never fired either.
    const { data: batchAfter } = await admin.from('import_batches').select('downstream_status').eq('id', batchId).single();
    expect(batchAfter?.downstream_status).toBe('clustering');
  }, 300000);
});
