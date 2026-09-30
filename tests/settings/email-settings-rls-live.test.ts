// tests/settings/email-settings-rls-live.test.ts
//
// Live RLS verification for the email_settings singleton table (see
// supabase/migrations/20260930010000_add_email_settings_table.sql):
//
//   - "staff can read email settings" — select using (is_staff())
//   - "only super_admin can update email settings" — update using/with
//     check (current_user_role() = 'super_admin')
//   - no insert/delete policy at all
//
// This proves the DATABASE-level guarantee holds, independent of the
// Server Action code path. tests/settings/email-settings-actions-live.test.ts
// already covers the super_admin-can-write / staff-cannot-write boundary as
// a side effect of documenting what the updateSandboxRecipient /
// enableSandboxMode / disableSandboxMode actions delegate to; this file is
// the dedicated, complete RLS matrix for the table — including the
// staff-CAN-read case and the participant-CANNOT-read-at-all case that file
// doesn't cover — following the exact fixture/sign-in/cleanup pattern
// established in tests/auth/staff-roles-live.test.ts's sensitive-data-RLS
// block ("sensitive travel and health data: a staff account can read it...").
//
// This is a "live" test per this codebase's -live.test.ts convention: it
// requires real Supabase env vars and FAILS (not skips) if they're missing.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error(
    'tests/settings/email-settings-rls-live.test.ts requires NEXT_PUBLIC_SUPABASE_URL, ' +
      'SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY to be set — this is a live ' +
      "test per this codebase's -live.test.ts convention and must fail loudly, not skip, when " +
      'credentials are missing.'
  );
}

const admin = createClient<Database>(URL, SERVICE_KEY);

const createdAuthUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

// Snapshot and restore the real singleton row's original values so this
// file never leaves the live email_settings row mutated for other tests,
// other live test files, or the real app — safe to run repeatedly against
// a real project (same pattern as email-settings-actions-live.test.ts).
let originalSandboxEnabled: boolean;
let originalSandboxRecipientEmail: string | null;

beforeAll(async () => {
  const { data, error } = await admin
    .from('email_settings')
    .select('sandbox_enabled, sandbox_recipient_email')
    .eq('id', true)
    .single();
  if (error || !data) throw new Error(`Failed to read email_settings singleton row: ${error?.message}`);
  originalSandboxEnabled = data.sandbox_enabled;
  originalSandboxRecipientEmail = data.sandbox_recipient_email;
});

afterEach(async () => {
  await admin
    .from('email_settings')
    .update({ sandbox_enabled: originalSandboxEnabled, sandbox_recipient_email: originalSandboxRecipientEmail })
    .eq('id', true);
});

const STAFF_EMAIL = 'email-settings-rls-live-staff-fixture@test.local';
const SUPER_ADMIN_EMAIL = 'email-settings-rls-live-super-admin-fixture@test.local';
const PARTICIPANT_EMAIL = 'email-settings-rls-live-participant-fixture@test.local';
const FIXTURE_PASSWORD = 'password123';

