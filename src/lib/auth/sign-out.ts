/**
 * The DB-touching half of logout: signs out a given Supabase client's
 * current session. Deliberately has ZERO dependency on Next.js-specific
 * modules (no 'next/navigation', no '@/i18n/routing', no 'next/headers')
 * so it can be:
 *   1. imported and called directly by src/app/[locale]/(auth)/actions.ts's
 *      logOutAction (the real 'use server' entry point used in production),
 *      AND
 *   2. imported directly by tests/shell/logout-live.test.ts and run in a
 *      plain vitest/Node process — next-intl's createNavigation() (used by
 *      '@/i18n/routing', which the surrounding actions.ts needs for
 *      redirect()) resolves 'next/navigation' via Next's own bundler-aware
 *      module resolution, which is unavailable in a plain vitest run and
 *      throws "Cannot find module 'next/navigation'" if that import chain
 *      is pulled in. Isolating this function in its own Next-agnostic
 *      module sidesteps that entirely, letting the live test exercise the
 *      REAL signOut() call with a REAL signed-in client with no mocking.
 *
 * signOut() genuinely invalidates the session server-side (revokes the
 * refresh token and, when called through the cookie-backed client
 * production uses, clears the auth cookies via the cookie adapter) —
 * unlike a client-only redirect that would leave cookies/tokens valid.
 * This is the real security property tests/shell/logout-live.test.ts
 * verifies: it signs in with a real anon-key client, calls this function
 * with that same client, and then proves the session is actually dead.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

export async function signOutWithClient(
  client: SupabaseClient<Database>
): Promise<{ error?: string }> {
  try {
    const { error } = await client.auth.signOut();
    if (error) {
      return { error: error.message };
    }
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to sign out' };
  }
}
