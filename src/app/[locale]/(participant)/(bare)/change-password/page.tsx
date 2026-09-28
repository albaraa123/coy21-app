'use client';

// src/app/[locale]/(participant)/(bare)/change-password/page.tsx
//
// Phase C (design doc section 14.9). Reached either by the (shell) layout's
// server-side redirect (must_change_password = true) or navigated to
// directly by an already-changed participant — the latter is harmless (see
// this file's own no-gate-on-entry note below), so no extra check is
// needed here beyond "is someone signed in at all".
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/client';
import { completePasswordChange } from './actions';
import { Button } from '@/components/ui/button';

export default function ChangePasswordPage() {
  const t = useTranslations('changePassword');
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError(t('mismatchError'));
      return;
    }
    if (password === 'password@123') {
      setError(t('sameAsTemporaryError'));
      return;
    }
    setSubmitting(true);
    try {
      const supabase = createClient();
      // The password itself is changed HERE, client-side, exactly like
      // claim/page.tsx's existing (optional) password form — Supabase Auth
      // never exposes a server-side "set this user's password to X" call
      // usable from the user's own session (only auth.admin.updateUserById,
      // a service-role-only operation this page must not use for itself).
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      const result = await completePasswordChange();
      if (!result.success) {
        setError(result.errorMessage);
        return;
      }
      router.push('/my-dashboard');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('description')}</p>
      </div>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder={t('newPasswordPlaceholder')}
          required
          minLength={8}
          className="w-full rounded-md border border-charcoal/20 bg-white px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <input
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          type="password"
          placeholder={t('confirmPasswordPlaceholder')}
          required
          minLength={8}
          className="w-full rounded-md border border-charcoal/20 bg-white px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? t('saving') : t('submitLabel')}
        </Button>
      </form>
    </div>
  );
}
