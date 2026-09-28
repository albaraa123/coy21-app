// tests/import/reimport-fingerprint-live.test.ts
//
// Live integration coverage for Task 25 — wiring import_rows.row_fingerprint
// into apply_import_row_transactional so an unchanged re-import is classified
// 'skipped_unchanged' instead of pointlessly rewriting the application.
//
// This is the design spec's "Same row content across different uploads" rule
// (docs/superpowers/specs/2026-07-25-accepted-participants-import-design.md,
// "Idempotency and concurrency rules"): "re-importing the same person with
// identical answers does not create a duplicate application_answers history
// or a spurious application_status_history entry."
//
// The test deliberately drives TWO SEPARATE BATCHES end-to-end through the
// real Task 14 validation + Task 15 import flow. That is the whole point: the
// skip must work ACROSS import_batches, which is precisely what the existing
// within-batch 'already_applied' guard does NOT cover, and what the
// duplicate_in_file skip does not cover either. Building the second batch's
// import_rows by hand would test the assertion rather than the feature.
//
// No local Postgres exists for this project — every test here runs against
// the live linked Supabase project, same as
// tests/import/confirm-import-live.test.ts and rollback-live.test.ts, whose
// fixture patterns this file reuses. All seeded/created rows are removed in
// afterAll, and the suite is written to be safely re-runnable back-to-back.
//
// Calls the *ForCaller variants rather than the exported 'use server'
// actions: 'use server' functions call next/headers' cookies() via
// requireAgendaStaffCaller, which throws outside a real Next.js request —
// the same constraint documented in confirm-import-live.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
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

const STAFF_EMAIL = 'reimport-fp-live-staff@test.local';
const PASSWORD = 'password123';
const EMAIL_PREFIX = 'reimport-fp-live-';

// The person whose content stays identical across both imports -> must be
// skipped_unchanged on the second import.
const UNCHANGED_EMAIL = `${EMAIL_PREFIX}unchanged@example.com`;
// The person whose organization changes between imports -> must still take
// the normal update path (the regression check that the skip is not
// over-eager).
const CHANGED_EMAIL = `${EMAIL_PREFIX}changed@example.com`;

let staffId: string;
const createdBatchIds: string[] = [];
const createdStoragePaths: string[] = [];

