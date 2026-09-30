// src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/types/database';
import { idSchema } from '@/lib/validation/import';
import { extractDataRows } from '@/lib/import/workbook-parser';
import { computeRowFingerprint } from '@/lib/import/normalization';
import { validateRow, classifyDuplicateStatus, type ColumnMapping } from '@/lib/import/row-validation';
import { toSafeCsv } from '@/lib/import/csv-export';
import { requireImportStaffCaller } from '@/lib/import/server-helpers';
import { writeAuditLog } from '@/lib/agenda/server-helpers';

type ServiceClient = SupabaseClient<Database>;
type ImportRowInsert = Database['public']['Tables']['import_rows']['Insert'];

// PostgREST sends `.in(...)` filters as a query-string parameter (GET), not
// a request body, so this is bounded by URL/header length, not by Postgres
// (which has no practical `IN` list limit). 500 emails at ~30 chars each
// (INSERT_CHUNK's size, tried first) reproducibly failed with a raw "fetch
// failed" against the live Supabase project — confirmed by testing, not
// assumed. 100 keeps each request comfortably under typical URL/header
// limits while still cutting 500 sequential single-row round trips down to
// 5 batched ones (and 5,000 rows down to 50, vs. 5,000).
const LOOKUP_CHUNK = 100;

async function chunkedIn<T>(
  items: string[],
  chunkSize: number,
  fn: (slice: string[]) => Promise<T[]>
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(...(await fn(items.slice(i, i + chunkSize))));
  }
  return out;
}

// Task 25 PERFORMANCE FIX. Originally one `applications` select PER ROW
// inside the validation loop (a classic N+1: 500 rows meant 500 sequential
// round trips to the live Supabase project, measured at ~350ms/query in
// this environment — over 170s just for this one lookup at 500-row scale,
// confirmed as the actual bottleneck behind scale-500.test.ts timing out at
// 300s during Task 25's investigation). Replaced with a single batched
// lookup keyed on the full set of distinct normalized emails in the file,
// resolved BEFORE the per-row loop runs. Every row's classification below
// now reads from an in-memory Map instead of issuing a query.
async function fetchExistingApplicationsByEmail(
  service: ServiceClient,
  emails: string[]
): Promise<Map<string, { id: string; applicantId: string | null }>> {
  const byEmail = new Map<string, { id: string; applicantId: string | null }>();
  if (emails.length === 0) return byEmail;
  const rows = await chunkedIn(emails, LOOKUP_CHUNK, async (slice) => {
    const { data, error } = await service.from('applications').select('id, applicant_id, imported_email').in('imported_email', slice);
    if (error) throw new Error(`Failed to look up existing applications: ${error.message}`);
    return data ?? [];
  });
  for (const r of rows) {
    if (r.imported_email) byEmail.set(r.imported_email, { id: r.id, applicantId: r.applicant_id });
  }
  return byEmail;
}

