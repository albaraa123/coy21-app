// tests/import/confirm-import-live.test.ts
//
// Live integration coverage for Task 15 — the only place in this plan that
// writes to applications/application_answers for real. Covers both Step 6
// (chunked import correctness) and Step 7 (concurrent confirmation is
// blocked) in one file, since both need the identical expensive fixture
// (a validated multi-chunk batch) and splitting them would double the setup
// cost against the live project for no clarity gain.
//
// No local Postgres exists for this project — every test here runs against
// the live linked Supabase project. All seeded/created rows are removed in
// afterAll, and the suite is written to be safely re-runnable back-to-back.
//
// Calls the *ForCaller variants rather than the exported 'use server'
// actions: 'use server' functions call next/headers' cookies() via
// requireAgendaStaffCaller, which throws outside a real Next.js request —
// the same constraint documented in tests/import/validation-live.test.ts and
// tests/agenda/authorization.test.ts. Every DB-touching line still runs; only
// the cookie-based auth wrapper is swapped for the service-role client.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import type { Database } from '@/types/database';
import { runValidationForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/preview/actions';
import {
  startImportForCaller,
  resumeImportBatchForCaller,
  processImportChunkForCaller,
} from '@/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions';
import { CHUNK_SIZE } from '@/lib/validation/import';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const STAFF_EMAIL = 'confirm-import-live-staff@test.local';
const PASSWORD = 'password123';
const EMAIL_PREFIX = 'confirm-import-live-';

// Enough real rows to force multiple chunks against the REAL CHUNK_SIZE
// (250) rather than lowering the constant via a test-only override — the
// plan explicitly prefers a faithful test. 260 new rows + the fixtures below
// puts the batch just over one chunk, so chunk 2 is non-empty and small.
const NEW_ROW_COUNT = CHUNK_SIZE + 10;

const EXISTING_UNCLAIMED_EMAIL = `${EMAIL_PREFIX}existing-unclaimed@example.com`;
const INVALID_ROW_EMAIL = 'not-an-email-at-all';
const DUP_IN_FILE_EMAIL = `${EMAIL_PREFIX}dup-in-file@example.com`;
// Raw (un-normalized) cell text for the row that proves gap #2: raw_value
// must preserve the original casing/whitespace, while normalized_value is
// trimmed and lowercased.
const RAW_MIXED_CASE_EMAIL = `  ${EMAIL_PREFIX}RawCase@Example.COM  `;
const NORMALIZED_MIXED_CASE_EMAIL = `${EMAIL_PREFIX}rawcase@example.com`;
const RAW_INTERESTS = 'Climate Policy; Renewables ;Water';

let staffId: string;
let importBatchId: string;
let importColumnMappingIds: string[] = [];
let storagePath: string;
let unclaimedApplicationId: string;

async function buildWorkbookBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Participants');
  ws.addRow(['Full Name', 'Email', 'Organization', 'Interests']);

  // Row 2: matches a pre-seeded unclaimed application -> update path.
  ws.addRow(['Existing Unclaimed Updated', EXISTING_UNCLAIMED_EMAIL, 'Updated Org', 'Climate Policy']);
  // Row 3: invalid email -> skipped_error.
  ws.addRow(['Invalid Person', INVALID_ROW_EMAIL, 'Some Org', '']);
  // Row 4: first occurrence of a within-file duplicate -> imported.
  ws.addRow(['Dup First', DUP_IN_FILE_EMAIL, 'Dup Org', '']);
  // Row 5: second occurrence -> skipped (duplicate_in_file).
  ws.addRow(['Dup Second', DUP_IN_FILE_EMAIL, 'Dup Org Two', '']);
  // Row 6: raw-vs-normalized fixture for gap #2.
  ws.addRow(['Raw Case Person', RAW_MIXED_CASE_EMAIL, 'Raw Org', RAW_INTERESTS]);

  // Rows 7..: bulk filler to push the batch past one chunk.
  for (let i = 0; i < NEW_ROW_COUNT; i++) {
    ws.addRow([`Bulk Person ${i}`, `${EMAIL_PREFIX}bulk-${i}@example.com`, `Org ${i}`, 'Renewables']);
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// Full NO ACTION FK-dependency list on applications(id), per Task 0's own
// authoritative derivation (supabase/migrations/20260726109500_tmp_introspect.sql
// and 20260726109600_rollback_safety_fixes.sql). None of these cascade —
// each must be cleared before an applications row can be deleted, or the
// delete is silently refused (this file's own applications.delete() below
// checked no error return), leaking the applications row and, transitively,
// this file's import_batches row too since the batch delete in afterAll only
// runs after applications are gone.
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

// Every application this suite could possibly create or touch, resolved at
// cleanup time from the batch's own import_rows plus an email-prefix sweep —
// so cleanup is correct even if a test failed partway through.
async function deleteAllSuiteApplications() {
  const ids = new Set<string>();
  if (importBatchId) {
    const { data: rows } = await admin
      .from('import_rows')
      .select('destination_application_id')
      .eq('import_batch_id', importBatchId);
    for (const r of rows ?? []) {
      if (r.destination_application_id) ids.add(r.destination_application_id);
    }
    const { data: byBatch } = await admin.from('applications').select('id').eq('import_batch_id', importBatchId);
    for (const a of byBatch ?? []) ids.add(a.id);
  }
  const { data: byEmail } = await admin.from('applications').select('id').like('imported_email', `${EMAIL_PREFIX}%`);
  for (const a of byEmail ?? []) ids.add(a.id);
  if (unclaimedApplicationId) ids.add(unclaimedApplicationId);

  const idList = [...ids];
  if (idList.length === 0) return;

  for (const t of FK_DEPENDENT_TABLES) {
    await deleteChecked(t, 'application_id', idList);
  }
  // application_answers.application_id and application_status_history both
  // cascade on applications delete; import_rows.destination_application_id is
  // `on delete set null` (Task 2's fix), so those two are safe as-is.
  // application_answers.import_batch_id, however, is a SEPARATE, direct
  // NO ACTION FK to import_batches(id) — independent of the application_id
  // cascade (confirmed live: a re-import/idempotent-upsert can leave an
  // application_answers row tagged with a dead batch's import_batch_id even
  // though its application_id now belongs to a different, still-active
  // batch). That stray tag blocks this file's own import_batches delete in
  // afterAll unless cleared here first, scoped to this file's own batch.
  if (importBatchId) {
    const { error: answersErr } = await admin.from('application_answers').delete().eq('import_batch_id', importBatchId);
    if (answersErr) console.error('cleanup: delete on application_answers (by import_batch_id) failed', answersErr);
  }
  await deleteChecked('applications', 'id', idList);
}

// Reuse-on-failure instead of a bare createUser: verified directly against
// this live project (Task 28's final verification pass) that
// admin.auth.admin.deleteUser can fail with the documented
// AuthRetryableFetchError (500, empty message) PERSISTENTLY, not just
// transiently, for a given user id — a prior run's staff user surviving
// this file's own afterAll would otherwise wedge every subsequent run with
// "email already registered" and no self-healing path. Same fix applied to
// tests/rls/import.test.ts and tests/import/downstream-processing-live.test.ts
// in the same pass.
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

  // Defensive: applications.imported_email has a unique partial index for
  // unclaimed rows (applications_imported_email_unclaimed_unique), so an
  // orphaned row from an interrupted prior run with this exact fixed email
  // would otherwise collide with the insert below. Clear first — a no-op on
  // a clean run.
  //
  // A bare applications delete is not enough: verified directly against this
  // live project (Task 28's gate 6 verification pass) that an orphaned row
  // from THIS exact fixture can be referenced by allocation_issues /
  // allocation_assignments / cluster_memberships / participant_feature_
  // snapshots / schedule_publications / schedule_publication_draft_items —
  // the complete set of non-cascading application_id FK tables — if a prior
  // run got far enough to trigger downstream processing before being
  // interrupted. Clear all six before the applications delete, same pattern
  // as downstream-processing-live.test.ts's equivalent fixture cleanup.
  {
    const { data: orphaned } = await admin
      .from('applications')
      .select('id')
      .eq('imported_email', EXISTING_UNCLAIMED_EMAIL)
      .is('applicant_id', null);
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

  // Pre-existing unclaimed application, so row 2 exercises the update path
  // (snapshot capture + overwrite) rather than the insert path.
  const { data: unclaimedApp } = await admin
    .from('applications')
    .insert({
      applicant_id: null,
      imported_email: EXISTING_UNCLAIMED_EMAIL,
      status: 'accepted',
      organization: 'Original Org Before Import',
    })
    .select('id')
    .single();
  unclaimedApplicationId = unclaimedApp!.id;

  const buffer = await buildWorkbookBuffer();
  storagePath = `confirm-import-live-test/${Date.now()}.xlsx`;
  const { error: uploadError } = await admin.storage.from('import-uploads').upload(storagePath, buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (uploadError) throw new Error(`Failed to upload test workbook: ${uploadError.message}`);

  const { data: batch } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffId,
      original_filename: 'confirm-import-live-test.xlsx',
      file_checksum: 'confirm-import-live-test-checksum',
      storage_path: storagePath,
      sheet_name: 'Participants',
      status: 'validating',
      unique_identifier_column_index: 1,
    })
    .select('id')
    .single();
  importBatchId = batch!.id;

  const { data: mappings } = await admin
    .from('import_column_mappings')
    .insert([
      { import_batch_id: importBatchId, source_column_index: 0, source_column_header: 'Full Name', target_kind: 'core_field', target_key: 'full_name' },
      { import_batch_id: importBatchId, source_column_index: 1, source_column_header: 'Email', target_kind: 'core_field', target_key: 'email' },
      { import_batch_id: importBatchId, source_column_index: 2, source_column_header: 'Organization', target_kind: 'known_answer', target_key: 'organization' },
      { import_batch_id: importBatchId, source_column_index: 3, source_column_header: 'Interests', target_kind: 'known_answer', target_key: 'interests' },
    ])
    .select('id');
  importColumnMappingIds = (mappings ?? []).map((m) => m.id);

  // Run the real Task 14 validation pass so import_rows is populated exactly
  // as production would leave it before confirm.
  await runValidationForCaller(importBatchId, { userId: staffId, service: admin });
}, 300000);