interface BatchFixture {
  batchId: string;
  rowsByEmail: Map<string, { id: string; actionTaken: string | null; destinationApplicationId: string | null }>;
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
 * Seed a batch and run it through the REAL validation + import flow, exactly
 * as rollback-live.test.ts does, so the import_rows/applications state under
 * test is what production actually produces.
 */
async function importBatch(label: string, rows: string[][]): Promise<BatchFixture> {
  const buffer = await buildWorkbook(rows);
  const storagePath = `reimport-fp-live-test/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`;
  const { error: uploadError } = await admin.storage.from('import-uploads').upload(storagePath, buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (uploadError) throw new Error(`Failed to upload test workbook: ${uploadError.message}`);
  createdStoragePaths.push(storagePath);

  const { data: batch, error: batchError } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffId,
      original_filename: `reimport-fp-live-${label}.xlsx`,
      file_checksum: `reimport-fp-live-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    .select('id, action_taken, destination_application_id, normalized_row')
    .eq('import_batch_id', batchId);

  const rowsByEmail = new Map<string, { id: string; actionTaken: string | null; destinationApplicationId: string | null }>();
  for (const r of importRows ?? []) {
    const email = (r.normalized_row as { email?: string } | null)?.email;
    if (email) {
      rowsByEmail.set(email, {
        id: r.id,
        actionTaken: r.action_taken,
        destinationApplicationId: r.destination_application_id,
      });
    }
  }

  return { batchId, rowsByEmail };
}

// Full NO ACTION FK-dependency list on applications(id), per Task 0's own
// authoritative derivation (supabase/migrations/20260726109500_tmp_introspect.sql
// and 20260726109600_rollback_safety_fixes.sql). This file previously only
// covered participant_invitations (which actually cascades) and missed every
// NO ACTION table, including participant_feature_snapshots — any of these
// can block the applications delete under full-suite-load contention.
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
  const ids = new Set<string>();

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

  for (const t of FK_DEPENDENT_TABLES) {
    await deleteChecked(t, 'application_id', idList);
  }
  // participant_invitations cascades, but is deleted explicitly so a
  // failure here surfaces rather than being masked by the cascade.
  await deleteChecked('participant_invitations', 'application_id', idList);
  // application_answers / application_status_history cascade.
  await deleteChecked('applications', 'id', idList);
}

// Reuse-on-failure: a sweep-then-create was not enough — verified directly
// against this live project (Task 28's gate 6 verification pass) that
// admin.auth.admin.deleteUser can fail with the documented
// AuthRetryableFetchError (500, empty message) PERSISTENTLY, not just
// transiently, so a sweep whose delete attempt fails still leaves createUser
// throwing "already registered" on every subsequent run. Reuses the
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
  // Every step independently try/caught — the same precedent Task 20's fix
  // (31fb96f) established after a thrown rejection from one cleanup step was
  // found to skip every step after it, leaking real test data. Cleanup must
  // be best-effort and exhaustive, not all-or-nothing.
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`afterAll cleanup step failed: ${label}`, err);
    }
  };

  await step('delete suite applications', deleteAllSuiteApplications);

  await step('delete import batches/rows/mappings', async () => {
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
  });

  await step('remove storage objects', async () => {
    if (createdStoragePaths.length > 0) {
      await admin.storage.from('import-uploads').remove(createdStoragePaths);
    }
  });

  // audit_logs.actor_id references profiles(id) with NO `on delete` clause
  // (pre-existing Phase 5 gap, out of scope here). This suite writes audit
  // rows for staffId from the server actions AND from inside both RPCs, and
  // the auth-user hard-delete below fails with an opaque 500 if they remain.
  await step('delete staff audit_logs', async () => {
    if (staffId) {
      const { error: auditErr } = await admin.from('audit_logs').delete().eq('actor_id', staffId);
      if (auditErr) console.error('cleanup: delete on audit_logs failed', auditErr);
    }
  });

  // deleteUser's second argument is shouldSoftDelete (default false) — the
  // SDK already hard-deletes with no second argument. Passing `true` would
  // request a SOFT delete, leaving the email reserved and breaking the next
  // run. Do not add one.
  await step('delete staff user', async () => {
    if (staffId) {
      const result = await admin.auth.admin.deleteUser(staffId);
      if (result.error) console.error('afterAll cleanup: staff delete returned an error', result.error);
    }
  });
}, 300000);

describe('re-import fingerprint idempotency (live)', () => {
  it('skips an unchanged re-import, still updates a changed one, and survives rollback correctly', async () => {
    const caller = { userId: staffId, service: admin };

    // =================================================================
    // BATCH 1 — the original import. Both people are brand new, so both
    // take the INSERT path and neither can possibly be fingerprint-skipped
    // (point 4 of the fix: the check must never apply to the insert path).
    // =================================================================
    const batch1 = await importBatch('batch1', [
      ['Unchanged Person', UNCHANGED_EMAIL, 'Original Org', 'Climate Policy'],
      ['Changed Person', CHANGED_EMAIL, 'Original Org', 'Climate Policy'],
    ]);

    const unchangedRow1 = batch1.rowsByEmail.get(UNCHANGED_EMAIL)!;
    const changedRow1 = batch1.rowsByEmail.get(CHANGED_EMAIL)!;
    expect(unchangedRow1.actionTaken).toBe('inserted');
    expect(changedRow1.actionTaken).toBe('inserted');

    const unchangedAppId = unchangedRow1.destinationApplicationId!;
    const changedAppId = changedRow1.destinationApplicationId!;
    expect(unchangedAppId).toBeTruthy();
    expect(changedAppId).toBeTruthy();

    // The insert path must have recorded the fingerprint — this is what
    // makes the second import's comparison possible at all.
    const { data: appAfter1 } = await admin
      .from('applications')
      .select('last_import_row_fingerprint, organization')
      .eq('id', unchangedAppId)
      .single();
    expect(appAfter1?.last_import_row_fingerprint).toBeTruthy();
    expect(appAfter1?.organization).toBe('Original Org');
    // It must equal the staging row's fingerprint, not some other hash.
    const { data: stagingRow1 } = await admin
      .from('import_rows')
      .select('row_fingerprint')
      .eq('id', unchangedRow1.id)
      .single();
    expect(appAfter1?.last_import_row_fingerprint).toBe(stagingRow1?.row_fingerprint);

    // Capture the exact post-batch-1 state we will later prove was NOT
    // disturbed by the unchanged re-import.
    const { data: answersAfter1 } = await admin
      .from('application_answers')
      .select('id, question_key, normalized_value, updated_at')
      .eq('application_id', unchangedAppId)
      .order('question_key', { ascending: true });
    expect((answersAfter1 ?? []).length).toBeGreaterThan(0);

    const { count: historyCountAfter1 } = await admin
      .from('application_status_history')
      .select('id', { count: 'exact', head: true })
      .eq('application_id', unchangedAppId);
    expect(historyCountAfter1).toBe(1); // the insert's own 'created' entry

    // =================================================================
    // BATCH 2 — a DIFFERENT batch, identical content for the unchanged
    // person, changed organization for the other. Both now resolve to
    // existing unclaimed applications, so both reach the update path's
    // fingerprint comparison.
    // =================================================================
    const batch2 = await importBatch('batch2', [
      // Byte-identical to batch 1's row for this person.
      ['Unchanged Person', UNCHANGED_EMAIL, 'Original Org', 'Climate Policy'],
      // Organization genuinely changed.
      ['Changed Person', CHANGED_EMAIL, 'Updated Org', 'Climate Policy'],
    ]);

    const unchangedRow2 = batch2.rowsByEmail.get(UNCHANGED_EMAIL)!;
    const changedRow2 = batch2.rowsByEmail.get(CHANGED_EMAIL)!;

    // ---------------------------------------------------------------
    // THE HEADLINE ASSERTION: identical content across different batches
    // is classified skipped_unchanged, per the design spec.
    // ---------------------------------------------------------------
    expect(unchangedRow2.actionTaken).toBe('skipped_unchanged');
    // ...and the row still records which application it resolved to, so the
    // skip is traceable rather than anonymous.
    expect(unchangedRow2.destinationApplicationId).toBe(unchangedAppId);

    // REGRESSION CHECK: genuinely changed content must still take the full
    // update path. A skip here would mean silently dropping an admin's edit.
    expect(changedRow2.actionTaken).toBe('updated');
    const { data: changedApp } = await admin
      .from('applications')
      .select('organization, last_import_row_fingerprint')
      .eq('id', changedAppId)
      .single();
    expect(changedApp?.organization).toBe('Updated Org');
    // Its fingerprint moved on to the new content.
    const { data: changedStaging2 } = await admin
      .from('import_rows')
      .select('row_fingerprint')
      .eq('id', changedRow2.id)
      .single();
    expect(changedApp?.last_import_row_fingerprint).toBe(changedStaging2?.row_fingerprint);

    // ---------------------------------------------------------------
    // The skip must have touched NOTHING on the unchanged application.
    // ---------------------------------------------------------------
    // 1. No before-image snapshot captured — there was nothing to snapshot,
    //    and a snapshot would make the row look restorable to rollback.
    const { data: skippedRowFull } = await admin
      .from('import_rows')
      .select('previous_application_snapshot, previous_answers_snapshot')
      .eq('id', unchangedRow2.id)
      .single();
    expect(skippedRowFull?.previous_application_snapshot).toBeNull();
    expect(skippedRowFull?.previous_answers_snapshot).toBeNull();

    // 2. NO new application_status_history row — the spec's "spurious
    //    application_status_history entry" prohibition, stated literally.
    const { count: historyCountAfter2 } = await admin
      .from('application_status_history')
      .select('id', { count: 'exact', head: true })
      .eq('application_id', unchangedAppId);
    expect(historyCountAfter2).toBe(historyCountAfter1);

    // 3. application_answers untouched — same row IDs prove no
    //    delete+reinsert happened, and same updated_at proves the upsert's
    //    `do update` branch never fired either.
    const { data: answersAfter2 } = await admin
      .from('application_answers')
      .select('id, question_key, normalized_value, updated_at')
      .eq('application_id', unchangedAppId)
      .order('question_key', { ascending: true });
    expect(answersAfter2).toEqual(answersAfter1);

    // 4. The application row itself is unchanged, and importantly its
    //    import_batch_id still points at BATCH 1 — the skip did not
    //    re-attribute the record to the batch that skipped it.
    const { data: appAfter2 } = await admin
      .from('applications')
      .select('organization, last_import_row_fingerprint, import_batch_id')
      .eq('id', unchangedAppId)
      .single();
    expect(appAfter2?.organization).toBe('Original Org');
    expect(appAfter2?.last_import_row_fingerprint).toBe(appAfter1?.last_import_row_fingerprint);
    expect(appAfter2?.import_batch_id).toBe(batch1.batchId);

    // 5. An audit trail STILL exists for the skip — a no-op outcome is
    //    still a processed row, and this plan audits every admin action.
    const { data: skipAudits } = await admin
      .from('audit_logs')
      .select('action, entity_type, entity_id, actor_id, metadata')
      .eq('entity_id', unchangedAppId)
      .eq('action', 'import_skip_unchanged');
    expect(skipAudits).toHaveLength(1);
    expect(skipAudits![0].entity_type).toBe('application');
    expect(skipAudits![0].actor_id).toBe(staffId);
    const skipMeta = skipAudits![0].metadata as Record<string, unknown>;
    expect(skipMeta.batchId).toBe(batch2.batchId);
    expect(skipMeta.importRowId).toBe(unchangedRow2.id);
    expect(skipMeta.rowFingerprint).toBe(appAfter1?.last_import_row_fingerprint);

    // 6. And no update-path audit was written for it in batch 2.
    const { count: updateAuditCount } = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', unchangedAppId)
      .eq('action', 'import_update');
    expect(updateAuditCount).toBe(0);

    // 7. The skip rolls up into skipped_count, not updated_count.
    const { data: batch2Final } = await admin
      .from('import_batches')
      .select('inserted_count, updated_count, skipped_count')
      .eq('id', batch2.batchId)
      .single();
    expect(batch2Final?.inserted_count).toBe(0);
    expect(batch2Final?.updated_count).toBe(1); // the changed person
    expect(batch2Final?.skipped_count).toBe(1); // the unchanged person

    // =================================================================
    // ROLLBACK of batch 2 must IGNORE the skipped_unchanged row entirely.
    // =================================================================
    await rollbackImportBatchForCaller(batch2.batchId, caller);

    // The unchanged application still exists and was not restored/deleted —
    // rollback correctly treated it as out of scope.
    const { data: unchangedAfterRollback } = await admin
      .from('applications')
      .select('id, organization, last_import_row_fingerprint')
      .eq('id', unchangedAppId)
      .maybeSingle();
    expect(unchangedAfterRollback).toBeTruthy();
    expect(unchangedAfterRollback?.organization).toBe('Original Org');
    // Its fingerprint is untouched — batch 2 never wrote it, so batch 2's
    // rollback must not clear it.
    expect(unchangedAfterRollback?.last_import_row_fingerprint).toBe(appAfter1?.last_import_row_fingerprint);

    // No restoration audit was written for the skipped row's application.
    const { count: restoreAuditCount } = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', unchangedAppId)
      .eq('action', 'import_rollback_restore');
    expect(restoreAuditCount).toBe(0);

    // And the skipped row's action_taken stamp SURVIVES the rollback (the
    // loop only clears 'inserted'/'updated' rows), preserving the audit
    // trail that this row was evaluated and skipped.
    const { data: skippedRowAfterRollback } = await admin
      .from('import_rows')
      .select('action_taken')
      .eq('id', unchangedRow2.id)
      .single();
    expect(skippedRowAfterRollback?.action_taken).toBe('skipped_unchanged');

    // Meanwhile the genuinely-updated row WAS restored: organization back to
    // the pre-batch-2 value, and — the load-bearing part of this fix — its
    // fingerprint restored to batch 1's, NOT left claiming batch 2's content.
    const { data: changedAfterRollback } = await admin
      .from('applications')
      .select('organization, last_import_row_fingerprint')
      .eq('id', changedAppId)
      .single();
    expect(changedAfterRollback?.organization).toBe('Original Org');
    const { data: changedStaging1 } = await admin
      .from('import_rows')
      .select('row_fingerprint')
      .eq('id', changedRow1.id)
      .single();
    // Batch 1's fingerprint is back, so re-importing batch 1's content would
    // now correctly skip, and re-importing batch 2's content would correctly
    // update — the invariant that makes a rolled-back batch re-importable.
    expect(changedAfterRollback?.last_import_row_fingerprint).toBe(changedStaging1?.row_fingerprint);
    expect(changedAfterRollback?.last_import_row_fingerprint).not.toBe(changedStaging2?.row_fingerprint);

    // =================================================================
    // BATCH 3 — the decisive rollback-interaction proof. Re-import batch
    // 2's exact content AFTER rolling batch 2 back. Had rollback left the
    // fingerprint set, this would be silently skipped and the admin could
    // never re-apply a batch they had just undone.
    // =================================================================
    const batch3 = await importBatch('batch3', [
      ['Changed Person', CHANGED_EMAIL, 'Updated Org', 'Climate Policy'],
    ]);
    const changedRow3 = batch3.rowsByEmail.get(CHANGED_EMAIL)!;
    expect(changedRow3.actionTaken).toBe('updated');

    const { data: changedAfterReimport } = await admin
      .from('applications')
      .select('organization')
      .eq('id', changedAppId)
      .single();
    expect(changedAfterReimport?.organization).toBe('Updated Org');
  }, 600000);
});