// Checks all five independent table families that reference an application
// downstream of import: feature extraction, clustering, allocation,
// schedule publication, and schedule-publication drafting. Each table's
// application_id column was confirmed directly against the real migrations
// in this worktree (participant_feature_snapshots.application_id in
// 20260723080000_feature_extraction_tables.sql,
// cluster_memberships.application_id in 20260723090000_clustering_tables.sql,
// allocation_assignments.application_id in 20260723100000_allocation_tables.sql,
// schedule_publications.application_id in
// 20260723140000_schedule_publication_tables.sql,
// schedule_publication_draft_items.application_id in
// 20260723160000_schedule_publication_draft_tables.sql) rather than assumed
// from the plan text alone — an earlier draft of this check only queried
// feature snapshots, an incomplete check flagged and fixed in plan review.
//
// MUST STAY IN SYNC with rollback_import_batch_transactional's blocker
// checks (supabase/migrations/20260727010000_wire_row_fingerprint_idempotent_reimport.sql,
// v_blocker_count checks). These two checks are meant to be the same
// predicate evaluated at two different times (preview-time vs rollback-
// time); a table present in one and missing from the other lets an import
// proceed at preview that rollback will then refuse to undo — exactly the
// gap found and closed here, where this function previously checked only 4
// of the 5 tables rollback blocks on, silently permitting an import to
// overwrite an application with a pending, unconfirmed schedule-publication
// draft attached, with no way to cleanly undo it afterward.
//
// Task 25 PERFORMANCE FIX: batched the same way as
// fetchExistingApplicationsByEmail above — this used to be N queries PER
// MATCHED ROW (only rows with an existing-email match reached it, but a
// re-import of a mostly-existing file would still mean thousands of round
// trips). Now it's N queries total for the whole batch, each filtered by
// `application_id IN (...)` over every matched application id at once.
async function fetchApplicationIdsWithDownstreamReference(
  service: ServiceClient,
  applicationIds: string[]
): Promise<Set<string>> {
  const withReference = new Set<string>();
  if (applicationIds.length === 0) return withReference;

  const tables = [
    'participant_feature_snapshots',
    'cluster_memberships',
    'allocation_assignments',
    'schedule_publications',
    'schedule_publication_draft_items',
  ] as const;
  await Promise.all(
    tables.map(async (table) => {
      const rows = await chunkedIn(applicationIds, LOOKUP_CHUNK, async (slice) => {
        const { data, error } = await service.from(table).select('application_id').in('application_id', slice);
        if (error) throw new Error(`Failed to check ${table} for downstream references: ${error.message}`);
        return data ?? [];
      });
      for (const r of rows) {
        if (r.application_id) withReference.add(r.application_id);
      }
    })
  );
  return withReference;
}

