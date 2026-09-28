// tests/auth/post-login-redirect-live.test.ts
//
// Live integration coverage for Task 7's role-aware log-in redirect fix
// (previously: log-in always redirected to /my-application regardless of
// role). Runs against the live linked Supabase project (no local Postgres
// exists for this project), same as every other tests/**/*-live.test.ts
// (see tests/shell/logout-live.test.ts's doc comment for the established
// rationale).
//
// WHY NOT CALL resolvePostLoginRedirectAction DIRECTLY: it is a 'use
// server' Next.js Server Action that imports '@/i18n/routing' for
// redirect() and '@/lib/supabase/server' for the cookie-backed
// createClient() (next/headers' cookies()) — both throw "Cannot find
// module" outside a real Next.js request/build, exactly as documented in
// tests/shell/logout-live.test.ts's and tests/shell/admin-layout-live
// .test.ts's doc comments for the identical problem with logOutAction and
// (admin)/layout.tsx respectively. Per that established pattern, this
// test instead proves the two things that actually vary with real data
// and together make up 100% of the action's decision-relevant logic:
//   1. A real signed-in user can read their OWN profiles.role row via the
//      SAME query shape the action performs (an anon-key client,
//      authenticated as that user, `.from('profiles').select('role')
//      .eq('id', user.id)`) — proving RLS's profiles_select_own policy
//      (id = auth.uid()) genuinely permits the read the action depends
//      on, not just that a service-role client could see it.
//   2. That real, RLS-fetched role value, fed into
//      resolvePostLoginDestination (the same pure decision function the
//      action calls), resolves to the correct destination for a genuine
//      staff account and a genuine participant account.
// The only code NOT exercised by this test is the action's own
// orchestration glue (calling supabase.auth.getUser(), then redirect())
// — both are single-line, untestable-without-a-real-request calls with no
// branching logic of their own once the role lookup and decision are
// proven correct, the same carve-out logout-live.test.ts and
// admin-layout-live.test.ts already document for their sibling actions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { resolvePostLoginDestination } from '@/lib/auth/post-login-destination';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PASSWORD = 'password123';
const EMAIL_PREFIX = 'post-login-redirect-live-';
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

async function signInAs(email: string) {
  const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Failed to sign in as ${email}: ${error.message}`);
  return client;
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

describe('post-login redirect (live) — real profiles.role read + resolvePostLoginDestination', () => {
  it('a real participant, signed in, is resolved (via their own RLS-scoped role read) to /my-dashboard', async () => {
    const email = `${EMAIL_PREFIX}participant-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createTestUser(email);
    const session = await signInAs(email);

    // handle_new_user() (roles_and_profiles.sql) creates the profiles row
    // automatically on auth.users insert, defaulting role to 'participant'
    // — same trigger every other live test in this repo relies on.
    const { data: profile, error } = await session.from('profiles').select('role').eq('id', userId).maybeSingle();
    expect(error).toBeNull();
    expect(profile?.role).toBe('participant');

    const destination = resolvePostLoginDestination(profile?.role);
    expect(destination).toEqual({ href: '/my-dashboard' });
  }, 60000);

  it('a real staff user (agenda_allocation_manager), signed in, is resolved (via their own RLS-scoped role read) to /dashboard', async () => {
    const email = `${EMAIL_PREFIX}staff-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createTestUser(email);

    const { error: updateError } = await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', userId);
    expect(updateError).toBeNull();

    const session = await signInAs(email);
    const { data: profile, error } = await session.from('profiles').select('role').eq('id', userId).maybeSingle();
    expect(error).toBeNull();
    expect(profile?.role).toBe('agenda_allocation_manager');

    const destination = resolvePostLoginDestination(profile?.role);
    expect(destination).toEqual({ href: '/dashboard' });
  }, 60000);

  it('a real super_admin, signed in, is resolved (via their own RLS-scoped role read) to /dashboard', async () => {
    const email = `${EMAIL_PREFIX}superadmin-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createTestUser(email);

    const { error: updateError } = await admin.from('profiles').update({ role: 'super_admin' }).eq('id', userId);
    expect(updateError).toBeNull();

    const session = await signInAs(email);
    const { data: profile, error } = await session.from('profiles').select('role').eq('id', userId).maybeSingle();
    expect(error).toBeNull();
    expect(profile?.role).toBe('super_admin');

    const destination = resolvePostLoginDestination(profile?.role);
    expect(destination).toEqual({ href: '/dashboard' });
  }, 60000);

  it('a real scanner_device account, signed in, is resolved (via their own RLS-scoped role read) to /scanner, not /dashboard — the real-device bug this test guards against required a second manual navigation after every login', async () => {
    const email = `${EMAIL_PREFIX}scanner-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createTestUser(email);

    const { error: updateError } = await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', userId);
    expect(updateError).toBeNull();

    const session = await signInAs(email);
    const { data: profile, error } = await session.from('profiles').select('role').eq('id', userId).maybeSingle();
    expect(error).toBeNull();
    expect(profile?.role).toBe('scanner_device');

    const destination = resolvePostLoginDestination(profile?.role);
    expect(destination).toEqual({ href: '/scanner' });
  }, 60000);
});
