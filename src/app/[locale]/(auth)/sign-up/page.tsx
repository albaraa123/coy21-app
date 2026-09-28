'use client';

// src/app/[locale]/(auth)/sign-up/page.tsx
//
// Task 7: visual restyle only. The supabase.auth.signUp() call, its
// success/error branches, and the exact neutral-message wording (see the
// comment above the else-branch below, preserved verbatim) are all
// unchanged from the pre-Task-7 version. This page remains dormant behind
// ENABLE_SELF_REGISTRATION at a higher level (see the plan's "Existing
// behavior that must be preserved" note) — no flag check was added or
// removed here, matching the pre-existing file, which also had none at
// this layer.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function SignUpPage() {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });

    if (error) {
      setMessage(error.message);
      return;
    }

    if (data.session) {
      // Email confirmations are disabled on this project; the account is
      // immediately active and signed in.
      setMessage('Account created. You are now signed in.');
    } else {
      // Either a genuine new signup awaiting email confirmation, or the
      // email is already registered (Supabase returns a fake-success
      // response with no error in that case, to prevent user enumeration).
      // We can't reliably distinguish the two from the client, so show a
      // neutral message that covers both without leaking which occurred.
      setMessage(
        'If this email is new, check your inbox to confirm your account. If you already have an account, try logging in instead.'
      );
    }
  }

  return (
    <Card className="border-0 p-0 shadow-none">
      <h1 className="font-serif text-xl font-semibold text-charcoal dark:text-gray-100">{t('signUpTitle')}</h1>
      <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('signUpSubtitle')}</p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="fullName" className="text-sm font-medium text-charcoal dark:text-gray-200">
            {t('fullNameLabel')}
          </label>
          <input
            id="fullName"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus:ring-1 focus:ring-turquoise dark:border-gray-700 dark:text-gray-100"
          />
        </div>

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
            minLength={8}
            className="rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus:ring-1 focus:ring-turquoise dark:border-gray-700 dark:text-gray-100"
          />
        </div>

        {message && <p className="text-sm text-charcoal/80 dark:text-gray-300">{message}</p>}

        <Button type="submit" className="mt-2 w-full">
          {t('signUpSubmit')}
        </Button>
      </form>
    </Card>
  );
}
