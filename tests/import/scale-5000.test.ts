// tests/import/scale-5000.test.ts
//
// Task 25 — scale validation at 5,000 rows. Same shape as scale-500.test.ts
// (see that file's header comment for the full rationale on pattern choices)
// but against tests/fixtures/import/generated/scale-5000.xlsx (Task 23's
// fixture #14). This test may legitimately take minutes — timeouts here are
// intentionally generous (mirroring confirm-import-live.test.ts's 600000ms
// live-test precedent) rather than tuned tight against a moving target.
//
// If this test reveals a genuine bottleneck (e.g. a per-row query where a
// batch operation should be used), the design spec requires fixing it here,
// not deferring it — see runValidationForCaller's per-row `applications`
// lookup and processImportChunkForCaller's recomputeBatchCounts, both flagged
// as investigation targets in this task's plan section.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@/types/database';
import { extractHeaderRow } from '@/lib/import/workbook-parser';
import { suggestMapping } from '@/lib/import/mapping-suggestion';
import { runValidationForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/preview/actions';
import { startImportForCaller, processImportChunkForCaller } from '@/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions';
import { MAPPING_CONFIDENCE_THRESHOLD } from '@/lib/validation/import';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const STAFF_EMAIL = 'scale-5000-live-staff@test.local';
const PASSWORD = 'password123';
const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'import', 'generated', 'scale-5000.xlsx');
const SHEET_NAME = 'Participants';
const EXPECTED_ROW_COUNT = 5000;
const ORIGINAL_FILENAME = 'scale-5000.xlsx';

let staffId: string;
let importBatchId: string;
let storagePath: string;

// Reuse-on-failure instead of sweep-then-create: verified directly against
// this live project (Task 28's final verification pass, gate 6) that
// admin.auth.admin.deleteUser can fail with the documented
// AuthRetryableFetchError (500, empty message) PERSISTENTLY, not just
// transiently — a sweep-then-create still throws "already registered" when
// the delete inside the sweep silently fails via its own catch block.
// Reuses the existing stale user (resetting its password) instead of
// depending on deletion succeeding at all. Same fix applied to
// tests/import/scale-500.test.ts and other live tests earlier in this pass.
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

// Self-healing pre-flight sweep: if a prior run of this exact test file
// crashed, was killed, or otherwise never reached its own afterAll, its
// import_batches row (and everything FK-depending on it) is left behind
// with no other mechanism to find it again — afterAll only knows about
// THIS run's own importBatchId, a variable that doesn't exist until the
// test body runs. This sweep uses the fixed, deterministic
// original_filename this file always inserts, so a later run can always
// find and clean up ANY prior leftover run of this same file, not just
// gracefully-completed ones. Runs in beforeAll, before any seeding.
// Fetches every id for a batch, defeating PostgREST's silent 1000-row cap on
// an unranged .select() (the same pagination trap documented for Task 0's
// cleanup) — without this, a stale batch with more than 1000 dependent rows
// (exactly this file's own scale: 5000) only ever gets its first 1000 rows
// deleted per sweep, the import_batches delete then fails its FK check
// against the remaining rows, and the leftover batch is never fully
// removed, no matter how many times the sweep runs.
async function fetchAllIds(table: 'applications' | 'import_rows', batchId: string): Promise<string[]> {
  const ids: string[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data } = await admin
      .from(table)
      .select('id')
      .eq('import_batch_id', batchId)
      .range(from, from + pageSize - 1);
    const page = data ?? [];
    ids.push(...page.map((r) => r.id));
    if (page.length < pageSize) break;
  }
  return ids;
}

