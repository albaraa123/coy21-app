// tests/import/validation-live.test.ts
//
// Live integration coverage for Task 14's runValidation server action — the
// first point where Task 10's pure row-validation/duplicate-classification
// logic meets real Supabase queries (existing-application lookup by
// imported_email, and the four-table downstream-reference check). Follows
// the service-role seed / anon-key-sign-in pattern established by
// tests/rls/import.test.ts and Phase 5's live tests (e.g.
// tests/schedule/authorization.test.ts): seed real rows via the service-role
// admin client, exercise the real server action, assert against the real
// database, then delete everything this test created.
//
// No local Postgres exists for this project — every test in this suite runs
// against the live linked Supabase project. All seeded/created rows are
// removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import type { Database } from '@/types/database';
import { runValidationForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/preview/actions';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const STAFF_EMAIL = 'import-validation-live-staff@test.local';
const PASSWORD = 'password123';

// Emails used in the in-memory workbook / seed fixtures. Namespaced with a
// distinct prefix so this suite's rows are trivially identifiable if cleanup
// ever needs to be re-run manually.
const VALID_EMAIL = 'import-validation-live-valid@example.com';
const INVALID_EMAIL_RAW = 'not-an-email';
const DUPLICATE_IN_FILE_EMAIL = 'import-validation-live-dup-in-file@example.com';
const EXISTING_UNCLAIMED_EMAIL = 'import-validation-live-existing-unclaimed@example.com';
const EXISTING_CLAIMED_EMAIL = 'import-validation-live-existing-claimed@example.com';
const BLOCKED_DOWNSTREAM_EMAIL = 'import-validation-live-blocked-downstream@example.com';

let staffId: string;
let staffProfileId: string;

let claimedParticipantId: string | undefined;

let unclaimedApplicationId: string;
let claimedApplicationId: string;
let downstreamBlockedApplicationId: string;

let importBatchId: string;
let importColumnMappingIds: string[] = [];
let storagePath: string;

let featureExtractionRunId: string | undefined;
let featureSnapshotId: string | undefined;
let tagId: string | undefined;
let createdTagId: string | undefined;

async function buildWorkbookBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Participants');
  ws.addRow(['Full Name', 'Email']);
  // Row 2 (excel_row_number 2): valid.
  ws.addRow(['Valid Person', VALID_EMAIL]);
  // Row 3: invalid — bad email format.
  ws.addRow(['Invalid Email Person', INVALID_EMAIL_RAW]);
  // Row 4: first occurrence of a within-file duplicate email.
  ws.addRow(['Dup First', DUPLICATE_IN_FILE_EMAIL]);
  // Row 5: second occurrence — classified duplicate_in_file.
  ws.addRow(['Dup Second', DUPLICATE_IN_FILE_EMAIL]);
  // Row 6: matches an existing, unclaimed imported application.
  ws.addRow(['Existing Unclaimed', EXISTING_UNCLAIMED_EMAIL]);
  // Row 7: matches an existing, already-claimed application.
  ws.addRow(['Existing Claimed', EXISTING_CLAIMED_EMAIL]);
  // Row 8: matches an existing application with a downstream feature-
  // snapshot reference — must classify as blocked_downstream, not
  // existing_unclaimed/claimed.
  ws.addRow(['Blocked Downstream', BLOCKED_DOWNSTREAM_EMAIL]);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// Reuse-on-failure: verified directly against this live project (Task 28's
// gate 6 verification pass) that admin.auth.admin.deleteUser can fail with
// the documented AuthRetryableFetchError (500, empty message) PERSISTENTLY,
// not just transiently. This file had no sweep at all, so a bare createUser
// on a fixed email would throw "already registered" forever once a prior
// run's user survived its own afterAll. Reuses the existing stale user
// (resetting its password) instead of depending on deletion succeeding at
// all. Same fix applied to every other live test in this directory earlier
// in this pass.
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
  staffProfileId = staffId;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  // A separate participant who CLAIMS the "existing_claimed" fixture
  // application (applicant_id set), distinguishing it from the unclaimed
  // fixture (applicant_id null).
  claimedParticipantId = await getOrCreateFixedUser('import-validation-live-claimed-participant@test.local');
  await admin.from('profiles').update({ role: 'participant' }).eq('id', claimedParticipantId);

  // Fixture 1: existing, unclaimed imported application (applicant_id null).
  const { data: unclaimedApp } = await admin
    .from('applications')
    .insert({ applicant_id: null, imported_email: EXISTING_UNCLAIMED_EMAIL, status: 'accepted' })
    .select('id')
    .single();
  unclaimedApplicationId = unclaimedApp!.id;

  // Fixture 2: existing, claimed application (applicant_id set).
  const { data: claimedApp } = await admin
    .from('applications')
    .insert({ applicant_id: claimedParticipantId, imported_email: EXISTING_CLAIMED_EMAIL, status: 'accepted' })
    .select('id')
    .single();
  claimedApplicationId = claimedApp!.id;

  // Fixture 3: existing application with a downstream reference
  // (participant_feature_snapshots row), which must classify as
  // blocked_downstream regardless of claimed/unclaimed state.
  const { data: downstreamApp } = await admin
    .from('applications')
    .insert({ applicant_id: null, imported_email: BLOCKED_DOWNSTREAM_EMAIL, status: 'accepted' })
    .select('id')
    .single();
  downstreamBlockedApplicationId = downstreamApp!.id;

  // Reuse an existing tag if one is live; otherwise seed a throwaway one of
  // our own (and delete it in afterAll) — this suite doesn't care about a
  // tag's real semantics, it only needs a valid, non-null tag_id FK target
  // for the participant_feature_snapshots downstream-reference fixture.
  const { data: existingTag } = await admin.from('tags').select('id').limit(1).maybeSingle();
  if (existingTag) {
    tagId = existingTag.id;
  } else {
    const { data: createdTag } = await admin
      .from('tags')
      .insert({ code: 'import-validation-live-test-tag', name_ar: 'اختبار', name_en: 'Test tag' })
      .select('id')
      .single();
    tagId = createdTag!.id;
    createdTagId = tagId;
  }

  const { data: featureRun } = await admin
    .from('feature_extraction_runs')
    .insert({ rules_version: 1, application_count: 1, run_by: staffProfileId })
    .select('id')
    .single();
  featureExtractionRunId = featureRun!.id;

  const { data: snapshot } = await admin
    .from('participant_feature_snapshots')
    .insert({ feature_extraction_run_id: featureExtractionRunId, application_id: downstreamBlockedApplicationId, tag_id: tagId, weight: 1 })
    .select('id')
    .single();
  featureSnapshotId = snapshot!.id;

  // Build the in-memory workbook, upload it to the real import-uploads
  // bucket (runValidation downloads it back via service.storage), and seed
  // import_batches/import_column_mappings the same way Task 13's
  // confirmMapping would have left them: status 'validating', a confirmed
  // mapping, and a unique-identifier column index pointing at the email
  // column.
  const buffer = await buildWorkbookBuffer();
  storagePath = `import-validation-live-test/${Date.now()}.xlsx`;
  const { error: uploadError } = await admin.storage.from('import-uploads').upload(storagePath, buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (uploadError) throw new Error(`Failed to upload test workbook: ${uploadError.message}`);

  const { data: batch } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffProfileId,
      original_filename: 'import-validation-live-test.xlsx',
      file_checksum: 'import-validation-live-test-checksum',
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
    ])
    .select('id');
  importColumnMappingIds = (mappings ?? []).map((m) => m.id);
});

