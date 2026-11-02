'use client';

// src/app/[locale]/(auth)/forgot-password/page.tsx
//
// Real, previously-missing participant-facing gap: there was no
// self-service password recovery anywhere on the site (no "Forgot
// password?" link on log-in, no page for it, no action calling
// resetPasswordForEmail anywhere in the codebase). With ~500 real
// participants, some will forget their password, and the only existing
// recovery path was contacting staff manually.
//
// supabase.auth.resetPasswordForEmail() is called client-side, matching
// this codebase's own established, explicitly-documented rule (see
// claim/page.tsx's header comment, point 1): this project has no
// middleware.ts, sessions/auth calls are established client-side via the
// browser SDK, full stop. log-in/page.tsx's signInWithPassword() and
// claim/page.tsx's updateUser({ password }) both already follow this
// same rule -- this page does too, for consistency and because it's the
// only call shape that actually works in this codebase's auth wiring.
//
// redirectTo mirrors inviteUserByEmail's own exact pattern
// (src/lib/import/invitation.ts): `${NEXT_PUBLIC_SITE_URL}/reset-password`,
// an absolute URL built from the same env var already used for every
// other Supabase Auth redirect in this codebase, rather than inventing a
// second convention.
//
// Deliberately shows the SAME confirmation message whether or not the
// email actually matches an account (never "no account found") -- same
// user-enumeration-prevention reasoning sign-up/page.tsx's own comment
// already documents for Supabase's own signUp() behavior; the request to
// Supabase's resetPasswordForEmail is designed the same way (returns
// success either way), and this page does not second-guess that by
// trying to reveal the difference.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export default function ForgotPasswordPage() {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = createClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/reset-password`,
      });
      if (resetError) {
        setError(resetError.message);
        return;
      }
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Card className="border-0 p-0 shadow-none">
        <h1 className="font-serif text-xl font-semibold text-charcoal dark:text-gray-100">{t('forgotPasswordSentTitle')}</h1>
        <p className="mt-2 text-sm text-charcoal/70 dark:text-gray-400">{t('forgotPasswordSentDescription', { email })}</p>
        <Link href="/log-in" className="mt-6 inline-block text-sm font-medium text-turquoise hover:underline">
          {t('backToLogIn')}
        </Link>
      </Card>
    );
  }

  return (
    <Card className="border-0 p-0 shadow-none">
      <h1 className="font-serif text-xl font-semibold text-charcoal dark:text-gray-100">{t('forgotPasswordTitle')}</h1>
      <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('forgotPasswordSubtitle')}</p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium text-charcoal dark:text-gray-200">
            {t('emailLabel')}
          </label>
          <Input
            id="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            className="rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus:ring-1 focus:ring-turquoise dark:border-gray-700 dark:text-gray-100"
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="mt-2 w-full">
          {submitting ? t('forgotPasswordSubmitting') : t('forgotPasswordSubmit')}
        </Button>

        <Link href="/log-in" className="text-center text-sm text-charcoal/60 hover:text-charcoal dark:text-gray-400 dark:hover:text-gray-100">
          {t('backToLogIn')}
        </Link>
      </form>
    </Card>
  );
}
