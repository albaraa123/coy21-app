// tests/participants/import-preview-classification-live.test.ts
//
// Live coverage for Task 8 of
// docs/superpowers/plans/2026-09-30-import-classification-approval.md
// ("Classification edit during import preview", spec §3.3) —
// updateRowParticipantTypeForCaller (src/app/[locale]/(admin)/participants/
// import/[batchId]/preview/actions.ts), exercised against the real database.
//
// Scope reminder (per the plan): this edits import_rows.normalized_row
// (jsonb) BEFORE apply_import_row_transactional ever runs. No `applications`
// row exists yet at this point in the flow, so none of the reclassify/
// reissue/QR/email machinery covered by classification-edit-live.test.ts
// (Task 4) is reachable from here — this test only ever touches import_rows.
//
// The plan's own Step 6 assumed no live DB would be available in this
// environment and asked to disclose that live verification wasn't possible.
// That assumption was wrong for this worktree (.env.local has real, live
// Supabase credentials for a scratch project), so this test replaces that
// disclosure with real verification instead, following the exact fixture
// pattern established in tests/import/claimed-update-gate-live.test.ts:
// build a real import_batches/import_column_mappings row, upload a real
// workbook to storage, run the real runValidationForCaller to populate
// real import_rows, then call the action under test directly with an
// already-authenticated { userId, service } caller (service-role client),
// exactly as 'use server' actions cannot be invoked outside a Next.js
// request context — see that file's own comment for the full rationale.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  runValidationForCaller,
  updateRowParticipantTypeForCaller,
} from '@/app/[locale]/(admin)/participants/import/[batchId]/preview/actions';

const RAW_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const RAW_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!RAW_URL || !RAW_SERVICE_KEY) {
  throw new Error(
    'import-preview-classification-live.test.ts requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be ' +
      'set. This is a live-DB test against a real (scratch) Supabase project — it intentionally fails loudly rather ' +
      'than silently skipping when these are missing.'
  );
}

const URL: string = RAW_URL;
const SERVICE_KEY: string = RAW_SERVICE_KEY;

const admin = createClient<Database>(URL, SERVICE_KEY);

const EMAIL_PREFIX = 'import-preview-classification-live-';
const STAFF_EMAIL = `${EMAIL_PREFIX}staff@test.local`;
const ROW_A_EMAIL = `${EMAIL_PREFIX}row-a@example.com`;
const ROW_B_EMAIL = `${EMAIL_PREFIX}row-b@example.com`;
const PASSWORD = 'password123';

let staffId: string;
let importBatchId: string;
let storagePath: string;
let importColumnMappingIds: string[] = [];

// Same reuse-on-failure pattern established across the live tests in this
// plan (see claimed-update-gate-live.test.ts / confirm-import-live.test.ts
// for the identical helper and full rationale — deleteUser can fail
// persistently, not just transiently, for a given user id).
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

async function buildAndUploadWorkbook(): Promise<string> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Participants');
  ws.addRow(['Full Name', 'Email', 'Participant Type']);
  // Row 2: mapped as delegate at validation time — this test flips it to
  // volunteer via the action under test.
  ws.addRow(['Row A Person', ROW_A_EMAIL, 'delegate']);
  // Row 3: a second, independent row, used to prove the update is scoped to
  // exactly the targeted import_rows.id and does not bleed into siblings.
  ws.addRow(['Row B Person', ROW_B_EMAIL, 'speaker']);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const path = `import-preview-classification-live-test/${Date.now()}.xlsx`;
  const { error } = await admin.storage.from('import-uploads').upload(path, buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (error) throw new Error(`Failed to upload test workbook: ${error.message}`);
  return path;
}

beforeAll(async () => {
  staffId = await getOrCreateFixedUser(STAFF_EMAIL);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  storagePath = await buildAndUploadWorkbook();

  const { data: batch, error: batchError } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffId,
      original_filename: 'import-preview-classification-live-test.xlsx',
      file_checksum: `import-preview-classification-live-test-checksum-${Date.now()}`,
      storage_path: storagePath,
      sheet_name: 'Participants',
      status: 'validating',
      unique_identifier_column_index: 1,
    })
    .select('id')
    .single();
  if (batchError || !batch) throw new Error(`Failed to create import batch fixture: ${batchError?.message}`);
  importBatchId = batch.id;

  const { data: mappings, error: mappingError } = await admin
    .from('import_column_mappings')
    .insert([
      { import_batch_id: importBatchId, source_column_index: 0, source_column_header: 'Full Name', target_kind: 'core_field', target_key: 'full_name' },
      { import_batch_id: importBatchId, source_column_index: 1, source_column_header: 'Email', target_kind: 'core_field', target_key: 'email' },
      {
        import_batch_id: importBatchId,
        source_column_index: 2,
        source_column_header: 'Participant Type',
        target_kind: 'core_field',
        target_key: 'participant_type',
      },
    ])
    .select('id');
  if (mappingError) throw new Error(`Failed to create column mapping fixtures: ${mappingError.message}`);
  importColumnMappingIds = (mappings ?? []).map((m) => m.id);

  // Populates real import_rows via the real validation pipeline (workbook
  // download, per-row validation, insert) — not a hand-crafted import_rows
  // insert — so the row this test edits has exactly the same
  // normalized_row shape a real preview screen would show.
  await runValidationForCaller(importBatchId, { userId: staffId, service: admin });
}, 300000);