async function sweepStaleFixtures(): Promise<void> {
  const { data: staleBatches } = await admin.from('import_batches').select('id, storage_path').eq('original_filename', ORIGINAL_FILENAME);
  for (const batch of staleBatches ?? []) {
    const appIds = await fetchAllIds('applications', batch.id);
    for (let i = 0; i < appIds.length; i += 100) {
      await admin.from('applications').delete().in('id', appIds.slice(i, i + 100));
    }
    const rowIds = await fetchAllIds('import_rows', batch.id);
    for (let i = 0; i < rowIds.length; i += 100) {
      await admin.from('import_rows').delete().in('id', rowIds.slice(i, i + 100));
    }
    await admin.from('import_column_mappings').delete().eq('import_batch_id', batch.id);
    await admin.from('import_batches').delete().eq('id', batch.id);
    // Mirrors afterAll's own storage cleanup (storagePath removal) — without
    // this, a crashed prior run's uploaded object leaks in the
    // import-uploads bucket even after its DB rows are swept.
    if (batch.storage_path) await admin.storage.from('import-uploads').remove([batch.storage_path]);
  }

  // Fallback for the case the above misses entirely: a prior run whose
  // import_batches row was already deleted (e.g. by a partial/interrupted
  // afterAll) but whose `applications` rows survived — invisible to the
  // sweep above since it only finds batches, not orphaned applications.
  // build-fixtures.ts's syntheticPerson() is fully deterministic (same
  // emails every regeneration, by design — see its own header comment), so
  // any application whose imported_email matches that exact
  // firstname.lastnameN@example.com shape is unambiguously this fixture
  // family's own residue, regardless of which batch (if any) it's still
  // attached to. Found via a real leftover of exactly this kind in the
  // sibling scale-500.test.ts during Phase 7G-K.
  const { data: candidates } = await admin.from('applications').select('id, imported_email').like('imported_email', '%@example.com');
  const orphanedFixtureIds = (candidates ?? [])
    .filter((a) => /^[a-z]+\.[a-z]+\d+@example\.com$/.test(a.imported_email ?? ''))
    .map((a) => a.id);
  if (orphanedFixtureIds.length > 0) {
    await admin.from('applications').delete().in('id', orphanedFixtureIds);
  }
}

beforeAll(async () => {
  await sweepStaleFixtures();
  staffId = await getOrCreateFixedUser(STAFF_EMAIL);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
}, 300000);

afterAll(async () => {
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`afterAll cleanup step failed: ${label}`, err);
    }
  };

  await step('delete applications from this batch', async () => {
    if (!importBatchId) return;
    // Paginated via fetchAllIds (not a bare .select('id')) — this file
    // inserts 5000 applications, well past PostgREST's silent 1000-row
    // select cap, so an unranged select here would only ever delete the
    // first 1000 and leave the rest attached, which then fails the
    // import_batches delete below on its FK check. Same bug/fix as
    // sweepStaleFixtures above; see that function's comment for the full
    // story of how this was found.
    const ids = await fetchAllIds('applications', importBatchId);
    for (let i = 0; i < ids.length; i += 100) {
      await admin.from('applications').delete().in('id', ids.slice(i, i + 100));
    }
  });

  await step('delete import rows/mappings/batch', async () => {
    if (!importBatchId) return;
    const ids = await fetchAllIds('import_rows', importBatchId);
    for (let i = 0; i < ids.length; i += 100) {
      await admin.from('import_rows').delete().in('id', ids.slice(i, i + 100));
    }
    await admin.from('import_column_mappings').delete().eq('import_batch_id', importBatchId);
    await admin.from('import_batches').delete().eq('id', importBatchId);
  });

  await step('remove storage object', async () => {
    if (storagePath) await admin.storage.from('import-uploads').remove([storagePath]);
  });

  await step('delete staff audit_logs', async () => {
    if (staffId) await admin.from('audit_logs').delete().eq('actor_id', staffId);
  });

  await step('delete staff user', async () => {
    if (staffId) {
      const result = await admin.auth.admin.deleteUser(staffId);
      if (result.error) console.error('afterAll cleanup: staff delete returned an error', result.error);
    }
  });
}, 300000);

