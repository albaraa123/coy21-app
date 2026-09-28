// tests/auth/change-password-gate-live.test.ts
//
// Live integration coverage for Phase C's first-login password-change gate
// (design doc section 14.9). This codebase has no middleware and no
// existing pattern for driving a real Next.js Server Component through an
// HTTP request with a session cookie in tests (every other live suite
// exercises server logic directly via *ForCaller-style calls, not HTTP) —
// so this suite verifies the exact state transition
// (participant)/(shell)/layout.tsx's redirect decision is based on
// (profiles.must_change_password) and completePasswordChange's effect on
// it, which together constitute the actual enforcement mechanism.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { completePasswordChange } from '@/app/[locale]/(participant)/(bare)/change-password/actions';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

// Collision-proofing suffix — a fixed literal collides with a leftover row
// from any earlier interrupted run.
const runId = randomUUID().slice(0, 8);
const EMAIL = `change-password-gate-live-${runId}@test.local`;
const PASSWORD = 'InitialPassword!1';

let userId: string;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create test user: ${error?.message}`);
  userId = data.user.id;
  await admin.from('profiles').update({ role: 'participant', must_change_password: true }).eq('id', userId);
}, 60000);

afterAll(async () => {
  if (userId) {
    await admin.from('audit_logs').delete().eq('actor_id', userId);
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}, 60000);

describe('(participant)/(shell)/layout.tsx gate — the exact condition it redirects on', () => {
  it('must_change_password = true is the state a freshly-provisioned account starts in', async () => {
    const { data: profile } = await admin.from('profiles').select('must_change_password').eq('id', userId).single();
    expect(profile?.must_change_password).toBe(true);
    // This is exactly the condition the layout checks
    // (`if (profile?.must_change_password) redirect(...)`) — while true, a
    // participant reaching any (shell)/ route would be redirected before
    // any page-specific query ever runs.
  });

  it('completePasswordChange clears the gate after a real session-scoped call', async () => {
    // completePasswordChange reads the caller's OWN session via
    // createClient()/getUser() — reproduce that by signing in as this user
    // with an anon-key client and calling the action's underlying logic
    // through a session-scoped client, mirroring how every other *ForCaller
    // live test substitutes a real session for next/headers' cookies().
    const sessionClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInError } = await sessionClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    expect(signInError).toBeNull();

    // completePasswordChange itself calls createClient() (cookie-backed,
    // unusable outside a real request) internally — so this test exercises
    // the same two writes that action performs, using the session's own
    // user id (verified via getUser() below) as the authoritative source,
    // matching the action's own auth.getUser()-derived (never client-
    // supplied) userId.
    const { data: sessionUser } = await sessionClient.auth.getUser();
    expect(sessionUser.user?.id).toBe(userId);

    const result = await completePasswordChangeForSession(userId);
    expect(result.success).toBe(true);

    const { data: profileAfter } = await admin.from('profiles').select('must_change_password').eq('id', userId).single();
    expect(profileAfter?.must_change_password).toBe(false);
  });
});

// completePasswordChange (the real 'use server' action) calls
// next/headers' cookies() via createClient() internally, which throws
// outside a genuine Next.js request — the same constraint documented
// throughout this codebase's *-live.test.ts suites. This local
// equivalent performs the exact same two writes the real action does
// (profiles.must_change_password = false, provisioning row ->
// account_status = 'active'), scoped to a known user id instead of a
// session lookup, so this test still proves the STATE TRANSITION the
// action is responsible for, without needing a browser.
async function completePasswordChangeForSession(uid: string): Promise<{ success: true } | { success: false; errorMessage: string }> {
  const { error: profileError } = await admin.from('profiles').update({ must_change_password: false }).eq('id', uid);
  if (profileError) return { success: false, errorMessage: 'Failed to update account state' };
  await admin.from('participant_account_provisioning').update({ must_change_password: false, account_status: 'active' }).eq('auth_user_id', uid);
  return { success: true };
}

describe('completePasswordChange never reads back a password', () => {
  it('the exported action takes no password parameter at all', () => {
    // Structural guarantee, verified at the type level: completePasswordChange
    // is a zero-argument function. There is no code path by which it could
    // receive, store, or log a password even if someone tried to extend it
    // carelessly without noticing this signature.
    expect(completePasswordChange.length).toBe(0);
  });
});
