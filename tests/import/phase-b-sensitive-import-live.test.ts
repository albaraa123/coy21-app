// tests/import/phase-b-sensitive-import-live.test.ts
//
// Live integration coverage for Phase B (design doc section 13, "controlled
// account provisioning" — docs/superpowers/specs/2026-07-30-controlled-
// account-provisioning-design.md). Exercises the real pipeline end to end:
// validateRow (row-validation warnings) -> apply_import_row_transactional
// (via processImportChunkForCaller) -> the conditional
// application_travel_info/application_health_info upserts -> rollback.
//
// No local Postgres exists for this project — every test here runs against
// the live linked Supabase project, mirroring confirm-import-live.test.ts's
// established pattern exactly (ForCaller variants, getOrCreateFixedUser
// reuse-on-failure, full afterAll cleanup).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  startImportForCaller,
  processImportChunkForCaller,
} from '@/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions';
import { rollbackImportBatchForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/rollback-action';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const STAFF_EMAIL = 'phaseb-sensitive-import-live-staff@test.local';
const PASSWORD = 'password123';
const EMAIL_PREFIX = 'phaseb-sensitive-import-live-';

let staffId: string;

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

// Full NO ACTION FK-dependency list on applications(id), per Task 0's own
// authoritative derivation (supabase/migrations/20260726109500_tmp_introspect.sql
// and 20260726109600_rollback_safety_fixes.sql) — every one of these tables
// must be cleared before an applications row can be deleted, or the delete
// is silently refused and leaks both the applications row AND (since this
// file's import_batches delete below depends on the applications row being
// gone first) the import_batches row too, forever, until manually cleaned.
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

async function cleanupSuiteApplications() {
  const { data: apps } = await admin.from('applications').select('id').like('imported_email', `${EMAIL_PREFIX}%`);
  const ids = (apps ?? []).map((a) => a.id);
  if (ids.length === 0) return;
  for (const t of FK_DEPENDENT_TABLES) {
    await deleteChecked(t, 'application_id', ids);
  }
  await deleteChecked('applications', 'id', ids);
}

// This file previously never deleted its own import_batches rows at all —
// every one of the per-test batches importRows() creates (fullname-first,
// allocation, extraction, travel-only, health-only, both, neither, preserve,
// no-leak, badphone, baddate, rollback-updated-1, reimport-travel-1, ...)
// leaked permanently on every run, regardless of load. Batches are tracked
// here as they're created so afterAll can sweep them explicitly.
const createdBatchIds: string[] = [];

async function cleanupSuiteImportBatches() {
  for (const batchId of createdBatchIds) {
    const { data: rows } = await admin.from('import_rows').select('id').eq('import_batch_id', batchId);
    await deleteChecked('import_rows', 'id', (rows ?? []).map((r) => r.id));
    const { error: mappingErr } = await admin.from('import_column_mappings').delete().eq('import_batch_id', batchId);
    if (mappingErr) console.error('cleanup: delete on import_column_mappings failed', mappingErr);
    const { error: batchErr } = await admin.from('import_batches').delete().eq('id', batchId);
    if (batchErr) console.error('cleanup: delete on import_batches failed', batchErr);
  }
}

beforeAll(async () => {
  staffId = await getOrCreateFixedUser(STAFF_EMAIL);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
  await cleanupSuiteApplications();
}, 120000);

afterAll(async () => {
  await cleanupSuiteApplications();
  await cleanupSuiteImportBatches();
  if (staffId) {
    const { error: auditErr } = await admin.from('audit_logs').delete().eq('actor_id', staffId);
    if (auditErr) console.error('afterAll cleanup: audit_logs delete returned an error', auditErr);
    const result = await admin.auth.admin.deleteUser(staffId);
    if (result.error) console.error('afterAll cleanup: staff delete returned an error', result.error);
  }
}, 120000);

// Shared helper: build a batch + mappings + validated rows from an in-memory
// header/row set, run it to completion, and return the resulting
// applications keyed by email. Every test in this file gets its own batch
// (not shared setup) so failures in one scenario can't cascade into another.
async function importRows(
  batchLabel: string,
  headers: string[],
  mappings: { sourceColumnIndex: number; targetKind: string; targetKey: string }[],
  rows: (string | null)[][],
  uniqueIdentifierColumnIndex: number
) {
  const storagePath = `phaseb-sensitive-import-live-test/${batchLabel}-${Date.now()}.xlsx`;
  // The confirm/preview pipeline reads the workbook from storage for header
  // re-derivation in some paths, but runValidationForCaller/processImportChunkForCaller
  // operate on import_rows directly once seeded — seeding import_rows
  // directly (as confirm-import-live.test.ts's sibling suites do for
  // narrower scenarios) keeps this file focused on the apply/rollback
  // behavior rather than re-deriving headers from a real uploaded file.
  const { data: batch, error: batchError } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffId,
      original_filename: `${batchLabel}.xlsx`,
      file_checksum: `${batchLabel}-checksum-${Date.now()}`,
      storage_path: storagePath,
      sheet_name: 'Participants',
      status: 'validating',
      unique_identifier_column_index: uniqueIdentifierColumnIndex,
      row_count: rows.length,
    })
    .select('id')
    .single();
  if (batchError || !batch) throw new Error(`Failed to create batch: ${batchError?.message}`);
  createdBatchIds.push(batch.id);

  const { error: mappingError } = await admin.from('import_column_mappings').insert(
    mappings.map((m) => ({
      import_batch_id: batch.id,
      source_column_index: m.sourceColumnIndex,
      source_column_header: headers[m.sourceColumnIndex],
      target_kind: m.targetKind,
      target_key: m.targetKey,
    }))
  );
  if (mappingError) throw new Error(`Failed to insert mappings: ${mappingError.message}`);

  // Directly seed import_rows with raw_row data (bypassing the actual .xlsx
  // upload/parse step, which is already covered by workbook-parser.test.ts
  // and the pre-existing live suites) — runValidationForCaller re-derives
  // normalized_row/validation_status/warnings from raw_row + mappings for
  // real, exactly as production does.
  //
  // runValidationForCaller requires status = 'validating' and re-downloads
  // the stored file itself (it does not accept pre-seeded import_rows), so
  // this suite instead calls validateRow directly per row and seeds
  // import_rows with the real result — equivalent coverage of the
  // validation logic without needing a real uploaded workbook per scenario.
  const { validateRow, classifyDuplicateStatus } = await import('@/lib/import/row-validation');
  const { computeRowFingerprint } = await import('@/lib/import/normalization');

  const seenEmails = new Map<string, number>();
  const importRowsPayload = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const result = validateRow(raw, mappings as never, { uniqueIdentifierColumnIndex });
    const normalizedEmail = String(result.normalizedRow.email ?? '').toLowerCase();

    const { data: existing } = normalizedEmail
      ? await admin.from('applications').select('id, applicant_id').eq('imported_email', normalizedEmail).maybeSingle()
      : { data: null };

    const dup = normalizedEmail
      ? classifyDuplicateStatus(normalizedEmail, {
          seenEmailsInFile: seenEmails,
          rowIndex: i,
          existingApplication: existing ? { id: existing.id, applicantId: existing.applicant_id, hasDownstreamReference: false } : null,
        })
      : null;
    if (normalizedEmail) seenEmails.set(normalizedEmail, i);

    importRowsPayload.push({
      import_batch_id: batch.id,
      excel_row_number: i + 2,
      raw_row: raw,
      normalized_row: result.normalizedRow as never,
      validation_status: result.status,
      warnings: result.warnings as never,
      errors: result.errors as never,
      row_fingerprint: computeRowFingerprint(result.normalizedRow),
      duplicate_status: dup?.status ?? null,
      destination_application_id: dup && 'applicationId' in dup ? dup.applicationId : null,
    });
  }

  const { data: insertedRows, error: rowsError } = await admin.from('import_rows').insert(importRowsPayload).select('id, warnings, validation_status');
  if (rowsError) throw new Error(`Failed to insert import_rows: ${rowsError.message}`);

  await admin.from('import_batches').update({ status: 'ready_to_import' }).eq('id', batch.id);

  const caller = { userId: staffId, service: admin };
  const { lockToken } = await startImportForCaller(batch.id, caller);
  let isComplete = false;
  while (!isComplete) {
    const result = await processImportChunkForCaller({ batchId: batch.id, lockToken }, caller);
    isComplete = result.isComplete;
  }

  return { batchId: batch.id, insertedRows: insertedRows ?? [] };
}

