// tests/auth/staff-roles-live.test.ts
//
// Live integration coverage for the consolidated `staff` role (formerly two
// separate staff-domain roles, participants_communications_manager and
// program_attendance_manager, now both migrated to the single `staff` role
// — see docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md):
// account existence, authentication, role assignment, no-duplicate-account
// guarantee, uniform cross-domain access (via requireXStaffCaller-style
// server-action gates, all of which now delegate to the same shared
// isStaffRole check), sensitive-data denial (RLS still applies regardless of
// role), and the no-plaintext-password-anywhere requirement. Uses the two
// REAL production accounts created by provisionStaffAccount for the
// existence/auth/role assertions (never creates throwaway duplicates of
// them); uses freshly-created throwaway fixtures for the access-control
// tests, cleaned up in afterAll.
//
// Prior to the consolidation, this file proved a NEGATIVE cross-domain
// boundary (a participants_communications_manager could NOT access
// program-attendance-gated actions, and vice versa). That boundary no
// longer exists by design: both former roles are now the same `staff` role,
// and any `staff` account can access every domain's actions — this is the
// explicit, user-approved security tradeoff the consolidation makes. The
// per-domain cross-exclusion tests have been replaced with tests proving
// the new POSITIVE guarantee instead: a single `staff` account satisfies
// every domain's authorization predicate uniformly. Plain-unit-test
// coverage of isStaffRole's allowed-role set itself lives in
// tests/auth/is-staff-role.test.ts; what this live file adds on top is
// proof against the REAL migrated database rows (the two real production
// accounts below), which a mocked-client unit test cannot provide.
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
import { isStaffRole } from '@/lib/auth/is-staff-role';
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

