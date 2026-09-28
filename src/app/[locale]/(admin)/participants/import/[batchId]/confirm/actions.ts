// src/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { processChunkSchema, idSchema, CHUNK_SIZE, LOCK_TTL_SECONDS } from '@/lib/validation/import';
import { requireImportStaffCaller } from '@/lib/import/server-helpers';
import { writeAuditLog } from '@/lib/agenda/server-helpers';

type ServiceClient = SupabaseClient<Database>;

// Uses requireImportStaffCaller (src/lib/import/server-helpers.ts), which
// accepts both agenda_allocation_manager and participants_communications_
// manager — the import pipeline is a shared responsibility between the two
// roles. Deliberately not requireAgendaStaffCaller, which stays scoped to
// agenda/allocation/schedule-publication actions only.

export interface ProcessChunkResult {
  processedInChunk: number;
  isComplete: boolean;
  counts: { inserted: number; updated: number; skipped: number };
  totalRows: number;
  nextOffset: number;
}

/**
 * Recompute the batch's cumulative outcome counts directly from
 * import_rows.action_taken.
 *
 * GAP #1 RESOLUTION. The plan's illustrative processImportChunk wrote
 * `inserted_count: counts.inserted` — this chunk's count only, overwriting
 * (not accumulating) the totals from every previous chunk, so a multi-chunk
 * import always ended up reporting just the last chunk's numbers.
 *
 * The plan offered two fixes and recommended this one: recompute totals with
 * COUNT queries over the authoritative action_taken column after each chunk,
 * rather than a read-current-then-add read-modify-write. Chosen because
 * read-modify-write races with resumeImportBatch (and with any retried chunk)
 * — two interleaved read-then-add sequences lose an increment — whereas
 * recomputing from action_taken is derived state that is correct no matter
 * how many times a chunk is retried, resumed, or partially applied. The
 * counts can only ever equal what actually landed in the table.
 */
async function recomputeBatchCounts(service: ServiceClient, batchId: string) {
  const countFor = async (actions: string[]) => {
    const { count, error } = await service
      .from('import_rows')
      .select('id', { count: 'exact', head: true })
      .eq('import_batch_id', batchId)
      .in('action_taken', actions);
    if (error) throw new Error(`Failed to count import rows: ${error.message}`);
    return count ?? 0;
  };

  const [inserted, updated, skipped] = await Promise.all([
    countFor(['inserted']),
    countFor(['updated']),
    // 'skipped_unchanged', 'skipped_error' and 'blocked' are all
    // "not written to applications" outcomes and roll up into skipped_count,
    // matching the action_taken check constraint's full value domain from
    // 20260726102000_import_staging_tables.sql.
    countFor(['skipped_unchanged', 'skipped_error', 'blocked']),
  ]);
  return { inserted, updated, skipped };
}

export async function startImportForCaller(batchIdInput: unknown, caller: { userId: string; service: ServiceClient }) {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = caller;

  const lockToken = crypto.randomUUID();
  const lockExpiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString();

  // Pre-flight guard: only a batch in 'ready_to_import' can start. The
  // `.eq('status', 'ready_to_import')` predicate on the UPDATE itself is what
  // closes the "confirm called twice" race — the second concurrent call
  // matches zero rows because the first already moved the batch to
  // 'importing', so it errors out instead of minting a second lock token.
  // Same guard shape as Phase 5's confirm_publication_transactional.
  const { data: updated, error } = await service
    .from('import_batches')
    .update({
      status: 'importing',
      processing_lock_token: lockToken,
      processing_lock_expires_at: lockExpiresAt,
      next_chunk_offset: 0,
      confirmed_at: new Date().toISOString(),
    })
    .eq('id', batchId)
    .eq('status', 'ready_to_import')
    .select('id')
    .maybeSingle();
  if (error || !updated) throw new Error('Batch is not ready to import, or is already being imported');

  await writeAuditLog(service, {
    entityType: 'import_batch',
    entityId: batchId,
    action: 'confirm_import',
    actorId: userId,
  });
  return { lockToken };
}

export async function startImport(batchIdInput: unknown) {
  const caller = await requireImportStaffCaller();
  return startImportForCaller(batchIdInput, caller);
}

