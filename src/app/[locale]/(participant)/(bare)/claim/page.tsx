'use client';

// src/app/[locale]/(participant)/(bare)/claim/page.tsx
// (moved from (participant)/claim/ under Task 6's (bare) route group —
// see (participant)/(bare)/layout.tsx's doc comment for why; the URL
// /claim itself is unchanged, route groups are not part of the URL)
//
// The redirectTo target of Task 20's inviteUserByEmail call.
//
// ----------------------------------------------------------------------------
// TASK 6 NOTE — /my-dashboard redirect target — RESOLVED BY TASK 11
// ----------------------------------------------------------------------------
// Task 6's plan called for post-claim success (both the password-set path and
// "Skip for now") to redirect to /my-dashboard instead of /my-application,
// since /my-dashboard is the more semantically correct landing page for a
// newly-claimed participant. /my-dashboard did not exist as a real route at
// the time (it was built in Task 11) — redirecting there would have sent
// users to a 404, so router.push('/my-application') was intentionally left
// unchanged pending Task 11. Task 11 has now built the real page at
// (participant)/(shell)/my-dashboard/page.tsx, so both call sites below
// (handleSetPassword's redirect and the "Skip for now" button's onClick) now
// target '/my-dashboard'.
// ----------------------------------------------------------------------------
//
// ============================================================================
// WHY THIS IS A CLIENT COMPONENT (resolution of the plan's Step 3 ambiguity)
// ============================================================================
// The plan flags a genuine open question: does the invite redirect land the
// user here already authenticated, and does the invite flow require setting a
// password before anything else can happen? The email-send quota needed for
// the plan's suggested "send a real invite and observe" spike is exhausted and
// must not be touched, so this was resolved by reading the actual SDK code and
// this codebase's own auth wiring instead. Findings:
//
// 1. This project has NO middleware.ts (confirmed: none at src/ or repo root).
//    Nothing refreshes or exchanges an auth token server-side on a request.
//    Every existing page that needs a session (my-application, schedule) just
//    calls supabase.auth.getUser() against cookies that a CLIENT-side sign-in
//    already wrote — see log-in/page.tsx, which is 'use client' and calls
//    signInWithPassword in the browser. So in this codebase, sessions are
//    established client-side, full stop.
//
// 2. @supabase/ssr's createBrowserClient (node_modules/@supabase/ssr/dist/
//    main/createBrowserClient.js) sets `flowType: "pkce"` and
//    `detectSessionInUrl: options?.auth?.detectSessionInUrl ?? isBrowser()`.
//    So the browser client this codebase already uses automatically detects
//    the invite/magic-link callback params on load and exchanges them for a
//    session, writing it to the cookie storage the server client then reads.
//    That exchange happens in the BROWSER only — a Server Component rendering
//    this route cannot see it (a fragment never reaches the server at all, and
//    on the PKCE path the code-for-session exchange has not happened yet at
//    first render). A server-rendered version of this page would therefore
//    read "no session" on the very request the invite link produces, and would
//    incorrectly show the expired-link error to every legitimately invited
//    user. Hence: client component, and the session is awaited rather than
//    assumed.
//
// 3. Password: inviteUserByEmail creates the Auth user with no password. The
//    claim itself does NOT require one — claiming only needs auth.uid() to
//    resolve, which the token exchange in (2) already accomplishes,
//    independent of whether a password was ever set. But an invited user who
//    never sets one has no way to sign in again after this session expires
//    (this codebase's only other entry point is signInWithPassword on
//    log-in/page.tsx). So the password form is REQUIRED UX but NOT a
//    precondition of the claim: the claim fires as soon as a session exists,
//    and password-setting is offered afterwards as a separate, best-effort
//    step. A failure to set a password never un-does a completed claim.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/client';
import { claimApplication, findMyClaimableApplication } from './actions';
import { LoadingState } from '@/components/states/loading-state';
import { ErrorState } from '@/components/states/error-state';
import { Button } from '@/components/ui/button';

type Phase =
  | { kind: 'checking' }
  | { kind: 'no-session' }
  | { kind: 'claiming' }
  | { kind: 'claim-failed'; message: string }
  | { kind: 'claimed' };