// Separated from the exported `runValidation` 'use server' action so it can
// be exercised directly by a live integration test with an already-
// authenticated { userId, service } pair. 'use server' functions cannot be
// invoked outside a Next.js request context (requireImportStaffCaller's
// createClient() calls next/headers' cookies(), which throws when called
// from a plain Node test process — the same constraint documented in
// tests/agenda/authorization.test.ts, which works around it by re-testing
// the role-check logic directly rather than calling the gated action). This
// split lets tests/import/validation-live.test.ts call the real DB-querying
// validation logic (workbook download, per-row validation, duplicate
// classification, the five-table downstream-reference check, import_rows
// insert, import_batches update) without needing a live HTTP request.
export async function runValidationForCaller(batchIdInput: unknown, caller: { userId: string; service: ServiceClient }) {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = caller;

  const { data: batch, error: batchError } = await service
    .from('import_batches')
    .select('status, storage_path, sheet_name, unique_identifier_column_index')
    .eq('id', batchId)
    .single();
  if (batchError || !batch) throw new Error('Batch not found');
  if (batch.status !== 'validating') throw new Error(`Batch is in status "${batch.status}", expected "validating"`);
  if (batch.unique_identifier_column_index === null) throw new Error('No unique identifier column was selected during mapping');

  const { data: mappingRows, error: mappingError } = await service
    .from('import_column_mappings')
    .select('source_column_index, target_kind, target_key')
    .eq('import_batch_id', batchId);
  if (mappingError) throw new Error(`Failed to load mappings: ${mappingError.message}`);
  const mapping: ColumnMapping[] = (mappingRows ?? []).map((m) => ({
    sourceColumnIndex: m.source_column_index,
    targetKind: m.target_kind as ColumnMapping['targetKind'],
    targetKey: m.target_key,
  }));

  const { data: fileData, error: downloadError } = await service.storage.from('import-uploads').download(batch.storage_path);
  if (downloadError || !fileData) throw new Error(`Failed to load stored file: ${downloadError?.message}`);
  const buffer = Buffer.from(await fileData.arrayBuffer());
  const dataRows = await extractDataRows(buffer, batch.sheet_name!, 1);

  // Task 25 PERFORMANCE FIX: pass 1 runs the pure, in-memory validation for
  // every row (no DB I/O) and collects the distinct normalized emails seen.
  // This intentionally duplicates none of validateRow's logic — it just
  // defers the two DB-touching steps (existing-application lookup,
  // downstream-reference check) that pass 2 below used to do inline, per
  // row, in the same loop. See fetchExistingApplicationsByEmail and
  // fetchApplicationIdsWithDownstreamReference above for why: at 500+ rows,
  // one round trip per row against the live Supabase project measured
  // ~350ms each — a genuine bottleneck, not a theoretical one.
  const perRowResults = dataRows.map((raw) =>
    validateRow(raw, mapping, { uniqueIdentifierColumnIndex: batch.unique_identifier_column_index! })
  );
  const distinctEmails = [
    ...new Set(perRowResults.map((r) => r.normalizedRow.email as string | undefined).filter((e): e is string => !!e)),
  ];

  const existingByEmail = await fetchExistingApplicationsByEmail(service, distinctEmails);
  const matchedApplicationIds = [...new Set([...existingByEmail.values()].map((a) => a.id))];
  const applicationIdsWithDownstreamReference = await fetchApplicationIdsWithDownstreamReference(service, matchedApplicationIds);

  // Pass 2: classify duplicates and build the insert rows, now purely from
  // in-memory data (perRowResults, existingByEmail,
  // applicationIdsWithDownstreamReference) — no DB I/O in this loop.
  const seenEmailsInFile = new Map<string, number>();
  const rowsToInsert: ImportRowInsert[] = [];
  // Row index (0-based, into dataRows) -> the EARLIER row index it duplicates
  // within this same file, for every row classified duplicate_in_file.
  // Deliberately kept separate from rowsToInsert rather than added as a
  // field on ImportRowInsert: the target is a UUID (import_rows.id), which
  // does not exist until after the bulk insert below, so this can only be
  // resolved and persisted in a second pass — see the excelRowNumberToId
  // linking loop after the insert.
  const duplicateOfRowIndexByRowIndex = new Map<number, number>();
  let validCount = 0,
    warningCount = 0,
    errorCount = 0,
    duplicateCount = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i];
    const result = perRowResults[i];
    const fingerprint = computeRowFingerprint(result.normalizedRow);

    let duplicateStatus: string | null = null;
    let destinationApplicationId: string | null = null;
    const email = result.normalizedRow.email as string | undefined;
    if (email) {
      // Downstream-reference check spans four independent table families
      // with no single join target — feature extraction, clustering,
      // allocation, and schedule publication all reference an application
      // by application_id but none of them reference each other, so this
      // must be four separate existence checks, not one query. Missing any
      // one of these was flagged in review as an incomplete check in an
      // earlier draft of this plan — all four are required and were
      // re-verified against the live migration files above. (Now checked in
      // bulk before this loop, not per row — see
      // fetchApplicationIdsWithDownstreamReference.)
      const existing = existingByEmail.get(email) ?? null;
      const hasDownstreamReference = existing ? applicationIdsWithDownstreamReference.has(existing.id) : false;
      const classification = classifyDuplicateStatus(email, {
        seenEmailsInFile,
        rowIndex: i,
        existingApplication: existing ? { id: existing.id, applicantId: existing.applicantId, hasDownstreamReference } : null,
      });
      if (classification) {
        duplicateStatus = classification.status;
        duplicateCount++;
        if ('applicationId' in classification) destinationApplicationId = classification.applicationId;
        if (classification.status === 'duplicate_in_file') {
          duplicateOfRowIndexByRowIndex.set(i, classification.duplicateOfRowIndex);
        }
      }
      seenEmailsInFile.set(email, i);
    }

    if (result.status === 'valid') validCount++;
    else if (result.status === 'warning') warningCount++;
    else errorCount++;

    rowsToInsert.push({
      import_batch_id: batchId,
      excel_row_number: i + 2, // +1 for 1-indexing, +1 for the header row already consumed
      row_fingerprint: fingerprint,
      raw_row: raw as unknown as Json,
      normalized_row: result.normalizedRow as unknown as Json,
      validation_status: result.status,
      warnings: result.warnings as unknown as Json,
      errors: result.errors as unknown as Json,
      duplicate_status: duplicateStatus,
      destination_application_id: destinationApplicationId,
    });
  }

  // Bulk insert in chunks to avoid one giant statement for 5,000 rows. If a
  // later chunk fails, earlier chunks remain in import_rows and the batch
  // status is never advanced past "validating" — the batch is left in a
  // partially-populated, re-runnable state rather than silently marked
  // ready. This is an accepted gap for this single-shot pre-pass (Task 15
  // owns the chunked/resumable/locked write path); a caller can re-invoke
  // runValidation, but doing so today would re-insert duplicate import_rows
  // for the chunks that already landed rather than resuming cleanly. Flagged
  // here for reviewers rather than fixed, per this task's scope.
  const INSERT_CHUNK = 500;
  // Every inserted row's real id, keyed by excel_row_number, so the linking
  // pass below can resolve duplicateOfRowIndex (a 0-based dataRows index) to
  // the actual UUID it needs to reference. select('id, excel_row_number')
  // on the same insert call avoids a second round trip per chunk.
  const idByExcelRowNumber = new Map<number, string>();
  for (let i = 0; i < rowsToInsert.length; i += INSERT_CHUNK) {
    const { data: inserted, error: insertError } = await service
      .from('import_rows')
      .insert(rowsToInsert.slice(i, i + INSERT_CHUNK))
      .select('id, excel_row_number');
    if (insertError) throw new Error(`Failed to save validated rows: ${insertError.message}`);
    for (const row of inserted ?? []) idByExcelRowNumber.set(row.excel_row_number, row.id);
  }

  // Second pass: persist import_rows.duplicate_of_row_id now that every
  // row's real UUID is known. dataRows index -> excel_row_number is a fixed
  // +2 offset (established in the insert loop above: excel_row_number =
  // i + 2), applied to BOTH the duplicate row and the row it duplicates, so
  // no separate index->id map is needed beyond idByExcelRowNumber.
  //
  // Chunked and awaited sequentially like the insert above, for the same
  // reason: a large batch could have thousands of duplicate_in_file rows to
  // link, and one UPDATE per row would be as wasteful as the N+1 patterns
  // Task 25 fixed elsewhere in this file. Grouped by target row id (via
  // `.in('id', ...)`) is not possible here since each row links to a
  // DIFFERENT target — this remains one UPDATE per duplicate row, but that
  // is bounded by duplicateCount, not by the full row count, and duplicate
  // rows are expected to be a small fraction of any real import.
  for (const [rowIndex, duplicateOfRowIndex] of duplicateOfRowIndexByRowIndex) {
    const rowExcelNumber = rowIndex + 2;
    const targetExcelNumber = duplicateOfRowIndex + 2;
    const rowId = idByExcelRowNumber.get(rowExcelNumber);
    const targetId = idByExcelRowNumber.get(targetExcelNumber);
    if (!rowId || !targetId) {
      // Should be unreachable — every row in rowsToInsert was just inserted
      // and captured above — but never silently skip a real inconsistency;
      // surfacing it here is far cheaper than debugging a NULL
      // duplicate_of_row_id later with no error trail at all.
      throw new Error(
        `Failed to link duplicate_of_row_id: could not resolve id for excel row ${rowExcelNumber} or its duplicate target ${targetExcelNumber}`
      );
    }
    const { error: linkError } = await service.from('import_rows').update({ duplicate_of_row_id: targetId }).eq('id', rowId);
    if (linkError) throw new Error(`Failed to link duplicate_of_row_id for row ${rowExcelNumber}: ${linkError.message}`);
  }

  await service
    .from('import_batches')
    .update({
      status: 'ready_to_import',
      row_count: rowsToInsert.length,
      valid_count: validCount,
      warning_count: warningCount,
      error_count: errorCount,
      duplicate_count: duplicateCount,
    })
    .eq('id', batchId);
  await writeAuditLog(service, {
    entityType: 'import_batch',
    entityId: batchId,
    action: 'validate',
    actorId: userId,
    metadata: { validCount, warningCount, errorCount, duplicateCount },
  });

  return { validCount, warningCount, errorCount, duplicateCount };
}

