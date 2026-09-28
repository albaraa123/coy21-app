'use client';

// src/app/[locale]/(auth)/log-in/page.tsx
//
// Task 7: restyled log-in form + role-aware redirect fix (previously
// always router.push('/my-application') regardless of the signed-in
// user's role — see resolvePostLoginRedirectAction's doc comment in
// ../actions.ts for the fix).
//
// The supabase.auth.signInWithPassword() call below is left byte-for-byte
// unchanged in behavior from the pre-Task-7 version: same client-side
// '@/lib/supabase/client' createClient(), same call shape, same
// error-handling branch (setError(error.message); return). This MUST
// stay client-side — see Task 5's investigation (referenced in this
// task's brief): this codebase establishes sessions client-side via the
// browser SDK, full stop, with no middleware, and signInWithPassword()
// genuinely needs to run in the browser to write the session cookie via
// the client SDK's storage adapter. Only what happens AFTER a successful
// sign-in has changed: instead of an unconditional client-trusted
// router.push('/my-application'), it now calls
// resolvePostLoginRedirectAction — a 'use server' action that
// independently re-reads the caller's profiles.role server-side (under
// RLS, using the session cookie signInWithPassword() just established)
// and redirects based on THAT, never anything client-trusted. See that
// action's doc comment (../actions.ts) for the full authorization
// reasoning and the 404-avoidance TODO for Task 11.
//
// ERROR HANDLING (code-review follow-up): resolvePostLoginRedirectAction
// ends with a call to next-intl's redirect(), which - like next/navigation's
// own redirect() it wraps - signals success by THROWING a special
// "NEXT_REDIRECT" error (see node_modules/next/dist/client/components/
// redirect-error.js's isRedirectError: it checks error.digest starts with
// 'NEXT_REDIRECT;'). That's expected on the successful path and must never
// be treated as a real failure. A genuine failure (e.g. a transient
// network/DB error on the profiles.role read, thrown before redirect() is
// ever reached) would otherwise leave a freshly-authenticated user on a
// blank/unresponsive screen with no feedback, since there's no
// (auth)/error.tsx boundary. isNextRedirectDigest below re-implements
// Next's own digest check locally (rather than deep-importing its
// internal, non-'next/navigation'-exported isRedirectError from
// 'next/dist/...', which isn't part of the public API surface this
// codebase otherwise relies on) so a real error can be told apart from the
// expected redirect throw and surfaced via the same error paragraph the
// sign-in step above already uses.
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { resolvePostLoginRedirectAction } from '../actions';

function isNextRedirectDigest(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

export default function LogInPage() {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      return;
    }
    startTransition(async () => {
      try {
        await resolvePostLoginRedirectAction();
      } catch (err) {
        // Expected on success: resolvePostLoginRedirectAction's own
        // redirect() call throws this to terminate the request - must be
        // re-thrown, never swallowed, or the actual navigation breaks.
        if (isNextRedirectDigest(err)) {
          throw err;
        }
        // A genuine failure (network/DB error before redirect() was
        // reached) - the user already authenticated successfully, so
        // surface a recoverable message rather than leaving them stuck.
        setError('Something went wrong finishing sign-in. Please try again.');
      }
    });
  }

  return (
    <Card className="border-0 p-0 shadow-none">
      <h1 className="font-serif text-xl font-semibold text-charcoal dark:text-gray-100">{t('logInTitle')}</h1>
      <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('logInSubtitle')}</p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium text-charcoal dark:text-gray-200">
            {t('emailLabel')}
          </label>
          <input
            id="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            className="rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus:ring-1 focus:ring-turquoise dark:border-gray-700 dark:text-gray-100"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium text-charcoal dark:text-gray-200">
            {t('passwordLabel')}
          </label>
          <input
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            required
            className="rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus:ring-1 focus:ring-turquoise dark:border-gray-700 dark:text-gray-100"
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <Button type="submit" disabled={isPending} className="mt-2 w-full">
          {t('logInSubmit')}
        </Button>
      </form>
    </Card>
  );
}