export default function ClaimPage() {
  const router = useRouter();
  const t = useTranslations('claim');
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordState, setPasswordState] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // The claim must fire exactly once even though onAuthStateChange can emit
  // more than one event for a single page load (INITIAL_SESSION followed by
  // SIGNED_IN on the token exchange). A ref, not state: it has to be readable
  // synchronously inside the callback before any re-render happens.
  const claimStarted = useRef(false);

  const runClaim = useCallback(async () => {
    if (claimStarted.current) return;
    claimStarted.current = true;
    setPhase({ kind: 'claiming' });

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setPhase({ kind: 'no-session' });
      return;
    }

    // Which application is this invited user entitled to claim? Looked up by
    // the SESSION's user id against participant_invitations.invited_user_id,
    // never from a query parameter — a client-supplied application id here
    // would be an obvious ownership hole. (The RPC re-verifies this same
    // pairing server-side anyway, so this lookup is a convenience for the UI,
    // not the security boundary.)
    //
    // Done via a server action rather than a direct client query:
    // participant_invitations is staff-only under RLS
    // (participant_invitations_staff_all, 20260726105000_import_rls_policies
    // .sql), so a participant's own session provably cannot read its own
    // invitation row. findMyClaimableApplication performs that one narrow
    // lookup server-side, scoped to the caller's authenticated user id.
    const { applicationId, error: lookupError } = await findMyClaimableApplication();
    if (lookupError || !applicationId) {
      setPhase({
        kind: 'claim-failed',
        message:
          lookupError ??
          'No pending invitation was found for this account. This link may have already been used, or the invitation may have been revoked.',
      });
      return;
    }

    try {
      await claimApplication(applicationId);
      setPhase({ kind: 'claimed' });
    } catch (err) {
      setPhase({ kind: 'claim-failed', message: err instanceof Error ? err.message : 'Failed to claim this application' });
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();

    // onAuthStateChange rather than a bare getUser(): with detectSessionInUrl,
    // the token exchange is asynchronous and may not have completed at first
    // render, so a single getUser() on mount can race it and produce a false
    // "link expired". Subscribing means the claim runs whenever the session
    // actually materialises, whether that is immediately (already signed in)
    // or after the exchange completes.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) void runClaim();
    });

    // Fallback for the case where no session ever materialises: give the
    // exchange a bounded window, then show the expired/invalid-link error
    // rather than spinning forever.
    const timer = setTimeout(() => {
      if (!claimStarted.current) setPhase({ kind: 'no-session' });
    }, 5000);

    return () => {
      subscription.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [runClaim]);

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      setPasswordState({ kind: 'error', message: 'Passwords do not match' });
      return;
    }
    setPasswordState({ kind: 'saving' });
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setPasswordState({ kind: 'error', message: error.message });
      return;
    }
    setPasswordState({ kind: 'saved' });
    router.push('/my-dashboard');
  }

  if (phase.kind === 'checking' || phase.kind === 'claiming') {
    return <LoadingState variant="section" label={t('verifying')} />;
  }

  if (phase.kind === 'no-session') {
    return <ErrorState title={t('invalidLink.title')} description={t('invalidLink.description')} />;
  }

  if (phase.kind === 'claim-failed') {
    return <ErrorState title={t('claimFailed.title')} description={phase.message} />;
  }

  // Claim succeeded. Password-setting is offered here as a separate step —
  // the claim is already committed and durable at this point, so skipping
  // this form loses nothing except the ability to sign in again later.
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('claimed.title')}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('claimed.setPasswordPrompt')}</p>
      </div>
      <form onSubmit={handleSetPassword} className="flex flex-col gap-3">
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder={t('claimed.newPasswordPlaceholder')}
          required
          minLength={8}
          className="w-full rounded-md border border-charcoal/20 bg-white px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <input
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          type="password"
          placeholder={t('claimed.confirmPasswordPlaceholder')}
          required
          minLength={8}
          className="w-full rounded-md border border-charcoal/20 bg-white px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <Button type="submit" disabled={passwordState.kind === 'saving'}>
          {t('claimed.submitLabel')}
        </Button>
      </form>
      {passwordState.kind === 'error' && (
        <p className="text-sm text-red-700 dark:text-red-300">{passwordState.message}</p>
      )}
      <Button type="button" variant="ghost" onClick={() => router.push('/my-dashboard')}>
        {t('claimed.skipLabel')}
      </Button>
    </div>
  );
}
