'use client';

// src/app/[locale]/(auth)/reset-password/page.tsx
//
// Landing page for forgot-password/page.tsx's resetPasswordForEmail()
// link. Reuses claim/page.tsx's exact session-detection pattern (see
// that file's header comment, point 2, for the full reasoning) rather
// than inventing a new one: Supabase's PKCE recovery link also carries
// an auth fragment that the browser client exchanges for a session
// asynchronously on load (detectSessionInUrl), so a bare
// supabase.auth.getUser() on mount can race that exchange and produce a
// false "link expired" for a user who followed a genuinely valid link.
// onAuthStateChange + a bounded fallback timer, exactly like claim/
// page.tsx, avoids that race.
//
// Password is set via supabase.auth.updateUser({ password }) -- the
// same call claim/page.tsx and change-password/page.tsx both already
// use; Supabase Auth has no server-side "set this user's password to X"
// call usable from the user's own session (only auth.admin.updateUserById,
// service-role-only), so this must run client-side here too.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, Link } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/client';
import { LoadingState } from '@/components/states/loading-state';
import { ErrorState } from '@/components/states/error-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type Phase = { kind: 'checking' } | { kind: 'ready' } | { kind: 'no-session' };

export default function ResetPasswordPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Mirrors claim/page.tsx's claimStarted ref -- onAuthStateChange can
  // fire more than once for a single page load (INITIAL_SESSION then
  // SIGNED_IN on the token exchange); this just needs to flip the phase
  // once, not run an action exactly once, but the same ref-not-state
  // reasoning (readable synchronously inside the callback) applies.
  const ready = useRef(false);

  const markReady = useCallback(() => {
    if (ready.current) return;
    ready.current = true;
    setPhase({ kind: 'ready' });
  }, []);

  useEffect(() => {
    const supabase = createClient();
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) markReady();
    });
    const timer = setTimeout(() => {
      if (!ready.current) setPhase({ kind: 'no-session' });
    }, 5000);
    return () => {
      subscription.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [markReady]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError(t('mismatchError'));
      return;
    }
    setSubmitting(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      router.push('/my-dashboard');
    } finally {
      setSubmitting(false);
    }
  }

  if (phase.kind === 'checking') {
    return <LoadingState variant="section" label={t('verifying')} />;
  }

  if (phase.kind === 'no-session') {
    return (
      <>
        <ErrorState title={t('resetLinkInvalidTitle')} description={t('resetLinkInvalidDescription')} />
        <Link href="/forgot-password" className="mt-4 block text-center text-sm font-medium text-turquoise hover:underline">
          {t('requestNewLink')}
        </Link>
      </>
    );
  }

  return (
    <Card className="border-0 p-0 shadow-none">
      <h1 className="font-serif text-xl font-semibold text-charcoal dark:text-gray-100">{t('resetPasswordTitle')}</h1>
      <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('resetPasswordSubtitle')}</p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-password" className="text-sm font-medium text-charcoal dark:text-gray-200">
            {t('newPasswordLabel')}
          </label>
          <Input
            id="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            required
            minLength={8}
            className="rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus:ring-1 focus:ring-turquoise dark:border-gray-700 dark:text-gray-100"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="confirm-password" className="text-sm font-medium text-charcoal dark:text-gray-200">
            {t('confirmPasswordLabel')}
          </label>
          <Input
            id="confirm-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            type="password"
            required
            minLength={8}
            className="rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus:ring-1 focus:ring-turquoise dark:border-gray-700 dark:text-gray-100"
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="mt-2 w-full">
          {submitting ? t('forgotPasswordSubmitting') : t('resetPasswordSubmit')}
        </Button>
      </form>
    </Card>
  );
}
