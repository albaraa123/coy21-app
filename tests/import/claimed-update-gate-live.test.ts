// tests/import/claimed-update-gate-live.test.ts
//
// Live integration coverage for the Task 28 fix (real, not committed as a
// separate numbered plan task): the design spec's step-10 "review-required
// update" requirement for a row matching an ALREADY-CLAIMED application.
// The final whole-phase spec-compliance review found apply_import_row_
// transactional had always collapsed existing_unclaimed and
// existing_claimed into one auto-applying branch, silently overwriting
// active participants' data with no distinct safeguard — see
// supabase/migrations/20260727030000_gate_existing_claimed_updates.sql for
// the full rationale and fix.
//
// This test proves, directly against the live RPC, that:
//   1. An existing_claimed row is classified 'blocked' (not applied) when
//      claimed_update_approved is false — the default for every row.
//   2. approveClaimedUpdatesForCaller flips the flag for exactly the
//      existing_claimed rows in a batch, is audited, and is idempotent.
//   3. After approval, the same row applies as 'updated' with a captured
//      before-image, identically to the existing_unclaimed path.
//   4. existing_unclaimed rows are completely unaffected by any of this —
//      they apply unconditionally regardless of claimed_update_approved.
//
// No local Postgres exists for this project — every assertion here runs
// against the live linked Supabase project, following the exact fixture and
// cleanup patterns established in tests/import/confirm-import-live.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  runValidationForCaller,
  approveClaimedUpdatesForCaller,
} from '@/app/[locale]/(admin)/participants/import/[batchId]/preview/actions';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const EMAIL_PREFIX = 'claimed-gate-live-';
const STAFF_EMAIL = `${EMAIL_PREFIX}staff@test.local`;
const CLAIMED_PARTICIPANT_EMAIL = `${EMAIL_PREFIX}claimed-participant@test.local`;
const CLAIMED_APPLICATION_EMAIL = `${EMAIL_PREFIX}claimed@example.com`;
const UNCLAIMED_APPLICATION_EMAIL = `${EMAIL_PREFIX}unclaimed@example.com`;
const PASSWORD = 'password123';

let staffId: string;
let claimedParticipantUserId: string;
let claimedApplicationId: string;
let unclaimedApplicationId: string;
let importBatchId: string;
let storagePath: string;
let importColumnMappingIds: string[] = [];

// Same reuse-on-failure pattern established across every live test fixed in
// this Task 28 pass — see confirm-import-live.test.ts's identical helper
// for the full rationale (deleteUser can fail persistently, not just
// transiently, for a given user id).
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
  ws.addRow(['Full Name', 'Email', 'Organization']);
  // Row 2: matches the claimed application -> existing_claimed.
  ws.addRow(['Claimed Person Updated', CLAIMED_APPLICATION_EMAIL, 'Updated Claimed Org']);
  // Row 3: matches the unclaimed application -> existing_unclaimed, proving
  // the gate does NOT affect this path.
  ws.addRow(['Unclaimed Person Updated', UNCLAIMED_APPLICATION_EMAIL, 'Updated Unclaimed Org']);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const path = `claimed-gate-live-test/${Date.now()}.xlsx`;
  const { error } = await admin.storage.from('import-uploads').upload(path, buffer, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (error) throw new Error(`Failed to upload test workbook: ${error.message}`);
  return path;
}

