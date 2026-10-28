// tests/import/apply-delegate-code-live.test.ts
//
// Proves the Task 4a/4b migration actually works -- that
// external_delegate_code/registration_category genuinely reach the
// applications table after a real apply_import_row_transactional call,
// not just that they're present in normalized_row (which Task 2/3's
// tests already cover at the preview-stage level, before this fix, and
// would pass even if this migration were never applied -- this test is
// the only one that would have caught the original gap).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let staffUserId: string;
let importBatchId: string;
let importRowId: string;
let applicationId: string | undefined;

beforeAll(async () => {
  const { data: staff, error: staffError } = await admin.auth.admin.createUser({
    email: `apply-delcode-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (staffError || !staff.user) throw new Error(`staff fixture setup failed: ${staffError?.message}`);
  staffUserId = staff.user.id;
  await admin.from('profiles').update({ role: 'super_admin' }).eq('id', staffUserId);

  const { data: batch, error: batchError } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffUserId,
      original_filename: `apply-delcode-${runId}.xlsx`,
      file_checksum: `apply-delcode-${runId}-checksum`,
      storage_path: `apply-delcode-${runId}/dummy.xlsx`,
      status: 'importing',
    })
    .select('id')
    .single();
  if (batchError || !batch) throw new Error(`import batch fixture setup failed: ${batchError?.message}`);
  importBatchId = batch.id;

  const testCode = `DEL-APPLYTEST-${runId}`;
  const { data: row, error: rowError } = await admin
    .from('import_rows')
    .insert({
      import_batch_id: importBatchId,
      excel_row_number: 2,
      row_fingerprint: `fp-${runId}`,
      raw_row: [testCode, 'Apply Test Participant', `apply-delcode-${runId}@test.local`],
      normalized_row: {
        full_name: 'Apply Test Participant',
        email: `apply-delcode-${runId}@test.local`,
        external_delegate_code: testCode,
        participant_type: 'delegate',
        registration_category: 'Delegates',
      },
      validation_status: 'valid',
    })
    .select('id')
    .single();
  if (rowError || !row) throw new Error(`import row fixture setup failed: ${rowError?.message}`);
  importRowId = row.id;
});

afterAll(async () => {
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  if (importRowId) await admin.from('import_rows').delete().eq('id', importRowId);
  if (importBatchId) await admin.from('import_batches').delete().eq('id', importBatchId);
  if (staffUserId) await admin.auth.admin.deleteUser(staffUserId);
});

describe('apply_import_row_transactional — delegate code fields', () => {
  it('writes external_delegate_code and registration_category to the resulting application', async () => {
    const testCode = `DEL-APPLYTEST-${runId}`;
    const { data, error } = await admin.rpc('apply_import_row_transactional', {
      p_import_row_id: importRowId,
      p_import_batch_id: importBatchId,
      p_actor_id: staffUserId,
    });
    expect(error).toBeNull();
    // apply_import_row_transactional returns a plain status string, NOT
    // an application id (confirmed by reading the real function's
    // `return` statements: 'already_applied' | 'skipped' | 'updated' |
    // 'inserted'). This fixture is a fresh row with no pre-existing
    // matching application, so the expected outcome is 'inserted'.
    expect(data).toBe('inserted');

    // Look up the resulting application by external_delegate_code
    // (unique, and known from this fixture) rather than by a returned
    // id, since the RPC doesn't return one.
    const { data: app, error: appError } = await admin
      .from('applications')
      .select('id, external_delegate_code, registration_category, participant_type')
      .eq('external_delegate_code', testCode)
      .single();
    expect(appError).toBeNull();
    applicationId = app!.id; // captured here so afterAll can clean it up
    expect(app!.external_delegate_code).toBe(testCode);
    expect(app!.registration_category).toBe('Delegates');
    expect(app!.participant_type).toBe('delegate');
  });
});
