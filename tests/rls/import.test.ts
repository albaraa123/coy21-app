// tests/rls/import.test.ts
//
// Regression coverage for Phase 5.1 Task 5: proves the RLS policies added in
// Task 4 (20260726105000_import_rls_policies.sql,
// 20260726105500_explicit_answers_with_check.sql) and the
// applications_owner_or_import_identity CHECK constraint added in Task 1
// (20260726100000_applications_import_columns.sql) actually hold against a
// live database, not just in the migration SQL's prose. Follows the exact
// live-test convention established in tests/schedule/authorization.test.ts:
// service-role `admin` client for seeding (including the "seed a real row
// before asserting zero-visibility" pattern from Phase 5's Task 26), a
// separate anon-key client signing in per-role via signInWithPassword for
// every RLS-scoped assertion.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { SENSITIVE_QUESTION_KEYS } from '@/lib/validation/import';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// Collision-proofing suffix for the UNIQUE-constrained fixture literals that
// have no reuse-on-failure protection (unlike the 4 fixed Auth-user emails
// below, which deliberately use getOrCreateFixedUser's reuse pattern instead
// — see that function's own comment for why blind randomization is NOT the
// right fix there).
const runId = randomUUID().slice(0, 8);

const PARTICIPANT_EMAIL = 'import-rls-participant@test.local';
const OTHER_PARTICIPANT_EMAIL = 'import-rls-other-participant@test.local';
const STAFF_EMAIL = 'import-rls-staff@test.local';
const SUPER_ADMIN_EMAIL = 'import-rls-super-admin@test.local';
const PASSWORD = 'password123';

let participantId: string | undefined;
let otherParticipantId: string | undefined;
let staffId: string | undefined;
let superAdminId: string | undefined;

let participantApplicationId: string;
let otherParticipantApplicationId: string;
let unclaimedApplicationId: string;

let importBatchId: string;
let importColumnMappingId: string;
let importRowId: string;
let importMappingTemplateId: string;
let participantInvitationId: string;

let nonSensitiveAnswerId: string;
let sensitiveAnswerId: string;

async function signInAs(email: string) {
  const client = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  await client.auth.signInWithPassword({ email, password: PASSWORD });
  return client;
}