beforeAll(async () => {
  staffId = await getOrCreateFixedUser(STAFF_EMAIL);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  claimedParticipantUserId = await getOrCreateFixedUser(CLAIMED_PARTICIPANT_EMAIL);
  await admin.from('profiles').update({ role: 'participant' }).eq('id', claimedParticipantUserId);

  // Defensive: applications.imported_email has a unique partial index for
  // UNCLAIMED rows only, so only the unclaimed fixture needs a pre-clear —
  // a claimed application (applicant_id not null) isn't covered by that
  // index and a reused participant user id is unique per
  // applications_one_per_applicant, cleared via the applicant_id delete
  // below regardless.
  await admin.from('applications').delete().eq('applicant_id', claimedParticipantUserId);
  await admin.from('applications').delete().eq('imported_email', UNCLAIMED_APPLICATION_EMAIL).is('applicant_id', null);

  const { data: claimedApp } = await admin
    .from('applications')
    .insert({
      applicant_id: claimedParticipantUserId,
      imported_email: CLAIMED_APPLICATION_EMAIL,
      status: 'accepted',
      organization: 'Original Claimed Org',
    })
    .select('id')
    .single();
  claimedApplicationId = claimedApp!.id;

  const { data: unclaimedApp } = await admin
    .from('applications')
    .insert({
      applicant_id: null,
      imported_email: UNCLAIMED_APPLICATION_EMAIL,
      status: 'accepted',
      organization: 'Original Unclaimed Org',
    })
    .select('id')
    .single();
  unclaimedApplicationId = unclaimedApp!.id;

  storagePath = await buildAndUploadWorkbook();

  const { data: batch } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffId,
      original_filename: 'claimed-gate-live-test.xlsx',
      file_checksum: `claimed-gate-live-test-checksum-${Date.now()}`,
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
    ])
    .select('id');
  importColumnMappingIds = (mappings ?? []).map((m) => m.id);

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

  await step('delete applications', async () => {
    const ids = [claimedApplicationId, unclaimedApplicationId].filter(Boolean);
    if (ids.length > 0) await admin.from('applications').delete().in('id', ids);
  });

  await step('delete audit_logs for both users', async () => {
    for (const id of [staffId, claimedParticipantUserId].filter(Boolean)) {
      await admin.from('audit_logs').delete().eq('actor_id', id);
    }
  });

  await step('delete staff and participant users', async () => {
    for (const id of [staffId, claimedParticipantUserId].filter(Boolean)) {
      const result = await admin.auth.admin.deleteUser(id);
      if (result.error) console.error('afterAll cleanup: user delete returned an error', result.error);
    }
  });
}, 300000);