export async function runValidation(batchIdInput: unknown) {
  const caller = await requireImportStaffCaller();
  return runValidationForCaller(batchIdInput, caller);
}

export async function getPreviewRows(batchIdInput: unknown, filter?: 'all' | 'valid' | 'warning' | 'invalid' | 'duplicate') {
  const batchId = idSchema.parse(batchIdInput);
  const { service } = await requireImportStaffCaller();
  // Self-join to resolve duplicate_of_row_id to a human-readable
  // excel_row_number in one query, rather than making the client either
  // display a raw UUID or issue N follow-up lookups for N duplicate rows.
  // PostgREST resolves this via the FK relationship declared on
  // import_rows.duplicate_of_row_id (references import_rows(id)); the alias
  // is required because import_rows is joining to itself.
  let query = service
    .from('import_rows')
    .select('*, duplicate_of_row:duplicate_of_row_id(excel_row_number)')
    .eq('import_batch_id', batchId)
    .order('excel_row_number', { ascending: true });
  if (filter === 'valid') query = query.eq('validation_status', 'valid');
  if (filter === 'warning') query = query.eq('validation_status', 'warning');
  if (filter === 'invalid') query = query.eq('validation_status', 'invalid');
  if (filter === 'duplicate') query = query.not('duplicate_status', 'is', null);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load preview rows: ${error.message}`);
  return data ?? [];
}

/**
 * Design-spec-required gate (Task 28 fix). A row classified
 * `existing_claimed` (its destination is an already-claimed, active
 * participant, not a staging row) is not applied by
 * apply_import_row_transactional until this action has been explicitly
 * invoked for its batch — see the RPC's `claimed_update_approved` check
 * (supabase/migrations/20260727030000_gate_existing_claimed_updates.sql)
 * and that migration's full rationale.
 *
 * CRITICAL, non-obvious detail: this must also clear `action_taken` back to
 * null for any row it approves. apply_import_row_transactional's very first
 * check is `if action_taken is not null then return 'already_applied'` — an
 * unapproved existing_claimed row gets stamped action_taken = 'blocked' the
 * first time confirm-import's chunk loop reaches it (before this action can
 * ever run, since approval only happens from the preview screen, earlier in
 * the flow, but a batch that was confirmed once, had rows blocked, and is
 * now being resumed after approval is exactly the real sequence this exists
 * for). Without resetting action_taken here, a 'blocked' row is permanently
 * inert: the RPC would return 'already_applied' forever, regardless of
 * claimed_update_approved, and approving would silently do nothing through
 * the normal confirm/resume flow. Only rows already marked 'blocked' are
 * reset — a row that hasn't been attempted yet (action_taken still null)
 * needs no reset, and a row already 'updated'/'inserted' by an earlier,
 * legitimate apply must never be touched by this action at all.
 *
 * Batch-scoped (approves every existing_claimed row in the batch at once)
 * rather than per-row, matching this preview UI's existing granularity —
 * every other control on this page (validate, download error report,
 * proceed to confirm) is batch-scoped, and there is no per-row action
 * infrastructure elsewhere in this feature to extend. An admin who wants
 * finer-grained control can still exclude specific claimed-participant rows
 * from the source file and re-upload before this step.
 *
 * Idempotent and safe to call multiple times or on a batch with zero
 * existing_claimed rows (a no-op UPDATE, not an error) — the confirm step
 * does not require this to have been called at all when there are no
 * existing_claimed rows to approve.
 *
 * KNOWN LIMITATION, intentionally not solved here: if a batch has already
 * reached `imported` status (the confirm chunk loop ran to completion with
 * some existing_claimed rows left `blocked`), approving afterward correctly
 * clears their action_taken, but nothing in this feature can re-open an
 * `imported` batch's chunk loop to actually re-apply them —
 * processImportChunkForCaller and resumeImportBatchForCaller both require
 * `status = 'importing'`. This is the same category of gap that already
 * exists for skipped_error rows (no "patch and retry one row" path exists
 * anywhere in this feature). The primary, UI-guided flow (the preview
 * screen's warning banner is shown and the approve button is available
 * BEFORE the "Proceed to confirm" button) avoids this entirely — approve,
 * then confirm, and every approved row applies correctly on its one and
 * only chunk pass. Re-opening a completed batch's confirm loop would be a
 * real design change (touching the state machine and the offset-based
 * pagination's ordering assumption), out of scope for this fix.
 */
export async function approveClaimedUpdatesForCaller(batchIdInput: unknown, caller: { userId: string; service: ServiceClient }) {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = caller;

  // Named claimedRowCount, not approvedCount — this is "how many
  // existing_claimed rows exist in the batch" (the UPDATE re-affirms
  // claimed_update_approved = true even on a row already approved by an
  // earlier call), not "how many were newly approved by THIS call". Kept
  // distinct from unblockedRowCount below so the audit trail and caller can
  // tell a first real approval from a harmless re-affirmation.
  const { data, error } = await service
    .from('import_rows')
    .update({ claimed_update_approved: true })
    .eq('import_batch_id', batchId)
    .eq('duplicate_status', 'existing_claimed')
    .select('id');
  if (error) throw new Error(`Failed to approve claimed-participant updates: ${error.message}`);
  const claimedRowCount = data?.length ?? 0;

  // Reset only rows this approval just unblocked — never touch a row
  // already legitimately 'inserted'/'updated'/'skipped_unchanged'/
  // 'skipped_error' by a real apply, since re-nulling those would make the
  // chunk loop re-process them, silently duplicating work or overwriting a
  // row that was correctly skipped for an unrelated reason (e.g.
  // validation_status = 'invalid').
  const { data: unblocked, error: unblockError } = await service
    .from('import_rows')
    .update({ action_taken: null })
    .eq('import_batch_id', batchId)
    .eq('duplicate_status', 'existing_claimed')
    .eq('action_taken', 'blocked')
    .select('id');
  if (unblockError) throw new Error(`Failed to re-enable blocked claimed-participant rows: ${unblockError.message}`);
  const unblockedRowCount = unblocked?.length ?? 0;

  await writeAuditLog(service, {
    entityType: 'import_batch',
    entityId: batchId,
    action: 'approve_claimed_updates',
    actorId: userId,
    metadata: { claimedRowCount, unblockedRowCount },
  });

  return { claimedRowCount, unblockedRowCount };
}

export async function approveClaimedUpdates(batchIdInput: unknown) {
  const caller = await requireImportStaffCaller();
  return approveClaimedUpdatesForCaller(batchIdInput, caller);
}

// Task 8 (spec §3.3): lets staff correct a mis-mapped/mis-detected
// participant_type directly on the import preview screen, BEFORE
// apply_import_row_transactional ever runs — this only ever touches
// import_rows.normalized_row (jsonb), never an applications row, so none of
// the reclassify/reissue/QR/email machinery used elsewhere in this plan
// (e.g. src/lib/participants/reclassify.ts) applies here at all.
const PARTICIPANT_TYPES = ['delegate', 'volunteer', 'knowledge_partner', 'youngo', 'speaker'] as const;

export async function updateRowParticipantTypeForCaller(
  importRowId: string,
  newParticipantType: (typeof PARTICIPANT_TYPES)[number],
  caller: { userId: string; service: ServiceClient }
): Promise<{ error: string | null }> {
  const { service } = caller;
  const { data: row, error: fetchError } = await service
    .from('import_rows')
    .select('normalized_row')
    .eq('id', importRowId)
    .single();
  if (fetchError || !row) return { error: 'Import row not found' };

  const updatedNormalized = { ...((row.normalized_row as Record<string, unknown>) ?? {}), participant_type: newParticipantType };
  const { error: updateError } = await service
    .from('import_rows')
    .update({ normalized_row: updatedNormalized as Json })
    .eq('id', importRowId);
  if (updateError) return { error: updateError.message };
  return { error: null };
}

export async function updateRowParticipantType(importRowId: string, newParticipantType: (typeof PARTICIPANT_TYPES)[number]) {
  const caller = await requireImportStaffCaller();
  return updateRowParticipantTypeForCaller(importRowId, newParticipantType, caller);
}

export async function downloadErrorReport(batchIdInput: unknown): Promise<string> {
  const batchId = idSchema.parse(batchIdInput);
  const { service } = await requireImportStaffCaller();
  const { data: rows, error } = await service
    .from('import_rows')
    .select('excel_row_number, errors, raw_row')
    .eq('import_batch_id', batchId)
    .neq('validation_status', 'valid');
  if (error) throw new Error(`Failed to load error rows: ${error.message}`);

  const csvRows: string[][] = [];
  for (const row of rows ?? []) {
    const errs = row.errors as { column: string; originalValue: string | null; error: string }[];
    for (const e of errs) {
      csvRows.push([String(row.excel_row_number), e.column, e.originalValue ?? '', e.error]);
    }
  }
  return toSafeCsv(['Excel Row', 'Column', 'Original Value', 'Error'], csvRows);
}