export async function resumeImportBatchForCaller(batchIdInput: unknown, caller: { userId: string; service: ServiceClient }) {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = caller;

  const { data: batch, error: fetchError } = await service
    .from('import_batches')
    .select('status, processing_lock_expires_at')
    .eq('id', batchId)
    .single();
  if (fetchError || !batch) throw new Error('Batch not found');
  if (batch.status !== 'importing') throw new Error(`Batch is in status "${batch.status}", cannot resume`);

  const lockExpired = !batch.processing_lock_expires_at || new Date(batch.processing_lock_expires_at) < new Date();
  if (!lockExpired) throw new Error('Batch is currently being processed by another session');

  const lockToken = crypto.randomUUID();
  const lockExpiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString();
  // Deviation from the plan's draft: the status re-check is kept, and the
  // expiry predicate is repeated in the WHERE clause too
  // (`processing_lock_expires_at < now`). The plan only re-checked status,
  // which leaves a window where two sessions both observe an expired lock,
  // both pass the JS check, and both write a token — the later write silently
  // wins and the earlier caller believes it holds a lock it does not. Adding
  // the expiry predicate makes the takeover conditional on the lock still
  // being expired at write time, and .select() lets us detect losing the race.
  const nowIso = new Date().toISOString();
  const { data: resumed, error: updateError } = await service
    .from('import_batches')
    .update({ processing_lock_token: lockToken, processing_lock_expires_at: lockExpiresAt })
    .eq('id', batchId)
    .eq('status', 'importing')
    .or(`processing_lock_expires_at.is.null,processing_lock_expires_at.lt.${nowIso}`)
    .select('id')
    .maybeSingle();
  if (updateError) throw new Error(`Failed to resume batch: ${updateError.message}`);
  if (!resumed) throw new Error('Batch is currently being processed by another session');

  await writeAuditLog(service, {
    entityType: 'import_batch',
    entityId: batchId,
    action: 'resume_import',
    actorId: userId,
  });
  return { lockToken };
}

export async function resumeImportBatch(batchIdInput: unknown) {
  const caller = await requireImportStaffCaller();
  return resumeImportBatchForCaller(batchIdInput, caller);
}