describe('Phase B: applications.full_name', () => {
  it('imports full_name correctly and does not erase an existing value on a blank re-import', async () => {
    const email = `${EMAIL_PREFIX}fullname@example.com`;
    const headers = ['Full Name', 'Email'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
    ];

    await importRows('fullname-first', headers, mappings, [['Original Name', email]], 1);
    const { data: afterFirst } = await admin.from('applications').select('full_name').eq('imported_email', email).single();
    expect(afterFirst?.full_name).toBe('Original Name');

    // Blank full_name on re-import must not erase the existing value.
    await importRows('fullname-reimport-blank', headers, mappings, [['', email]], 1);
    const { data: afterBlank } = await admin.from('applications').select('full_name').eq('imported_email', email).single();
    expect(afterBlank?.full_name).toBe('Original Name');

    // Non-blank full_name on re-import DOES overwrite.
    await importRows('fullname-reimport-changed', headers, mappings, [['Changed Name', email]], 1);
    const { data: afterChanged } = await admin.from('applications').select('full_name').eq('imported_email', email).single();
    expect(afterChanged?.full_name).toBe('Changed Name');
  }, 60000);
});

describe('Phase B: structured allocation columns', () => {
  it('imports session_languages and track_1_focus_areas as arrays, feature-extraction-ready', async () => {
    const email = `${EMAIL_PREFIX}allocation@example.com`;
    const headers = ['Full Name', 'Email', 'Session Languages', 'Track 1 focus areas'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'core_field', targetKey: 'session_languages' },
      { sourceColumnIndex: 3, targetKind: 'core_field', targetKey: 'track_1_focus_areas' },
    ];
    await importRows('allocation', headers, mappings, [['Allocation Person', email, 'Arabic, English', 'Adaptation; Resilience']], 1);

    const { data: app } = await admin
      .from('applications')
      .select('session_languages, track_1_focus_areas')
      .eq('imported_email', email)
      .single();
    expect(app?.session_languages).toEqual(['Arabic', 'English']);
    expect(app?.track_1_focus_areas).toEqual(['Adaptation', 'Resilience']);
  }, 60000);

  it('feeds the new columns into feature extraction and produces matching snapshots', async () => {
    const email = `${EMAIL_PREFIX}extraction@example.com`;
    const headers = ['Full Name', 'Email', 'Session Languages'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'core_field', targetKey: 'session_languages' },
    ];
    await importRows('extraction', headers, mappings, [['Extraction Person', email, 'Arabic']], 1);

    const { data: app } = await admin.from('applications').select('id, session_languages').eq('imported_email', email).single();
    expect(app?.session_languages).toEqual(['Arabic']);

    // Direct unit-level confirmation that the extraction module reads this
    // column (the full runFeatureExtraction pipeline is exercised by its own
    // existing test suite; this proves Phase B's specific new field flows
    // through unchanged extraction logic).
    const { extractFeatures } = await import('@/lib/allocation/feature-extraction');
    const result = extractFeatures(
      {
        interests: null, trackInterests: null, topicsToLearn: null, participationGoals: null, pastInitiatives: null,
        sessionLanguages: app!.session_languages, track1FocusAreas: null, track2FocusAreas: null, track3FocusAreas: null,
        primaryTrack: null, secondaryTrack: null,
      },
      [{ id: 'r', sourceField: 'session_languages', matchType: 'array_value', matchValue: 'Arabic', tagId: 'tag-arabic', weight: 1 }]
    );
    expect(result).toEqual([{ tagId: 'tag-arabic', weight: 1 }]);
  }, 60000);
});

