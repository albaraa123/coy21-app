// tests/import/rollback-live.test.ts
//
// Live integration coverage for Task 16 — the import-batch rollback path,
// the only place in this plan that DELETES applications and restores
// overwritten ones from snapshots. Covers all four cases from the plan's
// Step 5.
//
// No local Postgres exists for this project — every test here runs against
// the live linked Supabase project, same as
// tests/import/confirm-import-live.test.ts, whose fixture patterns this file
// reuses. All seeded/created rows are removed in afterAll, and the suite is
// written to be safely re-runnable back-to-back.
//
// Calls the *ForCaller variants rather than the exported 'use server'
// actions: 'use server' functions call next/headers' cookies() via
// requireAgendaStaffCaller, which throws outside a real Next.js request —
// the same constraint documented in confirm-import-live.test.ts. Every
// DB-touching line still runs; only the cookie-based auth wrapper is
// swapped for the service-role client.
//
// Each case builds its OWN batch (rather than sharing one) because a
// rollback is a whole-batch operation and a blocked-rollback case must be
// able to assert that NOTHING in its batch was touched — impossible to
// state cleanly if cases shared applications.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { runValidationForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/preview/actions';
import {
  startImportForCaller,
  processImportChunkForCaller,
} from '@/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions';
import { rollbackImportBatchForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/rollback-action';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const STAFF_EMAIL = `rollback-live-${runId}-staff@test.local`;
const PASSWORD = 'password123';
// Every application this suite creates carries this prefix in
// imported_email, so cleanup can sweep by prefix even after a mid-test
// failure.
const EMAIL_PREFIX = `rollback-live-${runId}-`;

let staffId: string;
const createdBatchIds: string[] = [];
const createdStoragePaths: string[] = [];
// Applications seeded directly by the suite (the pre-existing rows the
// update path targets), tracked separately from import-created ones.
const seededApplicationIds: string[] = [];
const createdTagIds: string[] = [];

interface BatchFixture {
  batchId: string;
  applicationIdsByEmail: Map<string, string>;
}

async function buildWorkbook(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Participants');
  ws.addRow(['Full Name', 'Email', 'Organization', 'Interests']);
  for (const r of rows) ws.addRow(r);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Seed a batch and run it through the REAL Task 14 validation + Task 15
 * import flow, so the import_rows/applications state being rolled back is
 * exactly what production would produce — including the
 * previous_application_snapshot / previous_answers_snapshot values that the
 * rollback depends on. Building that state by hand would let the test pass
 * against snapshots the real importer never writes.
 */
async function importBatch(label: string, rows: string[][]): Promise<BatchFixture> {
  const buffer = await buildWorkbook(rows);
  const storagePath = `rollback-live-test/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`;
  const { error: uploadError } = await admin.storage.from('import-uploads').upload(storagePath, buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (uploadError) throw new Error(`Failed to upload test workbook: ${uploadError.message}`);
  createdStoragePaths.push(storagePath);

  const { data: batch, error: batchError } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffId,
      original_filename: `rollback-live-${label}.xlsx`,
      file_checksum: `rollback-live-${label}-${Date.now()}`,
      storage_path: storagePath,
      sheet_name: 'Participants',
      status: 'validating',
      unique_identifier_column_index: 1,
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

// Full NO ACTION FK-dependency list on applications(id), per Task 0's own
// authoritative derivation (supabase/migrations/20260726109500_tmp_introspect.sql
// and 20260726109600_rollback_safety_fixes.sql). This file previously only
// covered participant_feature_snapshots — the other 6 are equally NO ACTION
// and can equally block the applications delete under full-suite-load
// contention (e.g. a concurrently-running allocation test writing an
// allocation_assignments/cluster_memberships row against one of this file's
// seeded applications before this afterAll runs).
const FK_DEPENDENT_TABLES = [
  'participant_feature_snapshots',
  'cluster_memberships',
  'allocation_assignments',
  'schedule_publications',
  'schedule_publication_draft_items',
  'allocation_issues',
  'attendance_records',
  'scan_attempts',
] as const;

async function deleteChecked(table: keyof Database['public']['Tables'], column: string, ids: string[]) {
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await admin
      .from(table)
      .delete()
      .in(column, ids.slice(i, i + 100));
    if (error) console.error(`cleanup: delete on ${table} failed`, error);
  }
}

async function deleteAllSuiteApplications() {
  const ids = new Set<string>(seededApplicationIds);

  for (const batchId of createdBatchIds) {
    const { data: rows } = await admin
      .from('import_rows')
      .select('destination_application_id')
      .eq('import_batch_id', batchId);
    for (const r of rows ?? []) if (r.destination_application_id) ids.add(r.destination_application_id);

    const { data: byBatch } = await admin.from('applications').select('id').eq('import_batch_id', batchId);
    for (const a of byBatch ?? []) ids.add(a.id);
  }

  const { data: byEmail } = await admin.from('applications').select('id').like('imported_email', `${EMAIL_PREFIX}%`);
  for (const a of byEmail ?? []) ids.add(a.id);

  const idList = [...ids];
  if (idList.length === 0) return;

  // NO ACTION FK tables must be cleared BEFORE their applications, or the
  // delete is refused and cleanup silently leaks rows into the next run.
  for (const t of FK_DEPENDENT_TABLES) {
    await deleteChecked(t, 'application_id', idList);
  }
  // participant_invitations cascades, but is deleted explicitly so a
  // failure here surfaces rather than being masked by the cascade.
  await deleteChecked('participant_invitations', 'application_id', idList);
  // application_answers / application_status_history cascade (verified live).
  await deleteChecked('applications', 'id', idList);
}

// Reuse-on-failure: verified directly against this live project (Task 28's
// final verification pass, gate 6) that admin.auth.admin.deleteUser can
// fail with the documented AuthRetryableFetchError (500, empty message)
// PERSISTENTLY, not just transiently — a bare createUser with no sweep at
// all (as this file previously had) throws "already registered" forever
// once a prior run's staff user survives its own afterAll. Reuses the
// existing stale user (resetting its password) instead of depending on
// deletion succeeding at all. Same fix applied to every other live test in
// this directory earlier in this pass.
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
      if (updateError) throw new Error(`Failed to reuse stale user ${email}: ${updateError.message}`);
      return stale.id;
    }
    if (data.users.length < perPage) break;
    page += 1;
  }
  const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (createError || !created.user) throw new Error(`Failed to create user ${email}: ${createError?.message}`);
  return created.user.id;
}