describe('existing_claimed review-required gate (live)', () => {
  it('blocks an unapproved existing_claimed row, approves it, then applies it as updated — while existing_unclaimed applies unconditionally throughout', async () => {
    const { data: rows } = await admin
      .from('import_rows')
      .select('id, excel_row_number, duplicate_status, claimed_update_approved, destination_application_id')
      .eq('import_batch_id', importBatchId)
      .order('excel_row_number', { ascending: true });
    const byRow = new Map((rows ?? []).map((r) => [r.excel_row_number, r]));

    const claimedRow = byRow.get(2)!;
    const unclaimedRow = byRow.get(3)!;
    expect(claimedRow.duplicate_status).toBe('existing_claimed');
    expect(claimedRow.claimed_update_approved).toBe(false);
    expect(unclaimedRow.duplicate_status).toBe('existing_unclaimed');

    // ---------------------------------------------------------------
    // Step 1: apply BOTH rows before any approval. The claimed row must be
    // blocked; the unclaimed row must apply normally — proving the gate is
    // scoped exactly to existing_claimed, not to duplicate matches broadly.
    // ---------------------------------------------------------------
    const { data: claimedOutcomeBefore, error: claimedErrBefore } = await admin.rpc('apply_import_row_transactional', {
      p_import_row_id: claimedRow.id,
      p_import_batch_id: importBatchId,
      p_actor_id: staffId,
    });
    expect(claimedErrBefore).toBeNull();
    expect(claimedOutcomeBefore).toBe('skipped');

    const { data: claimedRowAfterBlock } = await admin
      .from('import_rows')
      .select('action_taken')
      .eq('id', claimedRow.id)
      .single();
    expect(claimedRowAfterBlock?.action_taken).toBe('blocked');

    // The claimed application's data must be UNTOUCHED by the blocked apply.
    const { data: claimedAppUntouched } = await admin
      .from('applications')
      .select('organization')
      .eq('id', claimedApplicationId)
      .single();
    expect(claimedAppUntouched?.organization).toBe('Original Claimed Org');

    const { data: unclaimedOutcome, error: unclaimedErr } = await admin.rpc('apply_import_row_transactional', {
      p_import_row_id: unclaimedRow.id,
      p_import_batch_id: importBatchId,
      p_actor_id: staffId,
    });
    expect(unclaimedErr).toBeNull();
    expect(unclaimedOutcome).toBe('updated');

    const { data: unclaimedAppUpdated } = await admin
      .from('applications')
      .select('organization')
      .eq('id', unclaimedApplicationId)
      .single();
    expect(unclaimedAppUpdated?.organization).toBe('Updated Unclaimed Org');

    // ---------------------------------------------------------------
    // Step 2: approveClaimedUpdatesForCaller flips the flag for exactly the
    // existing_claimed row(s) in this batch, and is audited.
    // ---------------------------------------------------------------
    const { claimedRowCount, unblockedRowCount } = await approveClaimedUpdatesForCaller(importBatchId, { userId: staffId, service: admin });
    expect(claimedRowCount).toBe(1);
    // The row was blocked by Step 1's apply attempt, so this first approval
    // genuinely unblocks it — distinct from a re-affirming call, below.
    expect(unblockedRowCount).toBe(1);

    const { data: claimedRowAfterApproval } = await admin
      .from('import_rows')
      .select('claimed_update_approved, action_taken')
      .eq('id', claimedRow.id)
      .single();
    expect(claimedRowAfterApproval?.claimed_update_approved).toBe(true);
    // CRITICAL behavior, not incidental: approveClaimedUpdatesForCaller
    // must also reset action_taken back to null for a row it unblocks.
    // apply_import_row_transactional's very first check is
    // `if action_taken is not null then return 'already_applied'` — without
    // this reset, a row already stamped 'blocked' would stay permanently
    // inert even after approval, since nothing else in the normal confirm/
    // resume flow ever clears action_taken. This was a real gap found and
    // fixed during this test's own development (an earlier version of this
    // test manually nulled action_taken to work around it, which papered
    // over a genuine bug rather than testing real behavior).
    expect(claimedRowAfterApproval?.action_taken).toBeNull();

    const { count: auditCount } = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', importBatchId)
      .eq('action', 'approve_claimed_updates');
    expect(auditCount).toBe(1);

    // Idempotent: calling it again with nothing new to approve/unblock is a
    // clean no-op, not an error. claimedRowCount still reflects "how many
    // existing_claimed rows exist" (still 1, re-affirming is harmless), but
    // unblockedRowCount is now 0 — the row is no longer 'blocked' (it's
    // 'null', not yet re-applied), so this second call's UPDATE ... WHERE
    // action_taken = 'blocked' matches nothing. This is the distinction the
    // claimedRowCount/unblockedRowCount split exists to make visible.
    const { claimedRowCount: secondClaimedRowCount, unblockedRowCount: secondUnblockedRowCount } = await approveClaimedUpdatesForCaller(
      importBatchId,
      { userId: staffId, service: admin }
    );
    expect(secondClaimedRowCount).toBe(1);
    expect(secondUnblockedRowCount).toBe(0);

    // ---------------------------------------------------------------
    // Step 3: re-applying the now-approved, now-unblocked row succeeds as
    // 'updated', with the same before-image-capture guarantee as any other
    // update path — no manual action_taken manipulation needed here, the
    // approval action itself already did the reset asserted above.
    // ---------------------------------------------------------------
    const { data: claimedOutcomeAfter, error: claimedErrAfter } = await admin.rpc('apply_import_row_transactional', {
      p_import_row_id: claimedRow.id,
      p_import_batch_id: importBatchId,
      p_actor_id: staffId,
    });
    expect(claimedErrAfter).toBeNull();
    expect(claimedOutcomeAfter).toBe('updated');

    const { data: claimedAppApplied } = await admin
      .from('applications')
      .select('organization')
      .eq('id', claimedApplicationId)
      .single();
    expect(claimedAppApplied?.organization).toBe('Updated Claimed Org');

    const { data: claimedRowFinal } = await admin
      .from('import_rows')
      .select('action_taken, previous_application_snapshot')
      .eq('id', claimedRow.id)
      .single();
    expect(claimedRowFinal?.action_taken).toBe('updated');
    expect(claimedRowFinal?.previous_application_snapshot).toBeTruthy();
    expect((claimedRowFinal?.previous_application_snapshot as Record<string, unknown> | null)?.organization).toBe('Original Claimed Org');
  }, 300000);
});
