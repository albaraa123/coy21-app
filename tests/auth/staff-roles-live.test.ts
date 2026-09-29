// tests/auth/staff-roles-live.test.ts
//
// Live integration coverage for the 4 manually-provisioned production
// test accounts created after the 2026-09-30 full accounts reset (see
// docs/superpowers/specs/2026-09-30-accounts-reset-and-test-users-design.md).
// Unlike the pre-reset version of this file, none of these accounts has
// a fixed/known password — they were created by hand in the Supabase
// dashboard with passwords only the operator knows — so this file can
// only verify ACCOUNT STATE (existence, role, confirmation status), never
// sign in as them. Sign-in/auth-flow coverage lives in throwaway
// test-only fixtures created inline (see the cross-domain-access and
// sensitive-data-RLS blocks below), matching the pattern already
// established pre-reset.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { findExistingAuthUserByEmail } from '@/lib/auth/find-user-by-email';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { requireParticipantsCommunicationsStaffCaller } from '@/lib/participants-communications/server-helpers';
import { requireProgramAttendanceStaffCaller } from '@/lib/program-attendance/server-helpers';
import { requireAgendaStaffCaller } from '@/lib/agenda/server-helpers';
import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';
import { requireImportStaffCaller } from '@/lib/import/server-helpers';

// See find-user-by-email.ts's own doc comment: a full pagination scan is
// used instead of a single-page listUsers() call. Post-reset, auth.users
// has only 4 rows, so this is fast — the 30s timeout from the pre-reset
// version (needed when the project had thousands of test-only accounts)
// is no longer necessary, but is kept as a safety margin rather than
// tuned down, since this file runs infrequently and cost of over-waiting
// is near zero.
vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PARTICIPANT_EMAIL = 'albaraak2002@gmail.com';
const SUPER_ADMIN_EMAIL = 'albaraa.coy21@gmail.com';
const STAFF_EMAIL = 'albaraaalbadwi@gmail.com';
const SCANNER_DEVICE_EMAIL = 'albaraa.scale.om@gmail.com';

const createdAuthUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