beforeAll(async () => {
  staffId = await getOrCreateFixedUser(STAFF_EMAIL);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
}, 300000);

afterAll(async () => {
  await deleteAllSuiteApplications();

  for (const batchId of createdBatchIds) {
    const { data: rowsToDelete } = await admin.from('import_rows').select('id').eq('import_batch_id', batchId);
    await deleteChecked(
      'import_rows',
      'id',
      (rowsToDelete ?? []).map((r) => r.id)
    );
    const { error: mappingErr } = await admin.from('import_column_mappings').delete().eq('import_batch_id', batchId);
    if (mappingErr) console.error('cleanup: delete on import_column_mappings failed', mappingErr);
    const { error: batchErr } = await admin.from('import_batches').delete().eq('id', batchId);
    if (batchErr) console.error('cleanup: delete on import_batches failed', batchErr);
  }

  if (createdStoragePaths.length > 0) {
    await admin.storage.from('import-uploads').remove(createdStoragePaths).catch(() => undefined);
  }

  // Feature-extraction runs created for Case 3. participant_feature_snapshots
  // cascades from the run, and was already cleared per-application above.
  const { error: runErr } = await admin.from('feature_extraction_runs').delete().eq('run_by', staffId);
  if (runErr) console.error('cleanup: delete on feature_extraction_runs failed', runErr);

  // Tags must go AFTER the snapshots that reference them (tag_id is a plain
  // reference with no cascade), which the run delete above has just removed.
  if (createdTagIds.length > 0) {
    const { error: tagErr } = await admin.from('tags').delete().in('id', createdTagIds);
    if (tagErr) console.error('cleanup: delete on tags failed', tagErr);
  }

  // audit_logs.actor_id references profiles(id) with NO `on delete` clause
  // (pre-existing Phase 5 gap discovered in Task 14, out of scope to fix
  // here). This suite writes many audit rows for staffId — from the server
  // actions AND from inside both RPCs — and the auth-user hard-delete below
  // fails with an opaque 500 if they still exist.
  if (staffId) {
    const { error: auditErr } = await admin.from('audit_logs').delete().eq('actor_id', staffId);
    if (auditErr) console.error('cleanup: delete on audit_logs failed', auditErr);
  }

  // deleteUser's second argument is shouldSoftDelete (default false) — the
  // SDK already hard-deletes with no second argument. Passing `true` would
  // request a SOFT delete, leaving the email reserved and breaking the next
  // run. Do not add one.
  if (staffId) {
    const result = await admin.auth.admin.deleteUser(staffId);
    if (result.error) console.error('afterAll cleanup: staff delete returned an error', result.error);
  }
}, 300000);

