// src/app/[locale]/(auth)/actions.ts
'use server';

import { getLocale } from 'next-intl/server';
import { createClient } from '@/lib/supabase/server';
import { redirect } from '@/i18n/routing';
import { signOutWithClient } from '@/lib/auth/sign-out';
import { resolvePostLoginDestination } from '@/lib/auth/post-login-destination';

export interface LogOutActionState {
  error?: string;
}

/**
 * Logs the current user out of their server-side session and redirects to
 * the localized /log-in page.
 *
 * Follows the REAL established 'use server' pattern in this codebase (see
 * src/app/[locale]/(participant)/(bare)/claim/actions.ts): an async
 * createClient() from '@/lib/supabase/server' (the cookie-backed server
 * client), NOT the browser client from '@/lib/supabase/client' that
 * log-in/page.tsx uses (that file is a 'use client' component and has
 * nothing to do with server actions — see Task 5's brief correction).
 *
 * The actual signOut() call lives in src/lib/auth/sign-out.ts
 * (signOutWithClient), split out into its own Next.js-agnostic module so
 * tests/shell/logout-live.test.ts can call it directly with a real
 * signed-in client — see that file's doc comment for why: this
 * actions.ts file imports '@/i18n/routing' for redirect(), and
 * next-intl's createNavigation() resolves 'next/navigation' via Next's
 * bundler-aware module resolution, which throws "Cannot find module" in
 * a plain vitest/Node run. Isolating signOutWithClient from that import
 * chain lets the live test exercise the real signOut() call with zero
 * mocking, the same way claimApplication's `sessionClient` parameter
 * (src/app/[locale]/(participant)/(bare)/claim/actions.ts) lets its live test
 * supply a real signed-in client instead of relying on next/headers'
 * cookies(), unavailable outside a real Next.js request.
 *
 * next-intl's redirect() throws a special NEXT_REDIRECT error to
 * terminate the request. Per Next.js's own docs (redirect() "should be
 * called outside the try block when using try/catch statements" —
 * throwing that internal signal must never be swallowed by a catch
 * clause), THIS function contains no try/catch at all: the only code
 * that can throw/error (signOut() itself) is fully contained within
 * signOutWithClient, which catches its own errors and returns them as
 * data. On success (no error returned), execution falls through to the
 * unconditional redirect(). On failure, an error state is returned
 * instead of redirecting, so the form can display it (see UserMenu's
 * LogoutSubmitButton / the error paragraph rendered next to it).
 *
 * `return redirect(...)` is used only to satisfy TypeScript's
 * control-flow analysis of this function's Promise<LogOutActionState>
 * return type (redirect()'s own return type is `never`, so wrapping it
 * in `return` does not change its behavior).
 *
 * The locale to redirect back to is read via next-intl/server's
 * getLocale() — the same established pattern every existing
 * redirect({ href: '/log-in', locale }) call site in this codebase uses
 * (e.g. src/app/[locale]/(admin)/agenda/page.tsx) — rather than hardcoding
 * a locale, so a logged-out EN user lands on /en/log-in, not /ar/log-in.
 */
export async function logOutAction(
  _prevState: LogOutActionState | undefined,
  _formData: FormData
): Promise<LogOutActionState> {
  const supabase = await createClient();
  const result = await signOutWithClient(supabase);
  if (result.error) {
    return result;
  }

  const locale = await getLocale();
  return redirect({ href: '/log-in', locale });
}

/**
 * Task 7's fix for the pre-existing bug where log-in always redirected to
 * /my-application regardless of the signed-in user's role. Called by
 * log-in/page.tsx AFTER its own client-side supabase.auth.signInWithPassword()
 * call has already succeeded (that call itself is left completely
 * untouched — see log-in/page.tsx's doc comment for why the sign-in call
 * must stay client-side in this codebase).
 *
 * This is a 'use server' action, not a client-side query, specifically
 * for the authorization property the plan calls out: the redirect
 * destination must come from a SERVER-VERIFIED profiles.role lookup, not
 * anything client-trusted (e.g. metadata on the client SDK's session/user
 * object, which the browser could in principle observe or which could be
 * stale). createClient() here is the cookie-backed server client (same
 * import as logOutAction above) — by the time the browser calls this
 * action, the sign-in has already written the session cookie, so this
 * runs as a genuinely authenticated server-side request and reads the
 * caller's OWN row under RLS's `profiles_select_own` policy (id =
 * auth.uid(); see supabase/migrations/20260721212035_rls_policies.sql) —
 * no service-role client needed, since this action only ever needs to
 * look up its own caller, never another user's role.
 *
 * The actual staff-vs-participant decision and the (temporary, pending
 * Task 11) destination routes live in resolvePostLoginDestination
 * (src/lib/auth/post-login-destination.ts) — see that file's doc comment
 * for the 404-avoidance reasoning and STAFF_ROLES definition. Splitting
 * the decision into its own Next-agnostic module (rather than inlining it
 * here) follows decideAdminAccess/signOutWithClient's established
 * pattern, and is what lets it be unit-tested directly in
 * tests/lib/auth/post-login-destination.test.ts and live-tested (this
 * action's actual DB read) in tests/auth/post-login-redirect-live.test.ts
 * without either pulling in next/headers or '@/i18n/routing' — see
 * sign-out.ts's doc comment for why those two imports specifically break
 * a plain vitest/Node run.
 */
export async function resolvePostLoginRedirectAction(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const locale = await getLocale();

  if (!user) {
    // No authenticated session found (e.g. called out of order, or the
    // session cookie failed to persist) — fail closed to /log-in rather
    // than guessing a destination.
    redirect({ href: '/log-in', locale });
    return;
  }

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
  const destination = resolvePostLoginDestination(profile?.role);
  redirect({ href: destination.href, locale });
}