describe('the 4 manually-provisioned test accounts exist with the correct role', () => {
  it(`${PARTICIPANT_EMAIL} exists and is role participant`, async () => {
    const user = await findExistingAuthUserByEmail(admin, PARTICIPANT_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('participant');
  });

  it(`${SUPER_ADMIN_EMAIL} exists and is role super_admin`, async () => {
    const user = await findExistingAuthUserByEmail(admin, SUPER_ADMIN_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('super_admin');
  });

  it(`${STAFF_EMAIL} exists and is role staff`, async () => {
    const user = await findExistingAuthUserByEmail(admin, STAFF_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('staff');
  });

  it(`${SCANNER_DEVICE_EMAIL} exists and is role scanner_device`, async () => {
    const user = await findExistingAuthUserByEmail(admin, SCANNER_DEVICE_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('scanner_device');
  });

  it('exactly 4 accounts exist in total (the reset left nothing else behind)', async () => {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(error).toBeNull();
    expect(data.users).toHaveLength(4);
  });
});

describe('a single staff-role profile satisfies every domain\'s authorization check (live, using a throwaway fixture user)', () => {
  // Unchanged from the pre-reset version of this file: uses a disposable
  // fixture, not the real STAFF_EMAIL account, since these tests create
  // and tear down freely and shouldn't touch the one real production
  // staff account. Every requireXStaffCaller helper below delegates its
  // entire authorization logic to the single shared isStaffRole(role)
  // check (see each helper's src/lib/*/server-helpers.ts) — none can be
  // invoked directly in a live test, since each is a 'use server'
  // function resolving the CALLING request's own session via
  // createClient() -> auth.getUser() (next/headers's cookies()), which
  // cannot be forged outside a real Next.js request context. Asserting
  // isStaffRole directly against a real fixture's persisted role is
  // therefore the exact same check every one of these guards performs
  // internally.
  let staffFixtureId: string;

  it('a staff account satisfies isStaffRole — the exact check every requireXStaffCaller guard performs internally', async () => {
    const { data: staff, error: staffErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-staff-fixture@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (staffErr || !staff.user) throw new Error(`Failed to create staff fixture: ${staffErr?.message}`);
    staffFixtureId = staff.user.id;
    createdAuthUserIds.push(staffFixtureId);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffFixtureId);

    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffFixtureId).single();
    expect(profile?.role).toBe('staff');
    expect(isStaffRole(profile?.role)).toBe(true);
  });

  it('a plain participant does NOT satisfy isStaffRole', async () => {
    const { data: participant, error } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-participant-fixture@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (error || !participant.user) throw new Error(`Failed to create participant fixture: ${error?.message}`);
    createdAuthUserIds.push(participant.user.id);
    const { data: profile } = await admin.from('profiles').select('role').eq('id', participant.user.id).single();
    expect(isStaffRole(profile?.role)).toBe(false);
  });

  it('the requireXStaffCaller helper modules exist and are the real exported functions this file documents as un-forgeable', () => {
    expect(typeof requireImportStaffCaller).toBe('function');
    expect(typeof requireParticipantsCommunicationsStaffCaller).toBe('function');
    expect(typeof requireProgramAttendanceStaffCaller).toBe('function');
    expect(typeof requireAgendaStaffCaller).toBe('function');
    expect(typeof requireAdmissionStaffCaller).toBe('function');
  });
});

describe('sensitive travel and health data: a staff account can read it (consolidated tradeoff); a participant still cannot', () => {
  // Unchanged in substance from the pre-reset version — this proves the
  // staff-role-consolidation's RLS tradeoff (docs/superpowers/specs/
  // 2026-09-29-staff-role-consolidation-design.md), which is orthogonal
  // to this accounts-reset work and remains true regardless of which
  // specific accounts exist. Uses throwaway fixtures, not the real
  // STAFF_EMAIL/PARTICIPANT_EMAIL accounts.
  let staffFixtureId: string;
  let participantFixtureId: string;
  let sensitiveApplicationId: string;

  it('setup: create fixtures and seed a sensitive application', async () => {
    const { data: staff, error: staffErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-sensitive-staff@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (staffErr || !staff.user) throw new Error(`Failed: ${staffErr?.message}`);
    staffFixtureId = staff.user.id;
    createdAuthUserIds.push(staffFixtureId);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffFixtureId);

    const { data: participant, error: participantErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-sensitive-participant-caller@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (participantErr || !participant.user) throw new Error(`Failed: ${participantErr?.message}`);
    participantFixtureId = participant.user.id;
    createdAuthUserIds.push(participantFixtureId);

    const SENSITIVE_EMAIL = 'staff-roles-live-sensitive-participant@example.com';
    const { data: app, error: appErr } = await admin
      .from('applications')
      .insert({ applicant_id: null, imported_email: SENSITIVE_EMAIL, status: 'accepted', full_name: 'Sensitive Data Test Person' })
      .select('id')
      .single();
    if (appErr || !app) throw new Error(`Failed to seed application: ${appErr?.message}`);
    sensitiveApplicationId = app.id;

    await admin.from('application_travel_info').insert({ application_id: sensitiveApplicationId, passport_full_name: 'Test Person' });
    await admin.from('application_health_info').insert({ application_id: sensitiveApplicationId, medical_conditions: 'test condition' });
  }, 30000);

  it('a staff-scoped client CAN read application_travel_info via RLS', async () => {
    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { error: signInErr } = await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-staff@test.local', password: 'password123' });
    expect(signInErr).toBeNull();

    const { data, error } = await anonClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    await anonClient.auth.signOut();
  });

  it('a staff-scoped client CAN read application_health_info via RLS', async () => {
    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-staff@test.local', password: 'password123' });

    const { data, error } = await anonClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    await anonClient.auth.signOut();
  });

  it('a participant-scoped client still cannot read application_travel_info via RLS', async () => {
    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-participant-caller@test.local', password: 'password123' });

    const { data, error } = await anonClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await anonClient.auth.signOut();
  });

  it('a participant-scoped client still cannot read application_health_info via RLS', async () => {
    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-participant-caller@test.local', password: 'password123' });

    const { data, error } = await anonClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await anonClient.auth.signOut();
  });

  afterAll(async () => {
    if (sensitiveApplicationId) await admin.from('applications').delete().eq('id', sensitiveApplicationId);
  });
});

describe('the staff role cannot change any account\'s role or delete any account (the requested permission boundary)', () => {
  // NEW block, per the design spec's §3 ("Verifying the staff permission
  // boundary") — this is the part of this plan's scope that confirms an
  // ALREADY-EXISTING protection, not something newly built. Documents the
  // boundary explicitly in the test suite rather than leaving it implicit,
  // matching this repo's established practice (see the equivalent
  // "single staff account satisfies every domain" test that documents the
  // consolidation's tradeoff above).
  //
  // COVERAGE NOTE: this only tests the role-change half of spec §3's
  // two-part claim (staff cannot change roles, staff cannot delete
  // accounts), via a direct RLS UPDATE attempt below. The deletion half
  // is NOT covered here: deleteStaffAccount (src/app/[locale]/(admin)/
  // staff/actions.ts) is an application-layer 'use server' action gated
  // by requireSuperAdmin() at the code level, not an RLS policy — it
  // cannot be invoked directly from a live DB test outside a real
  // Next.js request context, the same limitation already documented
  // elsewhere in this file for the requireXStaffCaller helpers. Proving
  // the deletion half live would require either a Playwright-style
  // browser test driving the real (admin)/staff UI as a signed-in staff
  // user, or exporting a testable pure-decision function the way
  // decideAdminAccess was extracted for admin-access.ts — both are out
  // of scope for this sub-project. This gap is called out explicitly
  // here, not silently narrowed, so a future reader knows it's a known,
  // deliberate omission rather than an oversight.
  it('a staff-scoped client cannot update another profile\'s role via RLS', async () => {
    const { data: staffFx, error: staffErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-boundary-staff@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (staffErr || !staffFx.user) throw new Error(`Failed: ${staffErr?.message}`);
    createdAuthUserIds.push(staffFx.user.id);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffFx.user.id);

    const { data: targetFx, error: targetErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-boundary-target@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (targetErr || !targetFx.user) throw new Error(`Failed: ${targetErr?.message}`);
    createdAuthUserIds.push(targetFx.user.id);

    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-boundary-staff@test.local', password: 'password123' });

    const { error } = await anonClient.from('profiles').update({ role: 'super_admin' }).eq('id', targetFx.user.id);
    // RLS denies this write — either an explicit error, or a silent
    // no-op (0 rows affected under default-deny RLS UPDATE semantics).
    // Confirm via the service-role client that the role genuinely never
    // changed, regardless of which shape the denial took.
    const { data: afterProfile } = await admin.from('profiles').select('role').eq('id', targetFx.user.id).single();
    expect(afterProfile?.role).not.toBe('super_admin');
    await anonClient.auth.signOut();
  });
});

describe('no plaintext password is stored or logged anywhere', () => {
  it('the profiles table has no password column at all', async () => {
    const { data } = await admin.from('profiles').select('*').limit(1).single();
    expect(data).not.toHaveProperty('password');
    expect(data).not.toHaveProperty('plaintext_password');
  });

  it('audit_logs never contains any test fixture password string in metadata', async () => {
    const { data: logs } = await admin.from('audit_logs').select('metadata').in('actor_id', createdAuthUserIds);
    for (const row of logs ?? []) {
      expect(JSON.stringify(row.metadata ?? '')).not.toContain('password123');
    }
  });
});