afterAll(async () => {
  await deleteAllSuiteApplications();

  const { data: rowsToDelete } = await admin.from('import_rows').select('id').eq('import_batch_id', importBatchId);
  if (rowsToDelete && rowsToDelete.length > 0) {
    await deleteChecked(
      'import_rows',
      'id',
      rowsToDelete.map((r) => r.id)
    );
  }
  if (importColumnMappingIds.length > 0) {
    const { error: mappingErr } = await admin.from('import_column_mappings').delete().in('id', importColumnMappingIds);
    if (mappingErr) console.error('cleanup: delete on import_column_mappings failed', mappingErr);
  }
  if (importBatchId) {
    const { error: batchErr } = await admin.from('import_batches').delete().eq('id', importBatchId);
    if (batchErr) console.error('cleanup: delete on import_batches failed', batchErr);
  }
  await admin.storage.from('import-uploads').remove([storagePath]).catch(() => undefined);

  // audit_logs.actor_id references profiles(id) with NO `on delete` clause
  // (pre-existing Phase 5 gap in 20260722200245_agenda_enums_and_reference_tables.sql,
  // out of scope to fix here). This suite writes many audit rows for staffId
  // — both from the server actions and from inside the RPC itself — and the
  // auth-user hard-delete below fails with an opaque 500 if they still exist.
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

describe('confirm import (live)', () => {
  it('imports a multi-chunk batch correctly, is idempotent, resumable, and lock-protected', async () => {
    const caller = { userId: staffId, service: admin };

    // ---------------------------------------------------------------
    // Step 7 (part 1): a second startImport on the same batch is rejected.
    // ---------------------------------------------------------------
    const { lockToken } = await startImportForCaller(importBatchId, caller);
    expect(lockToken).toBeTruthy();
    await expect(startImportForCaller(importBatchId, caller)).rejects.toThrow(/not ready to import|already being imported/i);

    const { data: afterStart } = await admin
      .from('import_batches')
      .select('status, confirmed_at, processing_lock_token, row_count')
      .eq('id', importBatchId)
      .single();
    expect(afterStart?.status).toBe('importing');
    expect(afterStart?.confirmed_at).toBeTruthy();
    expect(afterStart?.processing_lock_token).toBe(lockToken);
    const totalRows = afterStart!.row_count!;
    // 5 fixture rows + NEW_ROW_COUNT bulk rows, i.e. strictly more than one
    // chunk — otherwise this test isn't actually exercising chunking.
    expect(totalRows).toBe(5 + NEW_ROW_COUNT);
    expect(totalRows).toBeGreaterThan(CHUNK_SIZE);

    // ---------------------------------------------------------------
    // Step 7 (part 2): a concurrent chunk call with a stale/wrong token is
    // rejected while the real token works.
    // ---------------------------------------------------------------
    const wrongToken = crypto.randomUUID();
    await expect(processImportChunkForCaller({ batchId: importBatchId, lockToken: wrongToken }, caller)).rejects.toThrow(
      /Invalid or superseded processing lock/i
    );

    // Race the true token against a wrong one simultaneously — only the true
    // current-token call may succeed.
    const raced = await Promise.allSettled([
      processImportChunkForCaller({ batchId: importBatchId, lockToken }, caller),
      processImportChunkForCaller({ batchId: importBatchId, lockToken: wrongToken }, caller),
    ]);
    expect(raced[0].status).toBe('fulfilled');
    expect(raced[1].status).toBe('rejected');
    const firstChunk = (raced[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof processImportChunkForCaller>>>).value;
    expect(firstChunk.processedInChunk).toBe(CHUNK_SIZE);
    expect(firstChunk.isComplete).toBe(false);

    // ---------------------------------------------------------------
    // Step 6: resume after manually expiring the lock, and continue from the
    // correct offset (not from zero).
    // ---------------------------------------------------------------
    await admin
      .from('import_batches')
      .update({ processing_lock_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', importBatchId);

    // The old token is now useless even though it still matches, because the
    // lock has expired.
    await expect(processImportChunkForCaller({ batchId: importBatchId, lockToken }, caller)).rejects.toThrow(
      /Processing lock has expired/i
    );

    const { lockToken: resumedToken } = await resumeImportBatchForCaller(importBatchId, caller);
    expect(resumedToken).not.toBe(lockToken);

    const { data: afterResume } = await admin
      .from('import_batches')
      .select('next_chunk_offset')
      .eq('id', importBatchId)
      .single();
    // Resumed from where chunk 1 stopped, not restarted.
    expect(afterResume?.next_chunk_offset).toBe(CHUNK_SIZE);

    // Drive the rest of the import to completion.
    let guard = 0;
    let last = { isComplete: false } as Awaited<ReturnType<typeof processImportChunkForCaller>>;
    while (!last.isComplete && guard++ < 20) {
      last = await processImportChunkForCaller({ batchId: importBatchId, lockToken: resumedToken }, caller);
    }
    expect(last.isComplete).toBe(true);

    // ---------------------------------------------------------------
    // Batch end state.
    // ---------------------------------------------------------------
    const { data: finalBatch } = await admin
      .from('import_batches')
      .select('status, inserted_count, updated_count, skipped_count, completed_at, processing_lock_token, processing_lock_expires_at, next_chunk_offset')
      .eq('id', importBatchId)
      .single();
    expect(finalBatch?.status).toBe('imported');
    expect(finalBatch?.completed_at).toBeTruthy();
    // Lock released on completion.
    expect(finalBatch?.processing_lock_token).toBeNull();
    expect(finalBatch?.processing_lock_expires_at).toBeNull();
    expect(finalBatch?.next_chunk_offset).toBe(totalRows);

    // GAP #1: cumulative totals across BOTH chunks, not just the last one.
    // 1 update (the pre-existing unclaimed application), 2 skips (invalid
    // email + within-file duplicate), everything else inserted.
    expect(finalBatch?.updated_count).toBe(1);
    expect(finalBatch?.skipped_count).toBe(2);
    expect(finalBatch?.inserted_count).toBe(totalRows - 1 - 2);
    // The decisive assertion for gap #1: had counts been overwritten with
    // only the final chunk's tally, inserted_count would be the size of the
    // last chunk (well under CHUNK_SIZE), not the whole-batch total.
    expect(finalBatch!.inserted_count).toBeGreaterThan(CHUNK_SIZE);

    // ---------------------------------------------------------------
    // action_taken stamped on every row.
    // ---------------------------------------------------------------
    const { data: allRows } = await admin
      .from('import_rows')
      .select('excel_row_number, action_taken, destination_application_id, previous_application_snapshot, previous_answers_snapshot')
      .eq('import_batch_id', importBatchId)
      .order('excel_row_number', { ascending: true });
    expect(allRows).toHaveLength(totalRows);
    expect((allRows ?? []).every((r) => r.action_taken !== null)).toBe(true);

    const byRow = new Map((allRows ?? []).map((r) => [r.excel_row_number, r]));
    expect(byRow.get(2)?.action_taken).toBe('updated');
    expect(byRow.get(3)?.action_taken).toBe('skipped_error');
    expect(byRow.get(4)?.action_taken).toBe('inserted');
    expect(byRow.get(5)?.action_taken).toBe('skipped_unchanged'); // within-file duplicate
    expect(byRow.get(6)?.action_taken).toBe('inserted');

    // ---------------------------------------------------------------
    // Update path: snapshot captured BEFORE the overwrite, in-transaction.
    // ---------------------------------------------------------------
    const updatedRow = byRow.get(2)!;
    expect(updatedRow.destination_application_id).toBe(unclaimedApplicationId);
    const snapshot = updatedRow.previous_application_snapshot as Record<string, unknown> | null;
    expect(snapshot).toBeTruthy();
    // The before-image holds the PRE-import value...
    expect(snapshot?.organization).toBe('Original Org Before Import');
    expect(updatedRow.previous_answers_snapshot).toBeTruthy();
    // ...while the live row holds the imported value.
    const { data: updatedApp } = await admin
      .from('applications')
      .select('organization, status, applicant_id, imported_email, import_batch_id')
      .eq('id', unclaimedApplicationId)
      .single();
    expect(updatedApp?.organization).toBe('Updated Org');
    expect(updatedApp?.status).toBe('accepted');
    // Imported/unclaimed applications intentionally keep applicant_id null —
    // ownership is only ever established by Task 21's explicit claim step.
    expect(updatedApp?.applicant_id).toBeNull();

    // ---------------------------------------------------------------
    // Insert path: a real application with a generated number.
    // ---------------------------------------------------------------
    const { data: insertedApp } = await admin
      .from('applications')
      .select('id, applicant_id, imported_email, import_batch_id, status, application_number, organization')
      .eq('imported_email', NORMALIZED_MIXED_CASE_EMAIL)
      .single();
    expect(insertedApp).toBeTruthy();
    expect(insertedApp?.applicant_id).toBeNull();
    expect(insertedApp?.import_batch_id).toBe(importBatchId);
    expect(insertedApp?.status).toBe('accepted');
    expect(insertedApp?.application_number).toMatch(/^RCOY-2026-\d{5,}$/);
    expect(insertedApp?.organization).toBe('Raw Org');

    // ---------------------------------------------------------------
    // GAP #2: raw_value is the ORIGINAL cell text, not the normalized value.
    // ---------------------------------------------------------------
    const { data: answers } = await admin
      .from('application_answers')
      .select('question_key, raw_value, normalized_value, value_type, source, import_batch_id')
      .eq('application_id', insertedApp!.id);
    const answerByKey = new Map((answers ?? []).map((a) => [a.question_key, a]));

    const emailAnswer = answerByKey.get('email')!;
    expect(emailAnswer.normalized_value).toBe(NORMALIZED_MIXED_CASE_EMAIL);
    // The decisive gap #2 assertion: raw_value preserves the untrimmed,
    // mixed-case original cell exactly, and differs from normalized_value.
    expect(emailAnswer.raw_value).toBe(RAW_MIXED_CASE_EMAIL);
    expect(emailAnswer.raw_value).not.toBe(emailAnswer.normalized_value);
    expect(emailAnswer.source).toBe('import');
    expect(emailAnswer.import_batch_id).toBe(importBatchId);

    // Multiselect: raw keeps the original delimited string; normalized is the
    // structured JSON array.
    const interestsAnswer = answerByKey.get('interests')!;
    expect(interestsAnswer.raw_value).toBe(RAW_INTERESTS);
    expect(interestsAnswer.value_type).toBe('multiselect');
    expect(JSON.parse(interestsAnswer.normalized_value!)).toEqual(['Climate Policy', 'Renewables', 'Water']);
    // interests is a real text[] column on applications, so it lands there too.
    const { data: interestsCol } = await admin.from('applications').select('interests').eq('id', insertedApp!.id).single();
    expect(interestsCol?.interests).toEqual(['Climate Policy', 'Renewables', 'Water']);

    // full_name has no applications column and survives only as an answer.
    expect(answerByKey.get('full_name')?.raw_value).toBe('Raw Case Person');

    // ---------------------------------------------------------------
    // application_status_history + audit_logs.
    // ---------------------------------------------------------------
    const { data: insertHistory } = await admin
      .from('application_status_history')
      .select('old_status, new_status, changed_by, note')
      .eq('application_id', insertedApp!.id);
    expect(insertHistory).toHaveLength(1);
    expect(insertHistory![0].old_status).toBeNull();
    expect(insertHistory![0].new_status).toBe('accepted');
    expect(insertHistory![0].changed_by).toBe(staffId);
    expect(insertHistory![0].note).toContain(importBatchId);

    const { data: updateHistory } = await admin
      .from('application_status_history')
      .select('old_status, new_status, note')
      .eq('application_id', unclaimedApplicationId);
    expect(updateHistory).toHaveLength(1);
    expect(updateHistory![0].old_status).toBe('accepted');
    expect(updateHistory![0].new_status).toBe('accepted');

    const { count: insertAuditCount } = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', insertedApp!.id)
      .eq('action', 'import_insert');
    expect(insertAuditCount).toBe(1);

    const { count: updateAuditCount } = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', unclaimedApplicationId)
      .eq('action', 'import_update');
    expect(updateAuditCount).toBe(1);

    const { count: confirmAuditCount } = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', importBatchId)
      .eq('action', 'confirm_import');
    expect(confirmAuditCount).toBe(1);

    const { count: resumeAuditCount } = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', importBatchId)
      .eq('action', 'resume_import');
    expect(resumeAuditCount).toBe(1);

    // ---------------------------------------------------------------
    // Idempotency: calling processImportChunk again after completion is a
    // clean rejection, NOT a duplicate insert.
    // ---------------------------------------------------------------
    const applicationsBefore = (
      await admin.from('applications').select('id', { count: 'exact', head: true }).eq('import_batch_id', importBatchId)
    ).count;

    await expect(
      processImportChunkForCaller({ batchId: importBatchId, lockToken: resumedToken }, caller)
    ).rejects.toThrow(/not importing/i);

    const applicationsAfter = (
      await admin.from('applications').select('id', { count: 'exact', head: true }).eq('import_batch_id', importBatchId)
    ).count;
    expect(applicationsAfter).toBe(applicationsBefore);

    // One application per imported row — no duplicates anywhere in the batch.
    expect(applicationsAfter).toBe(finalBatch!.inserted_count);

    // And exactly one answers row per (application, question_key, source):
    // the unique constraint plus the RPC's upsert guarantee re-application
    // can never fan out duplicate answers.
    const { data: dupCheck } = await admin
      .from('application_answers')
      .select('question_key')
      .eq('application_id', insertedApp!.id);
    const keys = (dupCheck ?? []).map((a) => a.question_key);
    expect(new Set(keys).size).toBe(keys.length);

    // ---------------------------------------------------------------
    // The RPC's own idempotency guard, exercised directly: calling
    // apply_import_row_transactional a second time on a row whose
    // action_taken is already set must return 'already_applied' and touch
    // nothing — this is the safety property the chunk-level rejection above
    // relies on but never itself reaches, since processImportChunkForCaller
    // rejects at the batch-status check before ever calling the RPC again.
    // Without this guard, a mid-chunk retry after a partial failure could
    // insert a second application for the same source row.
    // ---------------------------------------------------------------
    const { data: insertedRow } = await admin
      .from('import_rows')
      .select('id, action_taken')
      .eq('import_batch_id', importBatchId)
      .eq('destination_application_id', insertedApp!.id)
      .single();
    expect(insertedRow?.action_taken).toBe('inserted');

    const answersCountBefore = (
      await admin.from('application_answers').select('id', { count: 'exact', head: true }).eq('application_id', insertedApp!.id)
    ).count;

    const { data: secondApplyOutcome, error: secondApplyError } = await admin.rpc('apply_import_row_transactional', {
      p_import_row_id: insertedRow!.id,
      p_import_batch_id: importBatchId,
      p_actor_id: staffId,
    });
    expect(secondApplyError).toBeNull();
    expect(secondApplyOutcome).toBe('already_applied');

    const applicationsAfterRetry = (
      await admin.from('applications').select('id', { count: 'exact', head: true }).eq('import_batch_id', importBatchId)
    ).count;
    expect(applicationsAfterRetry).toBe(applicationsAfter);

    const answersCountAfter = (
      await admin.from('application_answers').select('id', { count: 'exact', head: true }).eq('application_id', insertedApp!.id)
    ).count;
    expect(answersCountAfter).toBe(answersCountBefore);
  }, 600000);
});