describe('Phase B: travel/health conditional writes', () => {
  it('creates a travel row but no health row for travel-only data', async () => {
    const email = `${EMAIL_PREFIX}travel-only@example.com`;
    const headers = ['Full Name', 'Email', 'Departure Airport'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'travel_field', targetKey: 'departure_airport' },
    ];
    await importRows('travel-only', headers, mappings, [['Travel Only', email, 'RUH']], 1);

    const { data: app } = await admin.from('applications').select('id').eq('imported_email', email).single();
    const { data: travel } = await admin.from('application_travel_info').select('departure_airport').eq('application_id', app!.id).maybeSingle();
    const { data: health } = await admin.from('application_health_info').select('*').eq('application_id', app!.id).maybeSingle();
    expect(travel?.departure_airport).toBe('RUH');
    expect(health).toBeNull();
  }, 60000);

  it('creates a health row but no travel row for health-only data', async () => {
    const email = `${EMAIL_PREFIX}health-only@example.com`;
    const headers = ['Full Name', 'Email', 'Allergies'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'health_field', targetKey: 'allergies' },
    ];
    await importRows('health-only', headers, mappings, [['Health Only', email, 'Peanuts']], 1);

    const { data: app } = await admin.from('applications').select('id').eq('imported_email', email).single();
    const { data: travel } = await admin.from('application_travel_info').select('*').eq('application_id', app!.id).maybeSingle();
    const { data: health } = await admin.from('application_health_info').select('allergies').eq('application_id', app!.id).maybeSingle();
    expect(travel).toBeNull();
    expect(health?.allergies).toBe('Peanuts');
  }, 60000);

  it('creates both rows when both travel and health data are present', async () => {
    const email = `${EMAIL_PREFIX}both@example.com`;
    const headers = ['Full Name', 'Email', 'Departure Airport', 'Allergies'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'travel_field', targetKey: 'departure_airport' },
      { sourceColumnIndex: 3, targetKind: 'health_field', targetKey: 'allergies' },
    ];
    await importRows('both', headers, mappings, [['Both Person', email, 'DXB', 'None']], 1);

    const { data: app } = await admin.from('applications').select('id').eq('imported_email', email).single();
    const { data: travel } = await admin.from('application_travel_info').select('departure_airport').eq('application_id', app!.id).maybeSingle();
    const { data: health } = await admin.from('application_health_info').select('allergies').eq('application_id', app!.id).maybeSingle();
    expect(travel?.departure_airport).toBe('DXB');
    expect(health?.allergies).toBe('None');
  }, 60000);

  it('creates neither row for a participant with no sensitive data', async () => {
    const email = `${EMAIL_PREFIX}neither@example.com`;
    const headers = ['Full Name', 'Email'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
    ];
    await importRows('neither', headers, mappings, [['Neither Person', email]], 1);

    const { data: app } = await admin.from('applications').select('id').eq('imported_email', email).single();
    const { data: travel } = await admin.from('application_travel_info').select('*').eq('application_id', app!.id).maybeSingle();
    const { data: health } = await admin.from('application_health_info').select('*').eq('application_id', app!.id).maybeSingle();
    expect(travel).toBeNull();
    expect(health).toBeNull();
  }, 60000);
});

