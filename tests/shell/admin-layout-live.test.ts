// tests/shell/admin-layout-live.test.ts
//
// Live integration coverage for (admin)/layout.tsx's authorization gate,
// exercising the REAL Supabase query it runs (the same
// createServiceRoleClient().from('profiles').select('role, full_name')
// read) against a genuine profiles row, then feeding the real result into
// decideAdminAccess (the same pure decision function the layout itself
// calls). This is the live-DB half of Task 6's test requirement; the pure
// branching logic itself is covered without any DB in
// tests/lib/shell/admin-access.test.ts.
//
// WHY NOT RENDER (admin)/layout.tsx DIRECTLY: it is a Next.js Server
// Component that calls next/headers' cookies() (via '@/lib/supabase/
// server' createClient()) and '@/i18n/routing' redirect() — both throw
// "Cannot find module" outside a real Next.js request/build, exactly as
// documented in tests/shell/logout-live.test.ts's doc comment for the
// sibling case of logOutAction. This test instead proves the two things
// that actually vary with real data:
//   1. A genuine unauthenticated caller (no session) is not able to read
//      any profiles row for themselves — there is no "current user" to
//      resolve, matching the layout's own `if (!user) redirect(...)`
//      branch's precondition.
//   2. A genuine authenticated participant's real profiles.role, fetched
//      via the SAME service-role query the layout performs, is correctly
//      classified as unauthorized (destination /my-dashboard) by
//      decideAdminAccess, and a genuine staff row is classified as
//      authorized — proving the query + decision function combination
//      the layout relies on actually behaves correctly against live
//      data, not just against hand-written role strings.
//
// Task 7 code-review fix: decideAdminAccess switched from isAgendaStaffRole
// (2 of 4 non-participant roles) to isStaffRole (all 4) — see
// admin-access.ts's doc comment for why (registration_admission_manager
// and communications_attendance_manager were genuine staff getting
// redirected into an UnauthorizedState dead end). ALL_STAFF_ROLES below
// extends this file's existing single-role staff case into a loop over
// all 4 real roles, so every one of them is proven authorized against a
// live profiles row, not just agenda_allocation_manager.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { decideAdminAccess } from '@/lib/shell/admin-access';
import { NON_PARTICIPANT_ROLES } from '@/lib/auth/post-login-destination';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PASSWORD = 'password123';
const EMAIL_PREFIX = 'admin-layout-live-';
const EMAIL_DOMAIN = 'test.local';

const createdAuthUserIds: string[] = [];

async function createTestUser(email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Failed to create auth user: ${error?.message}`);
  createdAuthUserIds.push(data.user.id);
  return data.user.id;
}

async function sweepByPrefix() {
  let page = 1;
  const perPage = 1000;
  const stragglers: string[] = [];
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) break;
    for (const u of data.users) {
      if (u.email?.toLowerCase().startsWith(EMAIL_PREFIX)) stragglers.push(u.id);
    }
    if (data.users.length < perPage) break;
    page += 1;
  }
  for (const id of stragglers) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}

beforeAll(async () => {
  await sweepByPrefix();
}, 300000);

afterAll(async () => {
  for (const id of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
  await sweepByPrefix();
}, 300000);

describe('(admin)/layout.tsx access gate — live', () => {
  it('an unauthenticated (anon, unsigned-in) client resolves no user, matching the redirect-unauthenticated branch precondition', async () => {
    const anon = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false } });
    const { data } = await anon.auth.getUser();
    expect(data.user).toBeNull();
    expect(decideAdminAccess(data.user?.id, undefined)).toEqual({ kind: 'redirect-unauthenticated' });
  }, 60000);

  it('a real participant profile row is classified unauthorized -> /my-dashboard by the same query+decision pair the layout uses', async () => {
    const email = `${EMAIL_PREFIX}participant-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createTestUser(email);

    // handle_new_user() (roles_and_profiles.sql) creates the profiles row
    // automatically on auth.users insert, defaulting role to 'participant'
    // — exactly the same trigger every other live test in this repo
    // relies on for profile creation.
    const { data: profile, error } = await admin.from('profiles').select('role, full_name').eq('id', userId).maybeSingle();
    expect(error).toBeNull();
    expect(profile?.role).toBe('participant');

    const decision = decideAdminAccess(userId, profile?.role);
    expect(decision).toEqual({ kind: 'unauthorized', destinationHref: '/my-dashboard' });
  }, 60000);

  it('a real agenda_allocation_manager profile row is classified authorized by the same query+decision pair the layout uses', async () => {
    const email = `${EMAIL_PREFIX}staff-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createTestUser(email);

    const { error: updateError } = await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', userId);
    expect(updateError).toBeNull();

    const { data: profile, error } = await admin.from('profiles').select('role, full_name').eq('id', userId).maybeSingle();
    expect(error).toBeNull();
    expect(profile?.role).toBe('agenda_allocation_manager');

    const decision = decideAdminAccess(userId, profile?.role);
    expect(decision).toEqual({ kind: 'authorized' });
  }, 60000);

  it.each(NON_PARTICIPANT_ROLES)(
    'a real %s profile row is classified authorized by the same query+decision pair the layout uses (Task 7 fix: all 4 staff roles, not just agenda-scoped ones)',
    async (role) => {
      const email = `${EMAIL_PREFIX}${role}-${Date.now()}@${EMAIL_DOMAIN}`;
      const userId = await createTestUser(email);

      const { error: updateError } = await admin.from('profiles').update({ role }).eq('id', userId);
      expect(updateError).toBeNull();

      const { data: profile, error } = await admin.from('profiles').select('role, full_name').eq('id', userId).maybeSingle();
      expect(error).toBeNull();
      expect(profile?.role).toBe(role);

      const decision = decideAdminAccess(userId, profile?.role);
      expect(decision).toEqual({ kind: 'authorized' });
    },
    60000
  );
});