// Gets a fresh-state user for a fixed test email, tolerating deleteUser's
// documented AuthRetryableFetchError (500, empty message) failure mode.
//
// A prior version of this helper swept (deleted) a stale user from an
// aborted run before createUser. That is insufficient on its own: verified
// directly against this live project that deleteUser can fail with this
// error PERSISTENTLY for a specific user id — not transiently, confirmed by
// retrying 5x with backoff after also clearing every applications.
// applicant_id/audit_logs.actor_id/import_batches.uploaded_by reference,
// which ruled out every known FK-blocker table. When that happens, a
// sweep-then-create strategy wedges this suite permanently: delete fails,
// create then fails with "already registered", and no future run can ever
// recover without manual intervention.
//
// This is therefore reuse-on-failure, not delete-and-recreate: attempt the
// sweep as a best effort (cheap win when it works), but if a stale user
// still exists afterward, reuse that same id — resetting its password so
// this run's signInWithPassword calls still work — rather than depending on
// deletion succeeding at all.
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
        await admin.from('applications').delete().eq('applicant_id', stale.id);
        const { error: deleteError } = await admin.auth.admin.deleteUser(stale.id);
        if (!deleteError) break; // successfully removed — fall through to createUser below
      } catch {
        // best-effort; fall through to the reuse path
      }
      // Deletion didn't succeed (or threw) — reuse this user id instead of
      // treating it as recoverable. Reset its password so this run's
      // signInWithPassword(email, PASSWORD) calls authenticate correctly
      // even though the user predates this run.
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
  participantId = await getOrCreateFixedUser(PARTICIPANT_EMAIL);
  await admin.from('profiles').update({ role: 'participant' }).eq('id', participantId);

  otherParticipantId = await getOrCreateFixedUser(OTHER_PARTICIPANT_EMAIL);
  await admin.from('profiles').update({ role: 'participant' }).eq('id', otherParticipantId);

  staffId = await getOrCreateFixedUser(STAFF_EMAIL);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  superAdminId = await getOrCreateFixedUser(SUPER_ADMIN_EMAIL);
  await admin.from('profiles').update({ role: 'super_admin' }).eq('id', superAdminId);

  // A reused user id (getOrCreateFixedUser's fallback for a permanently
  // undeletable stale Auth user — see that function's comment) may carry an
  // orphaned applications row from an earlier interrupted run, which would
  // collide with applications_one_per_applicant below. Clear defensively
  // regardless of which path getOrCreateFixedUser took, since a freshly
  // created user cannot have one and this is then a no-op.
  //
  // A bare applications delete is not enough: verified live during Task 28's
  // gate 6 pass that an orphaned row here can be referenced by the complete
  // non-cascading application_id FK set (allocation_issues/
  // allocation_assignments/cluster_memberships/participant_feature_
  // snapshots/schedule_publications/schedule_publication_draft_items) if a
  // prior interrupted run got far enough to trigger downstream processing.
  {
    const { data: orphaned } = await admin.from('applications').select('id').in('applicant_id', [participantId, otherParticipantId]);
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

  const { data: app } = await admin.from('applications').insert({ applicant_id: participantId, status: 'accepted' }).select('id').single();
  participantApplicationId = app!.id;

  const { data: otherApp } = await admin.from('applications').insert({ applicant_id: otherParticipantId, status: 'accepted' }).select('id').single();
  otherParticipantApplicationId = otherApp!.id;

  // The core gap-closing regression fixture: an imported, unclaimed
  // application — applicant_id null, imported_email set. Nothing in this
  // suite ever claims it; it must stay invisible to every OTHER
  // authenticated participant for the whole run.
  //
  // Defensive: an orphaned row with this exact fixed imported_email from an
  // interrupted prior run can be referenced by allocation_issues/
  // allocation_assignments/cluster_memberships/participant_feature_
  // snapshots/schedule_publications/schedule_publication_draft_items — the
  // complete non-cascading application_id FK set — blocking both a plain
  // delete and, via applications_imported_email_unclaimed_unique, the
  // insert below. Verified live during Task 28's gate 6 pass. Clear the
  // full chain before inserting; a no-op on a clean run.
  const unclaimedEmail = `unclaimed-import-target-${runId}@example.com`;
  {
    const { data: orphaned } = await admin.from('applications').select('id').eq('imported_email', unclaimedEmail).is('applicant_id', null);
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
  const { data: unclaimedApp } = await admin.from('applications').insert({
    applicant_id: null,
    imported_email: unclaimedEmail,
    status: 'accepted',
  }).select('id').single();
  unclaimedApplicationId = unclaimedApp!.id;

  // Seed one real row in each of the 5 staff-only tables so a
  // zero-rows-for-participant result actually proves RLS filtering, not an
  // empty table (Phase 5 Task 26 pattern).
  const { data: template } = await admin.from('import_mapping_templates').insert({
    name: `import-rls-test-template-${runId}`,
    header_signature: `import-rls-test-signature-${runId}`,
    original_headers: ['Email', 'Full Name'],
    mappings: { email: 'email' },
    created_by: staffId,
  }).select('id').single();
  importMappingTemplateId = template!.id;

  const { data: batch } = await admin.from('import_batches').insert({
    uploaded_by: staffId,
    original_filename: 'import-rls-test.xlsx',
    file_checksum: `import-rls-test-checksum-${runId}`,
    storage_path: `import-rls-test/${runId}/path.xlsx`,
    mapping_template_id: importMappingTemplateId,
  }).select('id').single();
  importBatchId = batch!.id;

  const { data: columnMapping } = await admin.from('import_column_mappings').insert({
    import_batch_id: importBatchId,
    source_column_index: 0,
    source_column_header: 'Email',
    target_kind: 'core_field',
    target_key: 'email',
  }).select('id').single();
  importColumnMappingId = columnMapping!.id;

  const { data: row } = await admin.from('import_rows').insert({
    import_batch_id: importBatchId,
    excel_row_number: 2,
    row_fingerprint: `import-rls-test-fingerprint-${runId}`,
    raw_row: { email: 'row@example.com' },
  }).select('id').single();
  importRowId = row!.id;

  const { data: invitation } = await admin.from('participant_invitations').insert({
    application_id: unclaimedApplicationId,
    imported_email: unclaimedEmail,
  }).select('id').single();
  participantInvitationId = invitation!.id;

  // application_answers: one non-sensitive, one sensitive, both on the
  // staff-owned participant application (real content, real staff-visible
  // row) so read/write assertions have something concrete to target.
  const { data: nonSensitiveAnswer } = await admin.from('application_answers').insert({
    application_id: participantApplicationId,
    question_key: 'gender',
    raw_value: 'female',
    value_type: 'text',
    is_sensitive: false,
  }).select('id').single();
  nonSensitiveAnswerId = nonSensitiveAnswer!.id;

  const { data: sensitiveAnswer } = await admin.from('application_answers').insert({
    application_id: participantApplicationId,
    // Sourced from SENSITIVE_QUESTION_KEYS (src/lib/validation/import.ts,
    // Task 11) rather than a bare string literal, so this fixture's
    // question_key can never silently drift out of sync with the actual
    // is_sensitive-marking source of truth.
    question_key: SENSITIVE_QUESTION_KEYS[0],
    raw_value: 'severe nut allergy',
    value_type: 'text',
    is_sensitive: true,
  }).select('id').single();
  sensitiveAnswerId = sensitiveAnswer!.id;
}, 300000);

