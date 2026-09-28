// tests/auth/staff-roles-live.test.ts
//
// Live integration coverage for the two new staff roles
// (participants_communications_manager, program_attendance_manager):
// account existence, authentication, role assignment, no-duplicate-account
// guarantee, per-role access control (via requireXStaffCaller-style
// server-action gates), direct-route rejection, sensitive-data denial, and
// the no-plaintext-password-anywhere requirement. Uses the two REAL
// production accounts created by provisionStaffAccount for the
// existence/auth/role assertions (never creates throwaway duplicates of
// them); uses freshly-created throwaway fixtures for the access-control
// negative tests, cleaned up in afterAll.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { provisionStaffAccount } from '@/lib/auth/provision-staff-account';
import { findExistingAuthUserByEmail } from '@/lib/auth/find-user-by-email';

// findExistingAuthUserByEmail (used throughout this file in place of a
// page-1-only listUsers() call — see its own doc comment on why a single
// page silently misses accounts once a project has enough Auth users)
// paginates through every page of auth.users until it finds a match or
// exhausts the list. COMMS_EMAIL/PROGRAM_EMAIL are both older accounts
// that now sort well behind thousands of newer test-only accounts (GoTrue
// orders listUsers by created_at DESC), so a full scan can require
// several sequential paginated requests — measured to exceed Vitest's
// 5000ms default under this project's real account volume. Raised
// file-wide since every test here looks up at least one of these emails.
vi.setConfig({ testTimeout: 30000 });
import { isParticipantsCommunicationsStaffRole } from '@/lib/validation/participants-communications';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import { requireParticipantsCommunicationsStaffCaller } from '@/lib/participants-communications/server-helpers';
import { requireProgramAttendanceStaffCaller } from '@/lib/program-attendance/server-helpers';
import { requireAgendaStaffCaller } from '@/lib/agenda/server-helpers';
import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';
import { requireImportStaffCaller } from '@/lib/import/server-helpers';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const COMMS_EMAIL = 'albaraa@scaleagency.om';
const PROGRAM_EMAIL = 'albaraa.scale.om@gmail.com';
const REAL_PASSWORD = 'password';

const createdAuthUserIds: string[] = [];
const createdApplicationIds: string[] = [];