afterAll(async () => {
  // FK-safe order: children before parents.
  const { data: rowsToDelete } = await admin.from('import_rows').select('id').eq('import_batch_id', importBatchId);
  if (rowsToDelete && rowsToDelete.length > 0) {
    await admin.from('import_rows').delete().in('id', rowsToDelete.map((r) => r.id));
  }
  if (importColumnMappingIds.length > 0) {
    await admin.from('import_column_mappings').delete().in('id', importColumnMappingIds);
  }
  if (importBatchId) {
    await admin.from('import_batches').delete().eq('id', importBatchId);
  }
  await admin.storage.from('import-uploads').remove([storagePath]).catch(() => undefined);

  if (featureSnapshotId) await admin.from('participant_feature_snapshots').delete().eq('id', featureSnapshotId);
  if (featureExtractionRunId) await admin.from('feature_extraction_runs').delete().eq('id', featureExtractionRunId);
  if (createdTagId) await admin.from('tags').delete().eq('id', createdTagId);

  await admin
    .from('applications')
    .delete()
    .in('id', [unclaimedApplicationId, claimedApplicationId, downstreamBlockedApplicationId].filter(Boolean));

  // audit_logs.actor_id references profiles(id) with no `on delete` clause
  // (see supabase/migrations/20260722200245_agenda_enums_and_reference_tables.sql,
  // a pre-existing Phase 5 table this task doesn't own). runValidationForCaller
  // writes an audit_logs row for staffId on every run, so without deleting it
  // first, the auth-user hard-delete below fails with an opaque 500 from the
  // Auth admin API (not a normal Postgrest FK error) — and because it's
  // wrapped in Promise.allSettled, that failure was previously silent,
  // leaving the user (and its reserved email) live for the next run. Delete
  // the audit trail this test itself generated before deleting the user.
  if (staffId) {
    await admin.from('audit_logs').delete().eq('actor_id', staffId);
  }

  // deleteUser's second argument is shouldSoftDelete, defaulting to false —
  // the SDK already hard-deletes by default (verified against
  // node_modules/@supabase/auth-js/dist/module/GoTrueAdminApi.js), so no
  // second argument is needed or correct here. An earlier version of this
  // comment/call incorrectly passed `true`, which actually requests a soft
  // delete (the opposite of the intent) — fixed to match the plain
  // deleteUser(id) pattern used elsewhere in this repo's test suite.
  const [staffDeleteResult, participantDeleteResult] = await Promise.allSettled([
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    claimedParticipantId ? admin.auth.admin.deleteUser(claimedParticipantId) : Promise.resolve(),
  ]);
  // Surface delete failures instead of silently swallowing them — a failed
  // cleanup here means the next run of this suite fails with a confusing
  // "email_exists" error far from the real cause.
  for (const result of [staffDeleteResult, participantDeleteResult]) {
    if (result.status === 'rejected') {
      console.error('afterAll cleanup: auth user delete failed', result.reason);
    } else if (result.value && typeof result.value === 'object' && 'error' in result.value && result.value.error) {
      console.error('afterAll cleanup: auth user delete returned an error', result.value.error);
    }
  }
});

