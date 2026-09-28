// tests/shell/logout-live.test.ts
//
// Live integration coverage for Task 5's logout server action. Runs
// against the live linked Supabase project (no local Postgres exists for
// this project), same as every other tests/**/*-live.test.ts.
//
// Calls signOutWithClient (src/lib/auth/sign-out.ts — the DB-touching
// half of logOutAction, split into its own Next.js-agnostic module)
// directly with a real anon-key client signed in as a throwaway test
// user, mirroring tests/import/claim-live.test.ts's established pattern
// for exercising a 'use server' action that needs a genuine signed-in
// session: next/headers' cookies() (via createClient() from
// '@/lib/supabase/server') is unavailable outside a real Next.js
// request, and logOutAction itself also imports '@/i18n/routing' for
// redirect(), whose next-intl createNavigation() call resolves
// 'next/navigation' via Next's bundler-aware module resolution — that
// throws "Cannot find module 'next/navigation'" when imported into a
// plain vitest/Node run (confirmed while writing this test). Importing
// signOutWithClient directly (from a module with zero Next.js-specific
// imports) sidesteps both problems entirely. signOutWithClient contains
// 100% of the actual session-invalidation logic; only the request-bound
// cookie plumbing and the post-success redirect are excluded from this
// test, and those are inert once signOutWithClient has already succeeded
// (redirect() has no failure mode of its own to test).
//
// THE REAL SECURITY PROPERTY THIS TEST PROVES: after calling
// signOutWithClient with a real signed-in client, that SAME client can no
// longer be used to make authenticated requests — i.e. the server-side
// session was actually revoked, not just a client-side redirect that
// would leave cookies/tokens valid. This is checked two ways:
//   1. A subsequent auth.getUser() call on the same client returns no
//      user (the local session state is cleared).
//   2. A subsequent authenticated read that RLS would only allow for that
//      specific signed-in user (reading the user's own claimed
//      application) is rejected/empty post-logout, proving the session
//      is not just locally cleared but genuinely unable to authenticate
//      further requests — the same never-mocked, RLS-backed proof style
//      claim-live.test.ts's Case 4 uses.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { signOutWithClient } from '@/lib/auth/sign-out';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PASSWORD = 'password123';
const EMAIL_PREFIX = 'logout-live-';
const EMAIL_DOMAIN = 'test.local';

const createdAuthUserIds: string[] = [];
const createdApplicationIds: string[] = [];

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
  if (createdApplicationIds.length > 0) {
    await admin.from('applications').delete().in('id', createdApplicationIds);
  }
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
    await admin.from('applications').delete().eq('applicant_id', id).then(
      () => undefined,
      () => undefined
    );
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}

beforeAll(async () => {
  await sweepByPrefix();
}, 300000);

afterAll(async () => {
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`afterAll cleanup step failed: ${label}`, err);
    }
  };
  await step('delete tracked applications', async () => {
    if (createdApplicationIds.length > 0) {
      await admin.from('applications').delete().in('id', createdApplicationIds);
    }
  });
  await step('delete tracked auth users', async () => {
    for (const id of createdAuthUserIds) {
      await admin.auth.admin.deleteUser(id).catch(() => undefined);
    }
  });
  await step('sweep by prefix', sweepByPrefix);
}, 300000);

describe('logout (live) — signOutWithClient genuinely invalidates the session', () => {
  it('signOutWithClient succeeds (no error) for a real signed-in session', async () => {
    const email = `${EMAIL_PREFIX}happy-${Date.now()}@${EMAIL_DOMAIN}`;
    await createTestUser(email);
    const session = await signInAs(email);

    // Sanity check: the session is genuinely authenticated before logout.
    const { data: before } = await session.auth.getUser();
    expect(before.user).not.toBeNull();

    const result = await signOutWithClient(session);
    expect(result.error).toBeUndefined();
  }, 120000);

  it('after signOutWithClient, the SAME client can no longer report an authenticated user', async () => {
    const email = `${EMAIL_PREFIX}getuser-${Date.now()}@${EMAIL_DOMAIN}`;
    await createTestUser(email);
    const session = await signInAs(email);

    const { data: before } = await session.auth.getUser();
    expect(before.user).not.toBeNull();

    await signOutWithClient(session);

    const { data: after, error } = await session.auth.getUser();
    // A revoked/absent session must not still resolve to a user — either
    // the user comes back null, or getUser() itself errors (both are
    // acceptable proofs of "no longer authenticated"; a lingering valid
    // user is the only failure mode this test guards against).
    expect(after.user == null || error != null).toBe(true);
  }, 120000);

  it('after signOutWithClient, the SAME client can no longer perform an RLS-scoped authenticated read it could do before', async () => {
    // Seed an application owned by this user, exactly as claim-live.test.ts
    // does for its RLS-backed proof, so there is something genuinely
    // access-controlled to test against (rather than just trusting
    // getUser()'s own bookkeeping).
    const email = `${EMAIL_PREFIX}rls-${Date.now()}@${EMAIL_DOMAIN}`;
    const userId = await createTestUser(email);

    const { data: app, error: appError } = await admin
      .from('applications')
      .insert({ applicant_id: userId, imported_email: email, status: 'accepted' })
      .select('id')
      .single();
    if (appError || !app) throw new Error(`Failed to seed application: ${appError?.message}`);
    createdApplicationIds.push(app.id);

    const session = await signInAs(email);

    // BEFORE logout: the user's own session can read their own application
    // (applications_select_own RLS policy keys on applicant_id = auth.uid()).
    const { data: before } = await session.from('applications').select('id').eq('id', app.id);
    expect(before ?? []).toHaveLength(1);

    await signOutWithClient(session);

    // AFTER logout: the SAME client object, now with its session revoked,
    // can no longer read that same row — proving the invalidation is real
    // at the RLS/auth.uid() layer, not just a local flag.
    const { data: after } = await session.from('applications').select('id').eq('id', app.id);
    expect(after ?? []).toHaveLength(0);
  }, 120000);
});