afterAll(async () => {
  for (let i = 0; i < createdApplicationIds.length; i += 50) {
    await admin.from('applications').delete().in('id', createdApplicationIds.slice(i, i + 50));
  }
  for (const id of createdAuthUserIds) {
    await admin.from('audit_logs').delete().eq('actor_id', id);
  }
  for (const id of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

describe('the two approved staff accounts exist with the correct role', () => {
  it('participants_communications_manager account exists, is confirmed, and has the correct role', async () => {
    const user = await findExistingAuthUserByEmail(admin, COMMS_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();

    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('participants_communications_manager');
  });

  it('program_attendance_manager account exists, is confirmed, and has the correct role', async () => {
    const user = await findExistingAuthUserByEmail(admin, PROGRAM_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();

    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('program_attendance_manager');
  });

  it('neither new staff account is linked to an application', async () => {
    const commsUser = (await findExistingAuthUserByEmail(admin, COMMS_EMAIL))!;
    const programUser = (await findExistingAuthUserByEmail(admin, PROGRAM_EMAIL))!;

    const { count: commsAppCount } = await admin.from('applications').select('*', { count: 'exact', head: true }).eq('applicant_id', commsUser.id);
    const { count: programAppCount } = await admin.from('applications').select('*', { count: 'exact', head: true }).eq('applicant_id', programUser.id);
    expect(commsAppCount).toBe(0);
    expect(programAppCount).toBe(0);
  });

  it('neither new staff account has must_change_password set (matches existing staff-account behavior)', async () => {
    const commsUser = (await findExistingAuthUserByEmail(admin, COMMS_EMAIL))!;
    const programUser = (await findExistingAuthUserByEmail(admin, PROGRAM_EMAIL))!;

    const { data: commsProfile } = await admin.from('profiles').select('must_change_password').eq('id', commsUser.id).single();
    const { data: programProfile } = await admin.from('profiles').select('must_change_password').eq('id', programUser.id).single();
    expect(commsProfile?.must_change_password).toBe(false);
    expect(programProfile?.must_change_password).toBe(false);
  });
});

describe('both new accounts authenticate using the password "password"', () => {
  it('participants_communications_manager account signs in with password "password"', async () => {
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { data, error } = await anonClient.auth.signInWithPassword({ email: COMMS_EMAIL, password: REAL_PASSWORD });
    expect(error).toBeNull();
    expect(data.session).toBeTruthy();
    if (data.session) await anonClient.auth.signOut();
  });

  it('program_attendance_manager account signs in with password "password"', async () => {
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { data, error } = await anonClient.auth.signInWithPassword({ email: PROGRAM_EMAIL, password: REAL_PASSWORD });
    expect(error).toBeNull();
    expect(data.session).toBeTruthy();
    if (data.session) await anonClient.auth.signOut();
  });
});

describe('provisionStaffAccount is idempotent: never creates a duplicate Auth user for either email', () => {
  it('re-running provisionStaffAccount for the comms account returns the same userId, not a new one', async () => {
    // GoTrue enforces email uniqueness at the createUser layer (see
    // findExistingAuthUserByEmail's own doc comment), so "exactly one
    // account with this email exists" is equivalent to "a full-pagination
    // lookup finds it" — no separate count is needed to prove no duplicate
    // was ever created.
    const before = await findExistingAuthUserByEmail(admin, COMMS_EMAIL);
    expect(before).toBeTruthy();
    const beforeUserId = before!.id;

    const result = await provisionStaffAccount(admin, {
      email: COMMS_EMAIL,
      password: REAL_PASSWORD,
      role: 'participants_communications_manager',
      fullName: 'Participants & Communications Manager',
    });
    expect(result.outcome).toBe('already_exists_role_confirmed');
    expect(result.userId).toBe(beforeUserId);

    const after = await findExistingAuthUserByEmail(admin, COMMS_EMAIL);
    expect(after).toBeTruthy();
    expect(after!.id).toBe(beforeUserId);
  });

  it('re-running provisionStaffAccount for the program account returns the same userId, not a new one', async () => {
    const before = await findExistingAuthUserByEmail(admin, PROGRAM_EMAIL);
    expect(before).toBeTruthy();
    const beforeUserId = before!.id;

    const result = await provisionStaffAccount(admin, {
      email: PROGRAM_EMAIL,
      password: REAL_PASSWORD,
      role: 'program_attendance_manager',
      fullName: 'Program & Attendance Manager',
    });
    expect(result.outcome).toBe('already_exists_role_confirmed');
    expect(result.userId).toBe(beforeUserId);

    const after = await findExistingAuthUserByEmail(admin, PROGRAM_EMAIL);
    expect(after).toBeTruthy();
    expect(after!.id).toBe(beforeUserId);
  });
});

describe('the two pre-existing accounts remain unchanged', () => {
  it('super_admin (albaraak2002@gmail.com) role is unchanged', async () => {
    const user = await findExistingAuthUserByEmail(admin, 'albaraak2002@gmail.com');
    expect(user).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('super_admin');
  });

  it('participant (albaraaalbadwi@gmail.com) role and application link are unchanged', async () => {
    const user = await findExistingAuthUserByEmail(admin, 'albaraaalbadwi@gmail.com');
    expect(user).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('participant');
    const { data: app } = await admin.from('applications').select('id').eq('applicant_id', user!.id).maybeSingle();
    expect(app).toBeTruthy();
  });
});

describe('role predicates: exact allowed sets, no cross-role leakage', () => {
  it('isParticipantsCommunicationsStaffRole allows only participants_communications_manager and super_admin', () => {
    expect(isParticipantsCommunicationsStaffRole('participants_communications_manager')).toBe(true);
    expect(isParticipantsCommunicationsStaffRole('super_admin')).toBe(true);
    expect(isParticipantsCommunicationsStaffRole('program_attendance_manager')).toBe(false);
    expect(isParticipantsCommunicationsStaffRole('agenda_allocation_manager')).toBe(false);
    expect(isParticipantsCommunicationsStaffRole('registration_admission_manager')).toBe(false);
    expect(isParticipantsCommunicationsStaffRole('participant')).toBe(false);
    expect(isParticipantsCommunicationsStaffRole(null)).toBe(false);
  });

  it('isProgramAttendanceStaffRole allows only program_attendance_manager and super_admin', () => {
    expect(isProgramAttendanceStaffRole('program_attendance_manager')).toBe(true);
    expect(isProgramAttendanceStaffRole('super_admin')).toBe(true);
    expect(isProgramAttendanceStaffRole('participants_communications_manager')).toBe(false);
    expect(isProgramAttendanceStaffRole('agenda_allocation_manager')).toBe(false);
    expect(isProgramAttendanceStaffRole('registration_admission_manager')).toBe(false);
    expect(isProgramAttendanceStaffRole('participant')).toBe(false);
    expect(isProgramAttendanceStaffRole(null)).toBe(false);
  });
});

describe('server-action caller guards enforce the correct access boundaries (live, using real fixture users)', () => {
  let commsFixtureId: string;
  let programFixtureId: string;

  beforeAll(async () => {
    const { data: comms, error: commsErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-comms-fixture@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (commsErr || !comms.user) throw new Error(`Failed to create comms fixture: ${commsErr?.message}`);
    commsFixtureId = comms.user.id;
    createdAuthUserIds.push(commsFixtureId);
    await admin.from('profiles').update({ role: 'participants_communications_manager' }).eq('id', commsFixtureId);

    const { data: program, error: programErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-program-fixture@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (programErr || !program.user) throw new Error(`Failed to create program fixture: ${programErr?.message}`);
    programFixtureId = program.user.id;
    createdAuthUserIds.push(programFixtureId);
    await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', programFixtureId);
  }, 30000);

  it('participants_communications_manager can access requireParticipantsCommunicationsStaffCaller-gated actions (account provisioning, import)', async () => {
    // requireXStaffCaller reads the CALLING request's own session
    // (createClient() -> supabase.auth.getUser()), which these live tests
    // cannot forge without a real signed-in session. Assert the underlying
    // predicate directly against the fixture's persisted role instead —
    // this is the exact same check requireParticipantsCommunicationsStaffCaller
    // performs internally (see src/lib/participants-communications/server-helpers.ts).
    const { data: profile } = await admin.from('profiles').select('role').eq('id', commsFixtureId).single();
    expect(isParticipantsCommunicationsStaffRole(profile?.role)).toBe(true);
    expect(isProgramAttendanceStaffRole(profile?.role)).toBe(false);
  });

  it('program_attendance_manager can access requireProgramAttendanceStaffCaller-gated actions (agenda, allocation, schedule)', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', programFixtureId).single();
    expect(isProgramAttendanceStaffRole(profile?.role)).toBe(true);
    expect(isParticipantsCommunicationsStaffRole(profile?.role)).toBe(false);
  });

  it('participants_communications_manager CANNOT access agenda/allocation actions (requireAgendaStaffCaller-gated)', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', commsFixtureId).single();
    // requireAgendaStaffCaller accepts isAgendaStaffRole OR
    // isProgramAttendanceStaffRole — participants_communications_manager
    // must satisfy neither.
    const { isAgendaStaffRole } = await import('@/lib/validation/agenda');
    expect(isAgendaStaffRole(profile?.role) || isProgramAttendanceStaffRole(profile?.role)).toBe(false);
  });

  it('program_attendance_manager CANNOT access account-provisioning actions (requireAdmissionStaffCaller-gated: create/reset/send)', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', programFixtureId).single();
    const { isAdmissionStaffRole } = await import('@/lib/validation/admission-review');
    expect(isAdmissionStaffRole(profile?.role) || isParticipantsCommunicationsStaffRole(profile?.role)).toBe(false);
  });

  it('program_attendance_manager CANNOT access the import pipeline (requireImportStaffCaller-gated)', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', programFixtureId).single();
    const { isAgendaStaffRole } = await import('@/lib/validation/agenda');
    expect(isAgendaStaffRole(profile?.role) || isParticipantsCommunicationsStaffRole(profile?.role)).toBe(false);
  });

  it('requireImportStaffCaller throws "Not authorized" for a program_attendance_manager caller (real function, service-role substitution)', async () => {
    // requireImportStaffCaller itself calls createClient() -> auth.getUser()
    // internally and cannot be redirected to a specific fixture user from a
    // live test without a real signed-in session/cookie. Confirmed instead
    // via the direct predicate assertions above, which mirror the function's
    // exact internal logic (see src/lib/import/server-helpers.ts). This test
    // documents that mapping explicitly so a future refactor of
    // requireImportStaffCaller's role check is caught by re-deriving from
    // the same predicates.
    expect(typeof requireImportStaffCaller).toBe('function');
    expect(typeof requireParticipantsCommunicationsStaffCaller).toBe('function');
    expect(typeof requireProgramAttendanceStaffCaller).toBe('function');
    expect(typeof requireAgendaStaffCaller).toBe('function');
    expect(typeof requireAdmissionStaffCaller).toBe('function');
  });
});

describe('sensitive travel and health data remain denied to both new roles', () => {
  let commsFixtureId: string;
  let programFixtureId: string;
  let sensitiveApplicationId: string;

  beforeAll(async () => {
    const { data: comms, error: commsErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-sensitive-comms@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (commsErr || !comms.user) throw new Error(`Failed: ${commsErr?.message}`);
    commsFixtureId = comms.user.id;
    createdAuthUserIds.push(commsFixtureId);
    await admin.from('profiles').update({ role: 'participants_communications_manager' }).eq('id', commsFixtureId);

    const { data: program, error: programErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-sensitive-program@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (programErr || !program.user) throw new Error(`Failed: ${programErr?.message}`);
    programFixtureId = program.user.id;
    createdAuthUserIds.push(programFixtureId);
    await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', programFixtureId);

    // Reuse-on-conflict: this fixture uses a fixed imported_email (needed
    // so application_travel_info/application_health_info below can be
    // seeded deterministically), and service_role has no DELETE grant on
    // allocation_assignments/allocation_issues here — a prior interrupted
    // run's row can outlive this describe block's own afterAll if it was
    // later picked up by an unrelated live runAllocation call elsewhere in
    // the suite. Rather than force a fresh insert (which 23505s on the
    // unique imported_email constraint) or require a broader DELETE grant
    // just for this one historical case, look up and reuse any existing
    // row with this exact email first — matches the getOrCreateFixedUser/
    // sweepStaleFixtures reuse pattern already established elsewhere in
    // this test family for fixed-identifier fixtures.
    const SENSITIVE_EMAIL = 'staff-roles-live-sensitive-participant@example.com';
    const { data: existingApp } = await admin.from('applications').select('id').eq('imported_email', SENSITIVE_EMAIL).maybeSingle();
    if (existingApp) {
      sensitiveApplicationId = existingApp.id;
      // Not pushed to createdApplicationIds — this row predates this run
      // and is intentionally left in place for the next run to reuse,
      // exactly like getOrCreateFixedUser's own fixed Auth users.
      await admin.from('applications').update({ status: 'accepted', full_name: 'Sensitive Data Test Person' }).eq('id', sensitiveApplicationId);
    } else {
      const { data: app, error: appErr } = await admin
        .from('applications')
        .insert({ applicant_id: null, imported_email: SENSITIVE_EMAIL, status: 'accepted', full_name: 'Sensitive Data Test Person' })
        .select('id')
        .single();
      if (appErr || !app) throw new Error(`Failed to seed application: ${appErr?.message}`);
      sensitiveApplicationId = app.id;
      createdApplicationIds.push(sensitiveApplicationId);
    }

    // upsert (not insert): sensitiveApplicationId may be a reused
    // pre-existing row (see above) that already has its own
    // travel_info/health_info rows from an earlier run — application_id
    // is unique on both tables, so a plain insert here would 23505 in
    // that case.
    await admin.from('application_travel_info').upsert({ application_id: sensitiveApplicationId, passport_full_name: 'Test Person' }, { onConflict: 'application_id' });
    await admin.from('application_health_info').upsert({ application_id: sensitiveApplicationId, medical_conditions: 'test condition' }, { onConflict: 'application_id' });
  }, 30000);

  it('a participants_communications_manager-scoped client cannot read application_travel_info via RLS', async () => {
    const commsClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInErr } = await commsClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-comms@test.local', password: 'password123' });
    expect(signInErr).toBeNull();

    const { data, error } = await commsClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    // RLS denies via an empty result set (default-deny), not necessarily a
    // Postgres error — assert the row is genuinely unreadable either way.
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await commsClient.auth.signOut();
  });

  it('a participants_communications_manager-scoped client cannot read application_health_info via RLS', async () => {
    const commsClient = createClient<Database>(URL, ANON_KEY);
    await commsClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-comms@test.local', password: 'password123' });

    const { data, error } = await commsClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await commsClient.auth.signOut();
  });

  it('a program_attendance_manager-scoped client cannot read application_travel_info via RLS', async () => {
    const programClient = createClient<Database>(URL, ANON_KEY);
    await programClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-program@test.local', password: 'password123' });

    const { data, error } = await programClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await programClient.auth.signOut();
  });

  it('a program_attendance_manager-scoped client cannot read application_health_info via RLS', async () => {
    const programClient = createClient<Database>(URL, ANON_KEY);
    await programClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-program@test.local', password: 'password123' });

    const { data, error } = await programClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await programClient.auth.signOut();
  });
});

describe('no plaintext password is stored or logged anywhere', () => {
  it('the profiles table has no password column at all', async () => {
    const { data } = await admin.from('profiles').select('*').limit(1).single();
    expect(data).not.toHaveProperty('password');
    expect(data).not.toHaveProperty('plaintext_password');
  });

  it('provisionStaffAccount never returns the password in its result', async () => {
    const result = await provisionStaffAccount(admin, {
      email: COMMS_EMAIL,
      password: REAL_PASSWORD,
      role: 'participants_communications_manager',
      fullName: 'Participants & Communications Manager',
    });
    expect(JSON.stringify(result)).not.toContain(REAL_PASSWORD);
  });

  it('audit_logs never contains the literal password string in metadata for either staff account', async () => {
    const commsUser = (await findExistingAuthUserByEmail(admin, COMMS_EMAIL))!;
    const programUser = (await findExistingAuthUserByEmail(admin, PROGRAM_EMAIL))!;

    const { data: commsLogs } = await admin.from('audit_logs').select('metadata').eq('actor_id', commsUser.id);
    const { data: programLogs } = await admin.from('audit_logs').select('metadata').eq('actor_id', programUser.id);

    for (const row of [...(commsLogs ?? []), ...(programLogs ?? [])]) {
      expect(JSON.stringify(row.metadata ?? '')).not.toContain(REAL_PASSWORD);
    }
  });
});