describe('runValidation (live)', () => {
  // Default vitest per-test timeout (5s) isn't enough here: runValidation
  // does one applications lookup plus four downstream-reference existence
  // checks PER row-with-an-email, all over the network against the live
  // Supabase project — for this fixture's 7 rows that's roughly 20+
  // sequential round trips before the bulk import_rows insert even starts.
  // Pass an explicit 30s timeout as vitest's `it()` third argument (the
  // comment above previously described this need but never actually
  // supplied the override, so the test failed on vitest's 5s default).
  it('populates import_rows with every expected classification and updates the batch summary counts', async () => {
    // Calls runValidationForCaller directly with an already-authenticated
    // { userId, service } pair rather than the exported 'use server'
    // runValidation — 'use server' actions call next/headers' cookies()
    // internally (via requireAgendaStaffCaller -> createClient), which
    // throws when invoked outside a real Next.js request, exactly as
    // documented in tests/agenda/authorization.test.ts. This still exercises
    // every real DB-touching line runValidation runs (workbook download from
    // storage, per-row validation, duplicate classification, the four-table
    // downstream-reference check, import_rows insert, import_batches
    // update) — only the cookie-based auth wrapper is swapped out, using the
    // service-role admin client as the "already authorized" service client.
    const result = await runValidationForCaller(importBatchId, { userId: staffId, service: admin });
    // validCount reflects field-level validation status only (validateRow's
    // result.status), independent of duplicate_status — a row can be both
    // validation_status 'valid' AND carry a duplicate_status (e.g. an
    // existing-application match still has a well-formed name/email). Only
    // row 3 (malformed email) fails field validation, so 6 of the 7 rows are
    // 'valid': rows 2, 4, 5 (both duplicate-in-file occurrences), 6, 7, 8.
    expect(result.validCount).toBe(6);
    expect(result.errorCount).toBe(1);
    // duplicateCount counts every row carrying a non-null duplicate_status:
    // the second within-file duplicate row, plus the three existing-
    // application matches (unclaimed, claimed, blocked_downstream).
    expect(result.duplicateCount).toBe(4);

    const { data: batch } = await admin
      .from('import_batches')
      .select('status, row_count, valid_count, warning_count, error_count, duplicate_count')
      .eq('id', importBatchId)
      .single();
    expect(batch?.status).toBe('ready_to_import');
    expect(batch?.row_count).toBe(7);
    expect(batch?.valid_count).toBe(6);
    expect(batch?.error_count).toBe(1);
    expect(batch?.duplicate_count).toBe(4);

    const { data: rows } = await admin
      .from('import_rows')
      .select('id, excel_row_number, validation_status, duplicate_status, destination_application_id, duplicate_of_row_id, normalized_row')
      .eq('import_batch_id', importBatchId)
      .order('excel_row_number', { ascending: true });
    expect(rows).toHaveLength(7);
    const byRow = new Map((rows ?? []).map((r) => [r.excel_row_number, r]));

    // Row 2: valid.
    expect(byRow.get(2)?.validation_status).toBe('valid');
    expect(byRow.get(2)?.duplicate_status).toBeNull();

    // Row 3: invalid (bad email format), not a database duplicate.
    expect(byRow.get(3)?.validation_status).toBe('invalid');
    expect(byRow.get(3)?.duplicate_status).toBeNull();

    // Row 4: first occurrence — valid, no duplicate flag yet.
    expect(byRow.get(4)?.validation_status).toBe('valid');
    expect(byRow.get(4)?.duplicate_status).toBeNull();

    // Row 5: second occurrence of the same email — duplicate_in_file, and
    // duplicate_of_row_id must point back at row 4's real import_rows.id
    // (the post-insert linking pass this test was written to verify — a
    // deferred finding fixed in this same session: an earlier version of
    // apply_import_row_transactional's caller computed this value and
    // discarded it before ever reaching the database).
    expect(byRow.get(5)?.duplicate_status).toBe('duplicate_in_file');
    expect(byRow.get(5)?.duplicate_of_row_id).toBe(byRow.get(4)?.id);
    expect(byRow.get(5)?.duplicate_of_row_id).not.toBeNull();

    // Row 6: matches the unclaimed fixture application.
    expect(byRow.get(6)?.duplicate_status).toBe('existing_unclaimed');
    expect(byRow.get(6)?.destination_application_id).toBe(unclaimedApplicationId);

    // Row 7: matches the claimed fixture application.
    expect(byRow.get(7)?.duplicate_status).toBe('existing_claimed');
    expect(byRow.get(7)?.destination_application_id).toBe(claimedApplicationId);

    // Row 8: matches the fixture application with a downstream
    // participant_feature_snapshots reference — blocked_downstream
    // overrides what would otherwise be existing_unclaimed, proving the
    // four-table downstream-reference check actually gates classification.
    expect(byRow.get(8)?.duplicate_status).toBe('blocked_downstream');
    expect(byRow.get(8)?.destination_application_id).toBe(downstreamBlockedApplicationId);
  }, 30000);
});