afterAll(async () => {
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`afterAll cleanup step failed: ${label}`, err);
    }
  };

  await step('delete import rows/mappings/batch', async () => {
    if (!importBatchId) return;
    await admin.from('import_rows').delete().eq('import_batch_id', importBatchId);
    if (importColumnMappingIds.length > 0) await admin.from('import_column_mappings').delete().in('id', importColumnMappingIds);
    await admin.from('import_batches').delete().eq('id', importBatchId);
  });

  await step('remove storage object', async () => {
    if (storagePath) await admin.storage.from('import-uploads').remove([storagePath]);
  });

  await step('delete audit_logs for staff', async () => {
    if (staffId) await admin.from('audit_logs').delete().eq('actor_id', staffId);
  });

  await step('delete staff user', async () => {
    if (staffId) {
      const result = await admin.auth.admin.deleteUser(staffId);
      if (result.error) console.error('afterAll cleanup: user delete returned an error', result.error);
    }
  });
}, 300000);

describe('updateRowParticipantTypeForCaller (live)', () => {
  it('updates normalized_row.participant_type for exactly the targeted row, preserving its other normalized_row fields, and leaves sibling rows untouched', async () => {
    const { data: rows, error: rowsError } = await admin
      .from('import_rows')
      .select('id, excel_row_number, normalized_row')
      .eq('import_batch_id', importBatchId)
      .order('excel_row_number', { ascending: true });
    expect(rowsError).toBeNull();
    const byRow = new Map((rows ?? []).map((r) => [r.excel_row_number, r]));

    const rowA = byRow.get(2)!;
    const rowB = byRow.get(3)!;
    expect(rowA).toBeTruthy();
    expect(rowB).toBeTruthy();

    // Sanity check on the real validation pipeline's own output, before this
    // test's edit — confirms the fixture actually round-tripped
    // participant_type through validateRow as expected.
    expect((rowA.normalized_row as Record<string, unknown>).participant_type).toBe('delegate');
    expect((rowA.normalized_row as Record<string, unknown>).email).toBe(ROW_A_EMAIL);
    expect((rowB.normalized_row as Record<string, unknown>).participant_type).toBe('speaker');

    // ---------------------------------------------------------------
    // The actual behavior under test: flip row A's participant_type via the
    // Server Action's caller-scoped implementation, exactly as the preview
    // screen's new <select> control will call it.
    // ---------------------------------------------------------------
    const result = await updateRowParticipantTypeForCaller(rowA.id, 'volunteer', { userId: staffId, service: admin });
    expect(result.error).toBeNull();

    const { data: rowAAfter, error: rowAAfterError } = await admin
      .from('import_rows')
      .select('normalized_row')
      .eq('id', rowA.id)
      .single();
    expect(rowAAfterError).toBeNull();
    const normalizedAfter = rowAAfter!.normalized_row as Record<string, unknown>;
    expect(normalizedAfter.participant_type).toBe('volunteer');
    // Every other field on normalized_row must survive the merge untouched
    // (this is a `{ ...current, participant_type: new }` merge, not a
    // replace) — full_name/email are exactly what a real preview screen
    // still needs to display after the edit.
    expect(normalizedAfter.email).toBe(ROW_A_EMAIL);
    expect(normalizedAfter.full_name).toBe('Row A Person');

    // Row B (a completely different import_rows id) must be entirely
    // unaffected by row A's update — proves the `.eq('id', importRowId)`
    // scoping is real, not accidentally batch-wide.
    const { data: rowBAfter, error: rowBAfterError } = await admin
      .from('import_rows')
      .select('normalized_row')
      .eq('id', rowB.id)
      .single();
    expect(rowBAfterError).toBeNull();
    expect((rowBAfter!.normalized_row as Record<string, unknown>).participant_type).toBe('speaker');

    // ---------------------------------------------------------------
    // Calling it again with a different value re-confirms the update is a
    // genuine read-modify-write (not e.g. a stale-closure bug that only
    // works once) — flip row A again, to a third distinct value.
    // ---------------------------------------------------------------
    const secondResult = await updateRowParticipantTypeForCaller(rowA.id, 'knowledge_partner', { userId: staffId, service: admin });
    expect(secondResult.error).toBeNull();

    const { data: rowAFinal } = await admin.from('import_rows').select('normalized_row').eq('id', rowA.id).single();
    expect((rowAFinal!.normalized_row as Record<string, unknown>).participant_type).toBe('knowledge_partner');
    expect((rowAFinal!.normalized_row as Record<string, unknown>).email).toBe(ROW_A_EMAIL);
  });

  it('returns an error (not a throw) for a non-existent import row id, and touches no real row', async () => {
    const bogusId = '00000000-0000-0000-0000-000000000000';
    const result = await updateRowParticipantTypeForCaller(bogusId, 'speaker', { userId: staffId, service: admin });
    expect(result.error).toBeTruthy();
  });
}, 300000);