describe('email_settings RLS policies (live, throwaway fixtures per role)', () => {
  let participantFixtureId: string;

  beforeAll(async () => {
    const { data: staff, error: staffErr } = await admin.auth.admin.createUser({
      email: STAFF_EMAIL,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
    });
    if (staffErr || !staff.user) throw new Error(`Failed to create staff fixture: ${staffErr?.message}`);
    createdAuthUserIds.push(staff.user.id);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staff.user.id);

    const { data: superAdmin, error: superAdminErr } = await admin.auth.admin.createUser({
      email: SUPER_ADMIN_EMAIL,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
    });
    if (superAdminErr || !superAdmin.user) throw new Error(`Failed to create super_admin fixture: ${superAdminErr?.message}`);
    createdAuthUserIds.push(superAdmin.user.id);
    await admin.from('profiles').update({ role: 'super_admin' }).eq('id', superAdmin.user.id);

    const { data: participant, error: participantErr } = await admin.auth.admin.createUser({
      email: PARTICIPANT_EMAIL,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
    });
    if (participantErr || !participant.user) throw new Error(`Failed to create participant fixture: ${participantErr?.message}`);
    participantFixtureId = participant.user.id;
    createdAuthUserIds.push(participantFixtureId);
    // profiles.role defaults to 'participant' on creation — no explicit
    // update needed, but assert it below rather than assume it.
  }, 30000);

  it('a staff-scoped client CAN select email_settings and gets the row back', async () => {
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInErr } = await anonClient.auth.signInWithPassword({ email: STAFF_EMAIL, password: FIXTURE_PASSWORD });
    expect(signInErr).toBeNull();

    const { data, error } = await anonClient.from('email_settings').select('*').eq('id', true);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    await anonClient.auth.signOut();
  });

  it('a staff-scoped client\'s UPDATE attempt on email_settings is rejected by RLS', async () => {
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInErr } = await anonClient.auth.signInWithPassword({ email: STAFF_EMAIL, password: FIXTURE_PASSWORD });
    expect(signInErr).toBeNull();

    const { error } = await anonClient
      .from('email_settings')
      .update({ sandbox_recipient_email: 'staff-should-not-write@example.com' })
      .eq('id', true);
    // RLS denies this write — either an explicit error, or a silent no-op
    // (0 rows affected under default-deny RLS UPDATE semantics). Confirm
    // via the service-role client that the value genuinely never changed,
    // regardless of which shape the denial took (matches
    // staff-roles-live.test.ts's role-change boundary test and
    // email-settings-actions-live.test.ts's equivalent staff-write test).
    const { data: afterRow } = await admin.from('email_settings').select('sandbox_recipient_email').eq('id', true).single();
    expect(afterRow?.sandbox_recipient_email).not.toBe('staff-should-not-write@example.com');
    if (error) {
      expect(error).toBeTruthy();
    }
    await anonClient.auth.signOut();
  });

  it('a super_admin-scoped client CAN select and successfully UPDATE email_settings', async () => {
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInErr } = await anonClient.auth.signInWithPassword({ email: SUPER_ADMIN_EMAIL, password: FIXTURE_PASSWORD });
    expect(signInErr).toBeNull();

    const { data: selectData, error: selectError } = await anonClient.from('email_settings').select('*').eq('id', true);
    expect(selectError).toBeNull();
    expect(selectData ?? []).toHaveLength(1);

    const { error: updateError } = await anonClient
      .from('email_settings')
      .update({ sandbox_recipient_email: 'super-admin-rls-write-test@example.com' })
      .eq('id', true);
    expect(updateError).toBeNull();

    // Confirm the write actually landed (via service-role, independent of
    // the anon client's own read-after-write).
    const { data: afterRow } = await admin.from('email_settings').select('sandbox_recipient_email').eq('id', true).single();
    expect(afterRow?.sandbox_recipient_email).toBe('super-admin-rls-write-test@example.com');

    await anonClient.auth.signOut();
    // afterEach restores the singleton row's original values — see above.
  });

  it('a participant-scoped client CANNOT select email_settings at all (is_staff() genuinely excludes participants)', async () => {
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInErr } = await anonClient.auth.signInWithPassword({ email: PARTICIPANT_EMAIL, password: FIXTURE_PASSWORD });
    expect(signInErr).toBeNull();

    const { data: profile } = await admin.from('profiles').select('role').eq('id', participantFixtureId).single();
    expect(profile?.role).toBe('participant');

    const { data, error } = await anonClient.from('email_settings').select('*').eq('id', true);
    // RLS's default-deny SELECT semantics return an empty result set here
    // rather than an explicit error (matches staff-roles-live.test.ts's
    // participant-cannot-read-sensitive-data assertions).
    expect(error || (data ?? []).length === 0).toBeTruthy();
    expect(data ?? []).toHaveLength(0);
    await anonClient.auth.signOut();
  });
});