describe('import scale test: 5,000 rows (live)', () => {
  it('runs upload -> parse -> map -> validate -> confirm-import end-to-end within acceptable time', async () => {
    const caller = { userId: staffId, service: admin };
    const timings: Record<string, number> = {};
    const overallStart = performance.now();

    const buffer = readFileSync(FIXTURE_PATH);
    storagePath = `scale-5000-live-test/${Date.now()}.xlsx`;
    const { error: uploadError } = await admin.storage.from('import-uploads').upload(storagePath, buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    if (uploadError) throw new Error(`Failed to upload fixture: ${uploadError.message}`);

    const { data: batch, error: batchError } = await admin
      .from('import_batches')
      .insert({
        uploaded_by: staffId,
        original_filename: ORIGINAL_FILENAME,
        file_checksum: `scale-5000-live-test-${Date.now()}`,
        storage_path: storagePath,
        sheet_name: SHEET_NAME,
        status: 'analyzing',
      })
      .select('id')
      .single();
    if (batchError || !batch) throw new Error(`Failed to create batch: ${batchError?.message}`);
    importBatchId = batch.id;

    const parseStart = performance.now();
    const headers = await extractHeaderRow(buffer, SHEET_NAME);
    const emailColumnIndex = headers.findIndex((h) => h === 'Email');
    expect(emailColumnIndex).toBeGreaterThanOrEqual(0);

    const mappingRows = headers.map((header, index) => {
      const suggestion = suggestMapping(header);
      expect(suggestion).toBeTruthy();
      expect(suggestion!.confidence).toBeGreaterThanOrEqual(MAPPING_CONFIDENCE_THRESHOLD);
      return {
        import_batch_id: importBatchId,
        source_column_index: index,
        source_column_header: header,
        target_kind: suggestion!.kind,
        target_key: suggestion!.key,
        is_manual_override: false,
        confidence: suggestion!.confidence,
      };
    });
    const { error: mappingError } = await admin.from('import_column_mappings').insert(mappingRows);
    if (mappingError) throw new Error(`Failed to save mappings: ${mappingError.message}`);

    await admin
      .from('import_batches')
      .update({ status: 'validating', unique_identifier_column_index: emailColumnIndex })
      .eq('id', importBatchId);
    timings.parseAndMapMs = performance.now() - parseStart;

    const validateStart = performance.now();
    const validationResult = await runValidationForCaller(importBatchId, caller);
    timings.validationMs = performance.now() - validateStart;

    expect(validationResult.errorCount).toBe(0);
    expect(validationResult.duplicateCount).toBe(0);
    expect(validationResult.validCount).toBe(EXPECTED_ROW_COUNT);

    const { data: afterValidate } = await admin
      .from('import_batches')
      .select('status, row_count')
      .eq('id', importBatchId)
      .single();
    expect(afterValidate?.status).toBe('ready_to_import');
    expect(afterValidate?.row_count).toBe(EXPECTED_ROW_COUNT);

    const importStart = performance.now();
    const { lockToken } = await startImportForCaller(importBatchId, caller);
    let guard = 0;
    let last: Awaited<ReturnType<typeof processImportChunkForCaller>> | undefined;
    while (!last?.isComplete && guard++ < 200) {
      last = await processImportChunkForCaller({ batchId: importBatchId, lockToken }, caller);
    }
    timings.importMs = performance.now() - importStart;
    expect(last?.isComplete).toBe(true);

    timings.totalMs = performance.now() - overallStart;

    const { data: finalBatch } = await admin
      .from('import_batches')
      .select('status, inserted_count, updated_count, skipped_count')
      .eq('id', importBatchId)
      .single();
    expect(finalBatch?.status).toBe('imported');
    expect(finalBatch?.inserted_count).toBe(EXPECTED_ROW_COUNT);
    expect(finalBatch?.updated_count).toBe(0);
    expect(finalBatch?.skipped_count).toBe(0);

    const rowsPerSecond = EXPECTED_ROW_COUNT / (timings.totalMs / 1000);

    console.log(
      `[scale-5000] parse+map: ${timings.parseAndMapMs.toFixed(0)}ms | ` +
        `validation: ${timings.validationMs.toFixed(0)}ms | ` +
        `import (chunk loop): ${timings.importMs.toFixed(0)}ms | ` +
        `total: ${timings.totalMs.toFixed(0)}ms | ` +
        `rows/sec (end-to-end): ${rowsPerSecond.toFixed(1)}`
    );
    // 30-minute timeout. Measured precedent from scale-500.test.ts (Task 25):
    // the confirm-import chunk loop is ~350ms per row against the live
    // Supabase project (one RPC call = one row = one transaction, by
    // design — see apply_import_row_transactional's per-row contract), so
    // 5,000 rows alone is ~29 minutes at that rate before parse/map/
    // validation are even added. Sized with real margin above that measured
    // floor rather than guessed.
  }, 1_800_000);
});