export async function processImportChunkForCaller(
  input: unknown,
  caller: { userId: string; service: ServiceClient }
): Promise<ProcessChunkResult> {
  const parsed = processChunkSchema.parse(input);
  const { userId, service } = caller;

  const { data: batch, error: batchError } = await service
    .from('import_batches')
    .select('status, processing_lock_token, processing_lock_expires_at, next_chunk_offset, row_count')
    .eq('id', parsed.batchId)
    .single();
  if (batchError || !batch) throw new Error('Batch not found');
  if (batch.status !== 'importing') throw new Error(`Batch is in status "${batch.status}", not importing`);
  if (batch.processing_lock_token !== parsed.lockToken) {
    throw new Error('Invalid or superseded processing lock — this batch may be running in another session');
  }
  if (!batch.processing_lock_expires_at || new Date(batch.processing_lock_expires_at) < new Date()) {
    throw new Error('Processing lock has expired — call resumeImportBatch to continue');
  }

  const offset = batch.next_chunk_offset;
  // Paginated by .range() over a deterministic excel_row_number ordering
  // rather than the plan's `.gte('excel_row_number', offset + 2)`. The plan's
  // form assumes excel_row_number values are gapless and start at exactly 2,
  // so any gap (or a batch whose rows don't begin at 2) silently skips or
  // re-reads rows. Offset-based ranging over the ordered set is correct for
  // any row-number distribution, and import_rows rows are never inserted or
  // deleted mid-import, so the offset stays stable across chunks.
  const { data: rows, error: rowsError } = await service
    .from('import_rows')
    .select('id')
    .eq('import_batch_id', parsed.batchId)
    .order('excel_row_number', { ascending: true })
    .range(offset, offset + CHUNK_SIZE - 1);
  if (rowsError) throw new Error(`Failed to load rows: ${rowsError.message}`);

  const chunkRows = rows ?? [];
  const rowFailures: { importRowId: string; message: string }[] = [];

  // Task 25 scale fix: rows within a chunk are applied with bounded
  // concurrency instead of one-at-a-time, cutting the chunk-loop's dominant
  // cost (network round-trip latency per RPC call) by roughly ROW_CONCURRENCY.
  //
  // WHY THIS IS SAFE — verified against apply_import_row_transactional's
  // body before making this change, not assumed (re-verified again when a
  // 4th revision added the existing_claimed approval gate: a blocked row
  // takes no `applications` lock at all, which only strengthens the
  // no-contention argument below, never weakens it):
  //   - Two rows in the same chunk never lock the same `applications` row.
  //     The only cross-row shared lock the RPC takes is `FOR UPDATE` on the
  //     destination application on the existing_unclaimed/existing_claimed
  //     path, and Task 10's validation already collapses any two rows in a
  //     file that target the same existing application to
  //     duplicate_status = 'duplicate_in_file' before this loop ever runs —
  //     that row short-circuits inside the RPC with no application lock
  //     taken at all. So within one chunk, at most one row targets any given
  //     applications.id: no two concurrent calls can contend, hence no
  //     deadlock and no need to serialize them relative to each other. This
  //     relies on destination_application_id being an injective function of
  //     the row's normalized email (one applications.imported_email column
  //     per row, plus the within-file email dedup above) — if a second
  //     matching key (e.g. phone-based matching) is ever added, re-verify
  //     that injectivity holds before keeping this loop concurrent.
  //   - The insert path takes no cross-row lock: `next_application_number()`
  //     is `nextval()`-backed (20260722123016_application_number_function.sql),
  //     which is atomic and race-free under concurrent callers by
  //     definition — concurrent inserts cannot collide or skip.
  //   - Each row's RPC call is already its own independent Postgres
  //     transaction (PostgREST wraps every rpc() call in its own tx); running
  //     several concurrently is running several independent transactions
  //     concurrently, which is exactly what a database is for.
  //   - Chunk-to-chunk sequencing is untouched: this only parallelizes rows
  //     *within* a single chunk. next_chunk_offset still only advances after
  //     every row in the chunk (success or caught failure) has settled, so
  //     resumability, the processing-lock re-check on the next chunk call,
  //     and rollback's per-batch scan of import_rows are all unaffected.
  //
  // Bounded (not full chunk-width Promise.all) deliberately: capping
  // concurrent RPC calls avoids bursting up to CHUNK_SIZE (250) simultaneous
  // connections against the live Supabase project per chunk, which risks
  // exhausting its connection pool or tripping Supabase-side rate limiting —
  // untested and unnecessary when a modest pool already captures nearly all
  // the available speedup (the cost is network round-trip latency, not
  // server-side work, so beyond a small pool size additional concurrency
  // yields diminishing returns).
  const ROW_CONCURRENCY = 15;

  const applyOneRow = async (row: { id: string }) => {
    // A single row whose apply raises (e.g. a pathological cell value the
    // RPC's dynamic UPDATE can't coerce) used to abort the whole chunk and
    // permanently wedge the batch: next_chunk_offset never advances, so every
    // resume re-hits the same poison row forever. Each row's RPC call is
    // already its own transaction (see apply_import_row_transactional's
    // atomicity guarantee) and rolls back cleanly on error, so it's safe to
    // catch here, stamp the row skipped_error, and let the chunk continue —
    // the offset then advances past it and the import can complete. Caught
    // per-row (not per-batch-of-concurrent-calls) so one poison row cannot
    // abort its concurrently-running siblings.
    try {
      // The outcome string itself isn't accumulated here — GAP #1's fix
      // (recomputeBatchCounts, below) always recomputes cumulative totals
      // from import_rows.action_taken after the chunk settles, which is
      // correct regardless of completion order under concurrency. A
      // per-call tally here would be redundant with that and, worse, a live
      // trap: if a future edit "helpfully" used a local tally instead of
      // recomputeBatchCounts's totals, it would silently reintroduce GAP #1
      // in its original form (only the last chunk's/last concurrent
      // slice's numbers surviving). Only failures are tracked locally,
      // for the audit-log write below.
      await applyImportRow(service, parsed.batchId, row.id, userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error applying row';
      rowFailures.push({ importRowId: row.id, message });
      const { error: skipError } = await service
        .from('import_rows')
        .update({ action_taken: 'skipped_error' })
        .eq('id', row.id)
        .is('action_taken', null); // never overwrite an outcome another call already recorded
      if (skipError) {
        // Stamping the failure itself failed — surface the original error
        // rather than the stamping error, and abort the chunk as before,
        // since we can no longer guarantee the offset can safely advance
        // past this row without risking a silent re-processing loop.
        throw new Error(message);
      }
    }
  };

  for (let i = 0; i < chunkRows.length; i += ROW_CONCURRENCY) {
    const slice = chunkRows.slice(i, i + ROW_CONCURRENCY);
    // Promise.all is safe here specifically because applyOneRow never
    // rejects — every throwable path inside it is caught and converted to a
    // skipped_error stamp, except the re-throw when stamping the failure
    // itself fails. That re-throw intentionally aborts the whole chunk (see
    // the comment at the throw site), matching the pre-existing sequential
    // loop's behavior for that same unrecoverable case.
    await Promise.all(slice.map(applyOneRow));
  }
  if (rowFailures.length > 0) {
    await writeAuditLog(service, {
      entityType: 'import_batch',
      entityId: parsed.batchId,
      action: 'row_apply_failed',
      actorId: userId,
      metadata: { failures: rowFailures },
    });
  }

  const newOffset = offset + chunkRows.length;
  const totalRows = batch.row_count ?? 0;
  const isComplete = chunkRows.length < CHUNK_SIZE || newOffset >= totalRows;
  const newLockExpiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString();

  // GAP #1 RESOLUTION in use: cumulative totals recomputed from
  // import_rows.action_taken, never this chunk's counts alone.
  const totals = await recomputeBatchCounts(service, parsed.batchId);

  // The lock-token predicate is repeated on this write so a chunk whose lock
  // was superseded mid-flight (e.g. it ran long enough for the TTL to lapse
  // and another session to resume) cannot clobber the new holder's offset.
  const { error: updateError } = await service
    .from('import_batches')
    .update({
      next_chunk_offset: newOffset,
      processing_lock_expires_at: isComplete ? null : newLockExpiresAt,
      processing_lock_token: isComplete ? null : parsed.lockToken,
      status: isComplete ? 'imported' : 'importing',
      inserted_count: totals.inserted,
      updated_count: totals.updated,
      skipped_count: totals.skipped,
      completed_at: isComplete ? new Date().toISOString() : null,
    })
    .eq('id', parsed.batchId)
    .eq('processing_lock_token', parsed.lockToken);
  if (updateError) throw new Error(`Failed to update batch progress: ${updateError.message}`);

  if (isComplete) {
    await writeAuditLog(service, {
      entityType: 'import_batch',
      entityId: parsed.batchId,
      action: 'complete_import',
      actorId: userId,
      metadata: { ...totals, rowCount: totalRows },
    });
  }

  return { processedInChunk: chunkRows.length, isComplete, counts: totals, totalRows, nextOffset: newOffset };
}

export async function processImportChunk(input: unknown): Promise<ProcessChunkResult> {
  const caller = await requireImportStaffCaller();
  return processImportChunkForCaller(input, caller);
}

/**
 * GAP #3 RESOLUTION. Every per-row write — before-image snapshot capture,
 * the application insert-or-update, the application_answers upsert, the
 * application_status_history insert, the audit_logs insert, and the
 * import_rows.action_taken stamp — happens inside a single plpgsql function,
 * apply_import_row_transactional. Originally
 * supabase/migrations/20260726108000_apply_import_row_function.sql;
 * superseded three times since via `create or replace function` — the
 * current (4th revision) body lives in
 * 20260727030000_gate_existing_claimed_updates.sql, check that file (or
 * whichever later migration next replaces it — do not trust this reference
 * to stay current across future revisions) for the live behavior. Every
 * revision, this is still one plpgsql function and therefore one Postgres
 * transaction per row.
 *
 * The plan's illustrative version issued those as five-plus separate
 * supabase-js awaits, so a concurrent reader could observe an application
 * already overwritten while its before-image snapshot had not yet been
 * persisted — and a crash in that window destroyed the only record Task 16's
 * rollback could restore from. Neither is possible now: PostgREST wraps each
 * RPC call in its own transaction, the function body contains no
 * error-swallowing exception handler around any write, and the function takes
 * a FOR UPDATE lock on both the import row and (on the update path) the
 * target application. The call either fully lands or fully rolls back.
 */
async function applyImportRow(
  service: ServiceClient,
  batchId: string,
  importRowId: string,
  actorId: string
): Promise<'inserted' | 'updated' | 'skipped' | 'already_applied'> {
  const { data, error } = await service.rpc('apply_import_row_transactional', {
    p_import_row_id: importRowId,
    p_import_batch_id: batchId,
    p_actor_id: actorId,
  });
  if (error) throw new Error(`Failed to apply import row ${importRowId}: ${error.message}`);
  return data as 'inserted' | 'updated' | 'skipped' | 'already_applied';
}

export async function getImportBatchStatus(batchIdInput: unknown) {
  const batchId = idSchema.parse(batchIdInput);
  const { service } = await requireImportStaffCaller();
  const { data, error } = await service
    .from('import_batches')
    .select('id, status, row_count, next_chunk_offset, inserted_count, updated_count, skipped_count, completed_at')
    .eq('id', batchId)
    .single();
  if (error || !data) throw new Error('Batch not found');
  return data;
}