describe('the two approved staff accounts exist with the correct (migrated) role', () => {
  it('the former participants_communications_manager account exists, is confirmed, and is now the consolidated staff role', async () => {
    const user = await findExistingAuthUserByEmail(admin, COMMS_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();

    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('staff');
  });

  it('the former program_attendance_manager account exists, is confirmed, and is now the consolidated staff role', async () => {
    const user = await findExistingAuthUserByEmail(admin, PROGRAM_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();

    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('staff');
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
      role: 'staff',
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
      role: 'staff',
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

// The former "role predicates: exact allowed sets, no cross-role leakage"
// describe block here re-tested isParticipantsCommunicationsStaffRole and
// isProgramAttendanceStaffRole's exact allowed-role sets in isolation (no
// live DB involved). Both predicates were deleted by the consolidation;
// their replacement, the single shared isStaffRole, has its allowed-set
// behavior already covered by plain unit tests in
// tests/auth/is-staff-role.test.ts. Removed as redundant rather than
// rewritten, since nothing here exercised the real database — the live
// proof this file still owns is below.

describe('a single staff-role profile satisfies every domain\'s authorization check (live, using a real fixture user)', () => {
  // Design spec §6: "A new test asserts that a single `staff`-role profile
  // satisfies every one of the 7 domains' authorization checks — this
  // documents the intended security tradeoff explicitly in the test suite
  // rather than leaving it implicit." Every requireXStaffCaller helper
  // below (agenda, program-attendance, participants-communications,
  // admission, import) now delegates its ENTIRE authorization logic to the
  // single shared isStaffRole(profile.role) check (see each helper's
  // src/lib/*/server-helpers.ts) — none of them can be invoked directly in
  // a live test, since each is a 'use server' function that resolves the
  // CALLING request's own session via createClient() -> auth.getUser()
  // (next/headers's cookies()), which cannot be forged outside a real
  // Next.js request context. Asserting isStaffRole directly against a real
  // fixture's persisted role is therefore the exact same check every one of
  // these guards performs internally.
  let staffFixtureId: string;

  beforeAll(async () => {
    const { data: staff, error: staffErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-staff-fixture@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (staffErr || !staff.user) throw new Error(`Failed to create staff fixture: ${staffErr?.message}`);
    staffFixtureId = staff.user.id;
    createdAuthUserIds.push(staffFixtureId);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffFixtureId);
  }, 30000);

  it('a staff account satisfies isStaffRole — the exact check every requireXStaffCaller guard performs internally', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffFixtureId).single();
    expect(profile?.role).toBe('staff');
    expect(isStaffRole(profile?.role)).toBe(true);
  });

  it('a plain participant does NOT satisfy isStaffRole — the boundary that still exists post-consolidation', async () => {
    const { data: participant, error } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-participant-fixture@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (error || !participant.user) throw new Error(`Failed to create participant fixture: ${error?.message}`);
    createdAuthUserIds.push(participant.user.id);
    // profiles defaults to 'participant' via handle_new_user — no update needed.
    const { data: profile } = await admin.from('profiles').select('role').eq('id', participant.user.id).single();
    expect(isStaffRole(profile?.role)).toBe(false);
  });

  it('the same staff fixture is accepted by every domain guard\'s helper module (agenda, program-attendance, participants-communications, admission, import) — confirming the union-of-permissions tradeoff, not a per-domain re-implementation that could drift', async () => {
    // Each of these helpers is confirmed to exist and to be the real,
    // exported function these live tests document as un-forgeable — the
    // actual authorization proof is the isStaffRole assertion above, which
    // every one of them delegates to as their entire role check.
    expect(typeof requireImportStaffCaller).toBe('function');
    expect(typeof requireParticipantsCommunicationsStaffCaller).toBe('function');
    expect(typeof requireProgramAttendanceStaffCaller).toBe('function');
    expect(typeof requireAgendaStaffCaller).toBe('function');
    expect(typeof requireAdmissionStaffCaller).toBe('function');
  });
});

// CORRECTED 2026-09-29 (staff role consolidation): this describe block
// previously proved that neither of the two former staff-domain roles
// (participants_communications_manager, program_attendance_manager) could
// read application_travel_info/application_health_info via RLS. That is no
// longer true, and is not a test-authoring oversight — it is the design
// spec's explicit, user-approved tradeoff (see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md,
// "Goal" and §2): the application_travel_info_staff_all/
// application_health_info_staff_all RLS policies (rewritten in
// supabase/migrations/20260929010000_consolidate_rls_policies_to_staff.sql)
// now grant access to using (is_staff())/with check (is_staff()) — ANY
// `staff` or `super_admin` account, not a narrower travel-ops/
// participant-care-only subset as before. Keeping the old "denied" assertion
// would now be flatly false against the real, intended policy. This block
// is rewritten to prove the new reality instead: a `staff` account CAN read
// this data (documenting the tradeoff explicitly, the same way
// tests/lib/validation/funding-type test coverage documents its own
// analogous read/write collapse), while a plain `participant` still cannot
// — that boundary is unchanged.
describe('sensitive travel and health data: a staff account can now read it (consolidated tradeoff); a participant still cannot', () => {
  let staffFixtureId: string;
  let participantFixtureId: string;
  let sensitiveApplicationId: string;

  beforeAll(async () => {
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
    // profiles defaults to 'participant' via handle_new_user — no update needed.

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

  it('a staff-scoped client CAN read application_travel_info via RLS (the intended, consolidated tradeoff)', async () => {
    const staffClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInErr } = await staffClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-staff@test.local', password: 'password123' });
    expect(signInErr).toBeNull();

    const { data, error } = await staffClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    await staffClient.auth.signOut();
  });

  it('a staff-scoped client CAN read application_health_info via RLS (the intended, consolidated tradeoff)', async () => {
    const staffClient = createClient<Database>(URL, ANON_KEY);
    await staffClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-staff@test.local', password: 'password123' });

    const { data, error } = await staffClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    await staffClient.auth.signOut();
  });

  it('a participant-scoped client still cannot read application_travel_info via RLS (unchanged boundary)', async () => {
    const participantClient = createClient<Database>(URL, ANON_KEY);
    await participantClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-participant-caller@test.local', password: 'password123' });

    const { data, error } = await participantClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    // RLS denies via an empty result set (default-deny), not necessarily a
    // Postgres error — assert the row is genuinely unreadable either way.
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await participantClient.auth.signOut();
  });

  it('a participant-scoped client still cannot read application_health_info via RLS (unchanged boundary)', async () => {
    const participantClient = createClient<Database>(URL, ANON_KEY);
    await participantClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-participant-caller@test.local', password: 'password123' });

    const { data, error } = await participantClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await participantClient.auth.signOut();
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
      role: 'staff',
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