afterAll(async () => {
  // FK-safe order: children before parents, applications before auth users.
  await admin.from('application_answers').delete().in('id', [nonSensitiveAnswerId, sensitiveAnswerId].filter(Boolean));
  await admin.from('participant_invitations').delete().eq('id', participantInvitationId);
  await admin.from('import_rows').delete().eq('id', importRowId);
  await admin.from('import_column_mappings').delete().eq('id', importColumnMappingId);
  await admin.from('import_batches').delete().eq('id', importBatchId);
  await admin.from('import_mapping_templates').delete().eq('id', importMappingTemplateId);
  await admin.from('applications').delete().in('id', [participantApplicationId, otherParticipantApplicationId, unclaimedApplicationId].filter(Boolean));
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    otherParticipantId ? admin.auth.admin.deleteUser(otherParticipantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    superAdminId ? admin.auth.admin.deleteUser(superAdminId) : Promise.resolve(),
  ]);
}, 300000);

describe('import RLS: staff-only tables are invisible to a participant', () => {
  it('returns zero rows for a participant reading import_batches, though a row exists', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data } = await client.from('import_batches').select('id');
    expect(data ?? []).toHaveLength(0);
    const { data: check } = await admin.from('import_batches').select('id').eq('id', importBatchId);
    expect(check ?? []).not.toHaveLength(0);
  });

  it('returns zero rows for a participant reading import_column_mappings, though a row exists', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data } = await client.from('import_column_mappings').select('id');
    expect(data ?? []).toHaveLength(0);
    const { data: check } = await admin.from('import_column_mappings').select('id').eq('id', importColumnMappingId);
    expect(check ?? []).not.toHaveLength(0);
  });

  it('returns zero rows for a participant reading import_rows, though a row exists', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data } = await client.from('import_rows').select('id');
    expect(data ?? []).toHaveLength(0);
    const { data: check } = await admin.from('import_rows').select('id').eq('id', importRowId);
    expect(check ?? []).not.toHaveLength(0);
  });

  it('returns zero rows for a participant reading import_mapping_templates, though a row exists', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data } = await client.from('import_mapping_templates').select('id');
    expect(data ?? []).toHaveLength(0);
    const { data: check } = await admin.from('import_mapping_templates').select('id').eq('id', importMappingTemplateId);
    expect(check ?? []).not.toHaveLength(0);
  });

  it('returns zero rows for a participant reading participant_invitations, though a row exists', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data } = await client.from('participant_invitations').select('id');
    expect(data ?? []).toHaveLength(0);
    const { data: check } = await admin.from('participant_invitations').select('id').eq('id', participantInvitationId);
    expect(check ?? []).not.toHaveLength(0);
  });
});