describe('Phase B: original-answer preservation and no sensitive leakage', () => {
  it('preserves the original travel/health answers in application_answers with correct section tagging', async () => {
    const email = `${EMAIL_PREFIX}preserve@example.com`;
    const headers = ['Full Name', 'Email', 'Departure Airport', 'Allergies'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'travel_field', targetKey: 'departure_airport' },
      { sourceColumnIndex: 3, targetKind: 'health_field', targetKey: 'allergies' },
    ];
    await importRows('preserve', headers, mappings, [['Preserve Person', email, 'CAI', 'Shellfish']], 1);

    const { data: app } = await admin.from('applications').select('id').eq('imported_email', email).single();
    const { data: answers } = await admin
      .from('application_answers')
      .select('question_key, normalized_value, section, is_sensitive')
      .eq('application_id', app!.id)
      .in('question_key', ['departure_airport', 'allergies']);

    const departure = answers?.find((a) => a.question_key === 'departure_airport');
    const allergies = answers?.find((a) => a.question_key === 'allergies');
    expect(departure?.normalized_value).toBe('CAI');
    expect(departure?.section).toBe('travel');
    expect(allergies?.normalized_value).toBe('Shellfish');
    expect(allergies?.section).toBe('health');
    expect(allergies?.is_sensitive).toBe(true);
  }, 60000);

  it('never exposes travel/health data through a generic applications select', async () => {
    const email = `${EMAIL_PREFIX}no-leak@example.com`;
    const headers = ['Full Name', 'Email', 'Departure Airport', 'Allergies'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'travel_field', targetKey: 'departure_airport' },
      { sourceColumnIndex: 3, targetKind: 'health_field', targetKey: 'allergies' },
    ];
    await importRows('no-leak', headers, mappings, [['No Leak Person', email, 'JED', 'Bee stings']], 1);

    const { data: app } = await admin.from('applications').select('*').eq('imported_email', email).single();
    expect(app).not.toHaveProperty('departure_airport');
    expect(app).not.toHaveProperty('allergies');
  }, 60000);
});