describe('import batch rollback (live)', () => {
  it('Case 1: rolls back a pure-insert batch, deleting the applications it created', async () => {
    const emails = [0, 1, 2].map((i) => `${EMAIL_PREFIX}insert-${i}@example.com`);
    const { batchId, applicationIdsByEmail } = await importBatch(
      'case1',
      emails.map((e, i) => [`Insert Person ${i}`, e, `Org ${i}`, 'Renewables'])
    );

    const appIds = emails.map((e) => applicationIdsByEmail.get(e)!);
    expect(appIds.every(Boolean)).toBe(true);

    const { data: before } = await admin.from('applications').select('id').in('id', appIds);
    expect(before).toHaveLength(3);

    await rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin });

    // The applications the import created are gone.
    const { data: after } = await admin.from('applications').select('id').in('id', appIds);
    expect(after ?? []).toHaveLength(0);

    // Their answers cascaded away with them.
    const { count: answerCount } = await admin
      .from('application_answers')
      .select('id', { count: 'exact', head: true })
      .in('application_id', appIds);
    expect(answerCount ?? 0).toBe(0);

    // The batch is marked rolled_back and the staging rows survive as an
    // audit trail with their destination reference nulled (the `on delete
    // set null` FK) and action_taken cleared.
    const { data: batchAfter } = await admin
      .from('import_batches')
      .select('status, inserted_count, updated_count')
      .eq('id', batchId)
      .single();
    expect(batchAfter?.status).toBe('rolled_back');
    expect(batchAfter?.inserted_count).toBe(0);

    const { data: rowsAfter } = await admin
      .from('import_rows')
      .select('action_taken, destination_application_id')
      .eq('import_batch_id', batchId);
    expect(rowsAfter?.length).toBeGreaterThan(0);
    for (const r of rowsAfter ?? []) {
      expect(r.action_taken).toBeNull();
      expect(r.destination_application_id).toBeNull();
    }

    // A second rollback of the same batch is refused rather than silently
    // re-running against already-deleted rows.
    await expect(rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin })).rejects.toThrow(
      /already been rolled back/i
    );
  }, 300000);

  it('Case 2: rolls back an update-path batch, restoring prior field and answer values', async () => {
    const email = `${EMAIL_PREFIX}update-target@example.com`;

    // A pre-existing unclaimed application the import will UPDATE (not
    // insert), with a known prior organization and a prior answer set.
    const { data: seeded, error: seedError } = await admin
      .from('applications')
      .insert({
        applicant_id: null,
        imported_email: email,
        status: 'accepted',
        organization: 'Original Org Before Import',
        city: 'Original City',
      })
      .select('id')
      .single();
    if (seedError) throw new Error(`Failed to seed application: ${seedError.message}`);
    const appId = seeded!.id;
    seededApplicationIds.push(appId);

    // A pre-existing answer that the import will OVERWRITE, and a manual
    // answer on a key the import never touches. Both must come back exactly.
    const { error: answerError } = await admin.from('application_answers').insert([
      {
        application_id: appId,
        question_key: 'organization',
        normalized_value: 'Original Org Before Import',
        raw_value: 'Original Org Before Import',
        value_type: 'text',
        source: 'import',
      },
      {
        application_id: appId,
        question_key: 'manual_note',
        normalized_value: 'A manual note predating the import',
        raw_value: 'A manual note predating the import',
        value_type: 'text',
        source: 'manual',
      },
    ]);
    if (answerError) throw new Error(`Failed to seed answers: ${answerError.message}`);

    const { data: answersBefore } = await admin
      .from('application_answers')
      .select('id, question_key, normalized_value, source')
      .eq('application_id', appId)
      .order('question_key');
    expect(answersBefore).toHaveLength(2);

    const { batchId } = await importBatch('case2', [
      ['Update Person', email, 'Overwritten Org From Import', 'Climate Policy'],
    ]);

    // Confirm the import really took the UPDATE path against our seeded row.
    const { data: rowAfterImport } = await admin
      .from('import_rows')
      .select('action_taken, destination_application_id, previous_application_snapshot')
      .eq('import_batch_id', batchId)
      .single();
    expect(rowAfterImport?.action_taken).toBe('updated');
    expect(rowAfterImport?.destination_application_id).toBe(appId);
    expect(rowAfterImport?.previous_application_snapshot).toBeTruthy();

    // And that it actually changed the values we're about to restore.
    const { data: midImport } = await admin
      .from('applications')
      .select('organization')
      .eq('id', appId)
      .single();
    expect(midImport?.organization).toBe('Overwritten Org From Import');

    // The import created a NEW answer row for a key that did not exist
    // before ('interests'), which rollback must DELETE rather than revert.
    const { data: answersMid } = await admin
      .from('application_answers')
      .select('question_key')
      .eq('application_id', appId);
    const midKeys = (answersMid ?? []).map((a) => a.question_key).sort();
    expect(midKeys).toContain('interests');

    await rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin });

    // The application still EXISTS (update path restores, never deletes)...
    const { data: restored } = await admin
      .from('applications')
      .select('id, organization, city, status')
      .eq('id', appId)
      .maybeSingle();
    expect(restored).toBeTruthy();
    // ...with its pre-import field values back.
    expect(restored?.organization).toBe('Original Org Before Import');
    expect(restored?.city).toBe('Original City');

    // The answer set is exactly the pre-import set: same rows, same ids,
    // same values — and the import-created 'interests' key is GONE, not
    // merely reverted. This is the core of the snapshot-restore semantics.
    const { data: answersAfter } = await admin
      .from('application_answers')
      .select('id, question_key, normalized_value, source')
      .eq('application_id', appId)
      .order('question_key');

    expect(answersAfter).toHaveLength(2);
    expect((answersAfter ?? []).map((a) => a.question_key).sort()).toEqual(['manual_note', 'organization']);
    // Original row ids are preserved by the restore.
    expect((answersAfter ?? []).map((a) => a.id).sort()).toEqual((answersBefore ?? []).map((a) => a.id).sort());

    const restoredOrg = (answersAfter ?? []).find((a) => a.question_key === 'organization');
    expect(restoredOrg?.normalized_value).toBe('Original Org Before Import');
    // The pre-existing manual answer survived untouched.
    const restoredManual = (answersAfter ?? []).find((a) => a.question_key === 'manual_note');
    expect(restoredManual?.normalized_value).toBe('A manual note predating the import');
    expect(restoredManual?.source).toBe('manual');

    // A status-history row documents the restoration.
    const { data: history } = await admin
      .from('application_status_history')
      .select('note')
      .eq('application_id', appId)
      .like('note', '%Restored by rollback%');
    expect((history ?? []).length).toBeGreaterThan(0);
  }, 300000);

  it('Case 3: refuses the whole rollback when a downstream pipeline reference exists, touching nothing', async () => {
    const emails = [0, 1].map((i) => `${EMAIL_PREFIX}downstream-${i}@example.com`);
    const { batchId, applicationIdsByEmail } = await importBatch(
      'case3',
      emails.map((e, i) => [`Downstream Person ${i}`, e, `Org ${i}`, 'Renewables'])
    );
    const appIds = emails.map((e) => applicationIdsByEmail.get(e)!);
    expect(appIds.every(Boolean)).toBe(true);

    // Create a REAL downstream reference of the same shape runFeatureExtraction
    // produces. Inserted directly rather than via runFeatureExtraction because
    // that helper runs globally over every application in the project and
    // depends on seeded tags/extraction rules — it would make this case slow
    // and dependent on unrelated fixture state, while the thing under test is
    // purely "a participant_feature_snapshots row referencing a batch
    // application blocks rollback".
    // The suite creates its own tag rather than reusing an arbitrary
    // existing one: the project may legitimately have zero tags, and
    // depending on unrelated seed data would make this case fail for a
    // reason that has nothing to do with rollback behaviour.
    const { data: tag, error: tagError } = await admin
      .from('tags')
      .insert({
        code: `rollback-live-tag-${Date.now()}`,
        name_ar: 'وسم اختبار',
        name_en: 'Rollback Live Test Tag',
      })
      .select('id')
      .single();
    if (tagError) throw new Error(`Failed to create test tag: ${tagError.message}`);
    createdTagIds.push(tag!.id);

    const { data: run, error: runError } = await admin
      .from('feature_extraction_runs')
      .insert({ rules_version: 1, application_count: 1, run_by: staffId })
      .select('id')
      .single();
    if (runError) throw new Error(`Failed to create extraction run: ${runError.message}`);

    const { error: snapError } = await admin.from('participant_feature_snapshots').insert({
      feature_extraction_run_id: run!.id,
      application_id: appIds[0],
      tag_id: tag.id,
      weight: 0.5,
    });
    if (snapError) throw new Error(`Failed to create feature snapshot: ${snapError.message}`);

    // Capture full pre-rollback state so we can prove nothing moved.
    const { data: appsBefore } = await admin
      .from('applications')
      .select('id, organization, status')
      .in('id', appIds)
      .order('id');
    const { data: rowsBefore } = await admin
      .from('import_rows')
      .select('id, action_taken, destination_application_id')
      .eq('import_batch_id', batchId)
      .order('id');
    const { data: batchBefore } = await admin.from('import_batches').select('status').eq('id', batchId).single();

    await expect(rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin })).rejects.toThrow(
      /participant_feature_snapshots/i
    );

    // NOTHING was touched: applications still present and unchanged...
    const { data: appsAfter } = await admin
      .from('applications')
      .select('id, organization, status')
      .in('id', appIds)
      .order('id');
    expect(appsAfter).toHaveLength(2);
    expect(appsAfter).toEqual(appsBefore);

    // ...import_rows still carry their applied state...
    const { data: rowsAfter } = await admin
      .from('import_rows')
      .select('id, action_taken, destination_application_id')
      .eq('import_batch_id', batchId)
      .order('id');
    expect(rowsAfter).toEqual(rowsBefore);

    // ...and the batch was NOT marked rolled_back.
    const { data: batchAfter } = await admin.from('import_batches').select('status').eq('id', batchId).single();
    expect(batchAfter?.status).toBe(batchBefore?.status);
    expect(batchAfter?.status).not.toBe('rolled_back');
  }, 300000);

  it('Case 4: refuses the whole rollback when an invitation has been sent, touching nothing', async () => {
    const emails = [0, 1].map((i) => `${EMAIL_PREFIX}invited-${i}@example.com`);
    const { batchId, applicationIdsByEmail } = await importBatch(
      'case4',
      emails.map((e, i) => [`Invited Person ${i}`, e, `Org ${i}`, 'Renewables'])
    );
    const appIds = emails.map((e) => applicationIdsByEmail.get(e)!);
    expect(appIds.every(Boolean)).toBe(true);

    // A sent invitation — no downstream pipeline reference at all, so this
    // case isolates the Task 3 gap: participant_invitations.application_id
    // CASCADES (verified live), so without the RPC's explicit status check
    // this row would be silently destroyed along with its application.
    const { data: invitation, error: invError } = await admin
      .from('participant_invitations')
      .insert({
        application_id: appIds[0],
        imported_email: emails[0],
        status: 'sent',
        sent_at: new Date().toISOString(),
        sent_by: staffId,
      })
      .select('id, status, sent_at')
      .single();
    if (invError) throw new Error(`Failed to create invitation: ${invError.message}`);

    const { data: appsBefore } = await admin
      .from('applications')
      .select('id, organization, status')
      .in('id', appIds)
      .order('id');
    const { data: batchBefore } = await admin.from('import_batches').select('status').eq('id', batchId).single();

    // The error must NAME the invitation as the blocker, not fail generically
    // — the admin has to know to revoke it first.
    await expect(rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin })).rejects.toThrow(
      /participant_invitations/i
    );
    await expect(rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin })).rejects.toThrow(
      /not_sent|revoke/i
    );

    // The applications were NOT deleted...
    const { data: appsAfter } = await admin
      .from('applications')
      .select('id, organization, status')
      .in('id', appIds)
      .order('id');
    expect(appsAfter).toHaveLength(2);
    expect(appsAfter).toEqual(appsBefore);

    // ...and the invitation row itself survived intact (the cascade never
    // fired, because the delete never happened).
    const { data: invAfter } = await admin
      .from('participant_invitations')
      .select('id, status, sent_at')
      .eq('id', invitation!.id)
      .maybeSingle();
    expect(invAfter).toBeTruthy();
    expect(invAfter?.status).toBe('sent');
    expect(invAfter).toEqual(invitation);

    const { data: batchAfter } = await admin.from('import_batches').select('status').eq('id', batchId).single();
    expect(batchAfter?.status).toBe(batchBefore?.status);
    expect(batchAfter?.status).not.toBe('rolled_back');

    // A 'not_sent' invitation must NOT block: flip it and confirm the
    // rollback now succeeds, proving the check keys on status rather than on
    // the mere existence of an invitation row.
    await admin.from('participant_invitations').update({ status: 'not_sent', sent_at: null }).eq('id', invitation!.id);
    await rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin });

    const { data: appsGone } = await admin.from('applications').select('id').in('id', appIds);
    expect(appsGone ?? []).toHaveLength(0);
    // The not_sent invitation cascaded away with its application, which is
    // correct: an unsent invitation has no external side effect.
    const { data: invGone } = await admin
      .from('participant_invitations')
      .select('id')
      .eq('id', invitation!.id)
      .maybeSingle();
    expect(invGone).toBeNull();
  }, 300000);

  it('Case 5: refuses rollback for a downstream reference on an UPDATED (pre-existing) application, not just an inserted one', async () => {
    // Pins the scope-UNION fix (code-quality review finding, Task 16):
    // an application the batch merely UPDATES keeps its ORIGINAL
    // import_batch_id (the apply path's update branch never writes it —
    // see apply_import_row_transactional), so a naive
    // `applications.import_batch_id = p_batch_id` scope filter would MISS
    // it entirely, and a rollback could then delete/restore around a live
    // downstream reference on an application it doesn't even know is in
    // scope. Case 3 only exercises this on an INSERTED application, whose
    // import_batch_id does match a naive filter — so the whole suite would
    // still pass even if the UNION's second arm (matching via
    // import_rows.destination_application_id) were deleted. This case
    // would not.
    const email = `${EMAIL_PREFIX}update-downstream@example.com`;

    const { data: seeded, error: seedError } = await admin
      .from('applications')
      .insert({ applicant_id: null, imported_email: email, status: 'accepted', organization: 'Pre-existing Org' })
      .select('id')
      .single();
    if (seedError) throw new Error(`Failed to seed application: ${seedError.message}`);
    const appId = seeded!.id;
    seededApplicationIds.push(appId);

    const { batchId } = await importBatch('case5', [['Update Downstream Person', email, 'Updated Org', 'Renewables']]);

    const { data: rowAfterImport } = await admin
      .from('import_rows')
      .select('action_taken, destination_application_id')
      .eq('import_batch_id', batchId)
      .single();
    expect(rowAfterImport?.action_taken).toBe('updated');
    expect(rowAfterImport?.destination_application_id).toBe(appId);

    // Confirm the premise: the updated application's import_batch_id is
    // NOT this batch's id (it was seeded without one, so it's null) — a
    // batch-id-only scope filter would not find it.
    const { data: appMidImport } = await admin.from('applications').select('import_batch_id').eq('id', appId).single();
    expect(appMidImport?.import_batch_id).not.toBe(batchId);

    const { data: tag, error: tagError } = await admin
      .from('tags')
      .insert({ code: `rollback-live-tag-case5-${Date.now()}`, name_ar: 'وسم اختبار', name_en: 'Rollback Live Test Tag Case 5' })
      .select('id')
      .single();
    if (tagError) throw new Error(`Failed to create test tag: ${tagError.message}`);
    createdTagIds.push(tag!.id);

    const { data: run, error: runError } = await admin
      .from('feature_extraction_runs')
      .insert({ rules_version: 1, application_count: 1, run_by: staffId })
      .select('id')
      .single();
    if (runError) throw new Error(`Failed to create extraction run: ${runError.message}`);

    const { error: snapError } = await admin
      .from('participant_feature_snapshots')
      .insert({ feature_extraction_run_id: run!.id, application_id: appId, tag_id: tag.id, weight: 0.5 });
    if (snapError) throw new Error(`Failed to create feature snapshot: ${snapError.message}`);

    const { data: appBefore } = await admin.from('applications').select('id, organization, status').eq('id', appId).single();

    await expect(rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin })).rejects.toThrow(
      /participant_feature_snapshots/i
    );

    // Nothing touched: the updated application still holds its post-import
    // (not pre-import) values, proving the rollback never reached the
    // restore step for it.
    const { data: appAfter } = await admin.from('applications').select('id, organization, status').eq('id', appId).single();
    expect(appAfter).toEqual(appBefore);

    const { data: batchAfter } = await admin.from('import_batches').select('status').eq('id', batchId).single();
    expect(batchAfter?.status).not.toBe('rolled_back');
  }, 300000);
});