describe('import RLS: no participant write succeeds on any of the 6 protected tables', () => {
  it('blocks a participant inserting into import_batches', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data, error } = await client.from('import_batches').insert({
      uploaded_by: participantId!,
      original_filename: 'should-not-insert.xlsx',
      file_checksum: 'should-not-insert',
      storage_path: 'should-not-insert/path.xlsx',
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('import_batches').select('id').eq('file_checksum', 'should-not-insert');
    expect(check ?? []).toHaveLength(0);
  });

  it('blocks a participant updating import_batches', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data, error } = await client.from('import_batches').update({ status: 'failed' }).eq('id', importBatchId).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('import_batches').select('status').eq('id', importBatchId).single();
    expect(check?.status).toBe('uploaded');
  });

  it('blocks a participant deleting import_batches', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { error } = await client.from('import_batches').delete().eq('id', importBatchId);
    void error;
    const { data: check } = await admin.from('import_batches').select('id').eq('id', importBatchId).single();
    expect(check?.id).toBe(importBatchId);
  });

  it('blocks a participant inserting into import_column_mappings', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data, error } = await client.from('import_column_mappings').insert({
      import_batch_id: importBatchId,
      source_column_index: 99,
      source_column_header: 'should-not-insert',
      target_kind: 'ignored',
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
  });

  it('blocks a participant updating and deleting import_column_mappings', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const updateResult = await client.from('import_column_mappings').update({ target_kind: 'ignored' }).eq('id', importColumnMappingId).select('id');
    expect(updateResult.error !== null || !updateResult.data || updateResult.data.length === 0).toBe(true);
    const deleteResult = await client.from('import_column_mappings').delete().eq('id', importColumnMappingId).select('id');
    expect(deleteResult.error !== null || !deleteResult.data || deleteResult.data.length === 0).toBe(true);
    const { data: check } = await admin.from('import_column_mappings').select('id').eq('id', importColumnMappingId).single();
    expect(check?.id).toBe(importColumnMappingId);
  });

  it('blocks a participant inserting into import_rows', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data, error } = await client.from('import_rows').insert({
      import_batch_id: importBatchId,
      excel_row_number: 999,
      row_fingerprint: 'should-not-insert',
      raw_row: {},
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
  });

  it('blocks a participant updating and deleting import_rows', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const updateResult = await client.from('import_rows').update({ validation_status: 'valid' }).eq('id', importRowId).select('id');
    expect(updateResult.error !== null || !updateResult.data || updateResult.data.length === 0).toBe(true);
    const deleteResult = await client.from('import_rows').delete().eq('id', importRowId).select('id');
    expect(deleteResult.error !== null || !deleteResult.data || deleteResult.data.length === 0).toBe(true);
    const { data: check } = await admin.from('import_rows').select('id').eq('id', importRowId).single();
    expect(check?.id).toBe(importRowId);
  });

  it('blocks a participant inserting into import_mapping_templates', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data, error } = await client.from('import_mapping_templates').insert({
      name: 'should-not-insert',
      header_signature: 'should-not-insert',
      original_headers: [],
      mappings: {},
      created_by: participantId!,
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
  });

  it('blocks a participant updating and deleting import_mapping_templates', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const updateResult = await client.from('import_mapping_templates').update({ name: 'renamed' }).eq('id', importMappingTemplateId).select('id');
    expect(updateResult.error !== null || !updateResult.data || updateResult.data.length === 0).toBe(true);
    const deleteResult = await client.from('import_mapping_templates').delete().eq('id', importMappingTemplateId).select('id');
    expect(deleteResult.error !== null || !deleteResult.data || deleteResult.data.length === 0).toBe(true);
    const { data: check } = await admin.from('import_mapping_templates').select('id').eq('id', importMappingTemplateId).single();
    expect(check?.id).toBe(importMappingTemplateId);
  });

  it('blocks a participant inserting into participant_invitations', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data, error } = await client.from('participant_invitations').insert({
      application_id: unclaimedApplicationId,
      imported_email: 'should-not-insert@example.com',
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
  });

  it('blocks a participant updating and deleting participant_invitations', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const updateResult = await client.from('participant_invitations').update({ status: 'sent' }).eq('id', participantInvitationId).select('id');
    expect(updateResult.error !== null || !updateResult.data || updateResult.data.length === 0).toBe(true);
    const deleteResult = await client.from('participant_invitations').delete().eq('id', participantInvitationId).select('id');
    expect(deleteResult.error !== null || !deleteResult.data || deleteResult.data.length === 0).toBe(true);
    const { data: check } = await admin.from('participant_invitations').select('id').eq('id', participantInvitationId).single();
    expect(check?.id).toBe(participantInvitationId);
  });

  it('blocks a participant inserting into application_answers', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data, error } = await client.from('application_answers').insert({
      application_id: participantApplicationId,
      question_key: 'should-not-insert',
      raw_value: 'x',
      value_type: 'text',
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
  });

  it('blocks a participant updating and deleting their own application_answers row', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const updateResult = await client.from('application_answers').update({ raw_value: 'tampered' }).eq('id', nonSensitiveAnswerId).select('id');
    expect(updateResult.error !== null || !updateResult.data || updateResult.data.length === 0).toBe(true);
    const deleteResult = await client.from('application_answers').delete().eq('id', nonSensitiveAnswerId).select('id');
    expect(deleteResult.error !== null || !deleteResult.data || deleteResult.data.length === 0).toBe(true);
    const { data: check } = await admin.from('application_answers').select('raw_value').eq('id', nonSensitiveAnswerId).single();
    expect(check?.raw_value).toBe('female');
  });
});