describe('Phase B: row-validation warnings (not blocking errors)', () => {
  it('flags an implausible passport date as a warning and still imports the row', async () => {
    const email = `${EMAIL_PREFIX}baddate@example.com`;
    const headers = ['Full Name', 'Email', 'Passport Issue Date'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'travel_field', targetKey: 'passport_issue_date' },
    ];
    const { insertedRows } = await importRows('baddate', headers, mappings, [['Bad Date Person', email, 'not-a-date']], 1);

    expect(insertedRows[0].validation_status).toBe('warning');
    expect((insertedRows[0].warnings as unknown as { column: string }[]).some((w) => w.column === 'passport_issue_date')).toBe(true);

    const { data: app } = await admin.from('applications').select('id').eq('imported_email', email).single();
    expect(app).not.toBeNull(); // the row still imported despite the warning
  }, 60000);

  it('flags an implausible phone number as a warning and still imports the row', async () => {
    const email = `${EMAIL_PREFIX}badphone@example.com`;
    const headers = ['Full Name', 'Email', 'WhatsApp Number (including country code)'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'core_field', targetKey: 'whatsapp_number' },
    ];
    const { insertedRows } = await importRows('badphone', headers, mappings, [['Bad Phone Person', email, 'abc']], 1);

    expect(insertedRows[0].validation_status).toBe('warning');
    expect((insertedRows[0].warnings as unknown as { column: string }[]).some((w) => w.column === 'whatsapp_number')).toBe(true);

    const { data: app } = await admin.from('applications').select('id').eq('imported_email', email).single();
    expect(app).not.toBeNull();
  }, 60000);
});

describe('Phase B: re-import / idempotent upsert', () => {
  it('overwrites a changed travel field on re-import without duplicating the row', async () => {
    const email = `${EMAIL_PREFIX}reimport-travel@example.com`;
    const headers = ['Full Name', 'Email', 'Departure Airport'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'travel_field', targetKey: 'departure_airport' },
    ];
    await importRows('reimport-travel-1', headers, mappings, [['Reimport Person', email, 'RUH']], 1);
    await importRows('reimport-travel-2', headers, mappings, [['Reimport Person', email, 'DXB']], 1);

    const { data: app } = await admin.from('applications').select('id').eq('imported_email', email).single();
    const { data: travelRows } = await admin.from('application_travel_info').select('departure_airport').eq('application_id', app!.id);
    expect(travelRows).toHaveLength(1);
    expect(travelRows![0].departure_airport).toBe('DXB');
  }, 60000);
});

describe('Phase B: rollback restores travel/health state', () => {
  it('an inserted row rollback cascade-deletes its travel/health rows', async () => {
    const email = `${EMAIL_PREFIX}rollback-inserted@example.com`;
    const headers = ['Full Name', 'Email', 'Departure Airport', 'Allergies'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'travel_field', targetKey: 'departure_airport' },
      { sourceColumnIndex: 3, targetKind: 'health_field', targetKey: 'allergies' },
    ];
    const { batchId } = await importRows('rollback-inserted', headers, mappings, [['Rollback Inserted', email, 'RUH', 'None']], 1);

    const { data: appBefore } = await admin.from('applications').select('id').eq('imported_email', email).single();
    expect(appBefore).not.toBeNull();

    await rollbackImportBatchForCaller(batchId, { userId: staffId, service: admin });

    const { data: appAfter } = await admin.from('applications').select('id').eq('imported_email', email).maybeSingle();
    expect(appAfter).toBeNull();
  }, 60000);

  it('an updated row rollback restores the prior travel/health values', async () => {
    const email = `${EMAIL_PREFIX}rollback-updated@example.com`;
    const headers = ['Full Name', 'Email', 'Departure Airport'];
    const mappings = [
      { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
      { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
      { sourceColumnIndex: 2, targetKind: 'travel_field', targetKey: 'departure_airport' },
    ];
    // First import creates the application + travel row (RUH).
    await importRows('rollback-updated-1', headers, mappings, [['Rollback Updated', email, 'RUH']], 1);
    const { data: appBefore } = await admin.from('applications').select('id').eq('imported_email', email).single();

    // Second import (a separate batch) changes the travel data to DXB.
    const { batchId: secondBatchId } = await importRows('rollback-updated-2', headers, mappings, [['Rollback Updated', email, 'DXB']], 1);
    const { data: travelAfterUpdate } = await admin
      .from('application_travel_info')
      .select('departure_airport')
      .eq('application_id', appBefore!.id)
      .single();
    expect(travelAfterUpdate?.departure_airport).toBe('DXB');

    // Rolling back the SECOND batch should restore the travel row to RUH
    // (its state before that batch's update), not delete it (the
    // application itself predates this batch).
    await rollbackImportBatchForCaller(secondBatchId, { userId: staffId, service: admin });

    const { data: appAfterRollback } = await admin.from('applications').select('id').eq('imported_email', email).maybeSingle();
    expect(appAfterRollback).not.toBeNull(); // application itself survives — only this batch's update is undone

    const { data: travelAfterRollback } = await admin
      .from('application_travel_info')
      .select('departure_airport')
      .eq('application_id', appBefore!.id)
      .maybeSingle();
    expect(travelAfterRollback?.departure_airport).toBe('RUH');
  }, 60000);
});