// The real staff-facing import pages/actions (src/app/[locale]/(admin)/
// participants/imports/**, src/app/[locale]/(admin)/participants/import/**,
// src/app/[locale]/(admin)/participants/[applicationId]/page.tsx) read and
// write import_batches/application_answers exclusively through the trusted
// service_role server boundary, never through the caller's own authenticated
// session client — confirmed by direct code audit. Direct authenticated-role
// table access is therefore intentionally not granted; a future developer
// should not "fix" this by broadening the canonical grants migration.
describe('import RLS: agenda_allocation_manager and super_admin have no direct authenticated access to import_batches/application_answers (real access is service_role-only)', () => {
  it('an agenda_allocation_manager cannot read import_batches directly as authenticated', async () => {
    const client = await signInAs(STAFF_EMAIL);
    const { data, error } = await client.from('import_batches').select('id').eq('id', importBatchId);
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('an agenda_allocation_manager cannot write import_batches directly as authenticated', async () => {
    const client = await signInAs(STAFF_EMAIL);
    const { data, error } = await client.from('import_batches').update({ status: 'analyzing' }).eq('id', importBatchId).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('import_batches').select('status').eq('id', importBatchId).single();
    expect(check?.status).toBe('uploaded');
  });

  it('an agenda_allocation_manager CAN read (role-based RLS policy) but cannot write a non-sensitive application_answers row directly as authenticated (no real UPDATE grant — real writes are service_role-only)', async () => {
    // READ: application_answers DOES have a legitimate authenticated SELECT
    // grant (migration 20260816090000) — needed by
    // application_answers_select_own so a participant can read their own
    // claimed answers directly (see tests/import/claim-live.test.ts's Case
    // 4). Once the read reaches RLS, application_answers_staff_all's USING
    // clause — `(NOT is_sensitive) AND (current_user_role() = ANY
    // (ARRAY['agenda_allocation_manager', 'participants_communications_manager',
    // 'super_admin']))` — is a ROLE check, not an own-row check, so a
    // genuinely signed-in agenda_allocation_manager session correctly reads
    // this non-sensitive row. Confirmed directly against the policy's own
    // USING expression (pg_policy), not assumed.
    //
    // WRITE: despite the same RLS policy covering UPDATE too (polcmd '*'),
    // authenticated has no UPDATE grant on this table at the Postgres
    // level — confirmed by exhaustive code audit that the one real
    // production write path (src/app/[locale]/(admin)/participants/
    // [applicationId]/page.tsx) uses only the service-role client, never
    // authenticated. Do not "fix" this by granting authenticated UPDATE;
    // that would be a grant with no real production caller.
    const client = await signInAs(STAFF_EMAIL);
    const { data: readData, error: readError } = await client.from('application_answers').select('id, raw_value').eq('id', nonSensitiveAnswerId);
    expect(readError).toBeNull();
    expect(readData).toHaveLength(1);
    expect(readData?.[0].raw_value).toBe('female');

    const { data: writeData, error: writeError } = await client.from('application_answers').update({ raw_value: 'female-updated' }).eq('id', nonSensitiveAnswerId).select('id');
    expect(writeError !== null || !writeData || writeData.length === 0).toBe(true);
    const { data: check } = await admin.from('application_answers').select('raw_value').eq('id', nonSensitiveAnswerId).single();
    expect(check?.raw_value).toBe('female');
  });

  it('an agenda_allocation_manager cannot read an is_sensitive application_answers row directly as authenticated', async () => {
    const client = await signInAs(STAFF_EMAIL);
    const { data } = await client.from('application_answers').select('id').eq('id', sensitiveAnswerId);
    expect(data ?? []).toHaveLength(0);
  });

  it('a super_admin CAN read an is_sensitive application_answers row directly as authenticated, per the role-based (not own-row) RLS policy', async () => {
    // Different from the agenda_allocation_manager case above:
    // application_answers_sensitive_staff_all's USING clause is
    // `is_sensitive AND current_user_role() = 'super_admin'` — a role
    // check, not an own-row check — so once the grant lets the read reach
    // RLS at all (migration 20260816090000), a genuinely signed-in
    // super_admin session IS allowed through by design. This is the
    // correct, intended broad-read-access behavior for that role, not a
    // gap — confirmed directly against the policy's own USING expression
    // (pg_policy), not assumed.
    const client = await signInAs(SUPER_ADMIN_EMAIL);
    const { data, error } = await client.from('application_answers').select('id, raw_value').eq('id', sensitiveAnswerId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].raw_value).toBe('severe nut allergy');
  });
});

describe('import RLS: write-side sensitive-flag smuggling is blocked', () => {
  it('rejects an agenda_allocation_manager inserting an application_answers row with is_sensitive = true', async () => {
    const client = await signInAs(STAFF_EMAIL);
    const { data, error } = await client.from('application_answers').insert({
      application_id: participantApplicationId,
      question_key: 'smuggled-sensitive-answer',
      raw_value: 'attempted smuggle',
      value_type: 'text',
      is_sensitive: true,
    }).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);

    // Confirm no row was actually created (belt-and-suspenders: RLS insert
    // rejection sometimes surfaces as a Postgres error, sometimes as
    // zero-rows-returned depending on client version — the real proof is
    // that no such row exists server-side).
    const { data: check } = await admin.from('application_answers').select('id').eq('question_key', 'smuggled-sensitive-answer');
    expect(check ?? []).toHaveLength(0);
  });

  it('rejects an agenda_allocation_manager flipping an existing non-sensitive row to is_sensitive = true', async () => {
    const client = await signInAs(STAFF_EMAIL);
    const { data, error } = await client.from('application_answers').update({ is_sensitive: true }).eq('id', nonSensitiveAnswerId).select('id');
    expect(error !== null || !data || data.length === 0).toBe(true);
    const { data: check } = await admin.from('application_answers').select('is_sensitive').eq('id', nonSensitiveAnswerId).single();
    expect(check?.is_sensitive).toBe(false);
  });
});

describe('applications_owner_or_import_identity CHECK constraint (service-role, DB-level, not RLS)', () => {
  it('rejects an applications insert with both applicant_id and imported_email null', async () => {
    const { data, error } = await admin.from('applications').insert({
      applicant_id: null,
      imported_email: null,
      status: 'accepted',
    } as never).select('id');
    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});

describe('gap-closing regression: applications_select_own excludes null-applicant_id rows for any authenticated participant', () => {
  it('does not return an unclaimed imported application to a different, already-claimed participant', async () => {
    const client = await signInAs(OTHER_PARTICIPANT_EMAIL);
    const { data } = await client.from('applications').select('id').eq('id', unclaimedApplicationId);
    expect(data ?? []).toHaveLength(0);
  });

  it('still returns that same different participant their own claimed application', async () => {
    const client = await signInAs(OTHER_PARTICIPANT_EMAIL);
    const { data, error } = await client.from('applications').select('id').eq('id', otherParticipantApplicationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].id).toBe(otherParticipantApplicationId);
  });

  it('does not return the unclaimed imported application in an unfiltered select for any participant', async () => {
    const client = await signInAs(PARTICIPANT_EMAIL);
    const { data } = await client.from('applications').select('id');
    const ids = (data ?? []).map((r) => r.id);
    expect(ids).not.toContain(unclaimedApplicationId);
  });
});
