'use client';

// src/app/[locale]/(admin)/attendance/walk-in/walk-in-admission-form.tsx
//
// Task 7 — the standalone walk-in admission form: a session <select>, a
// text input for the applicant's application number or name (resolved to
// an application_id server-side by actions.ts's admitWalkIn), and an
// Admit button. Deliberately no autocomplete/search-as-you-type UI per the
// design spec's "minimal standalone admin page" framing (scope decision
// 13) — admission-management-console.tsx's two-step search-then-select
// flow is the richer precedent this page intentionally does not replicate.
// Error/success presentation mirrors that console's own established
// pattern: a role="alert"/role="status" banner showing the action's error
// or success text verbatim.
import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { admitWalkIn } from './actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Session = { id: string; title_ar: string; title_en: string; status: string; start_time: string; end_time: string };

export default function WalkInAdmissionForm({ sessions }: { sessions: Session[] }) {
  const t = useTranslations('walkInAdmission');
  const locale = useLocale();

  const [sessionId, setSessionId] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!sessionId) {
      setError(t('sessionRequiredError'));
      return;
    }
    if (identifier.trim() === '') {
      setError(t('identifierRequiredError'));
      return;
    }

    setSubmitting(true);
    try {
      const result = await admitWalkIn(identifier, sessionId);
      if ('error' in result) {
        setError(result.error);
      } else {
        setSuccess(t('admitSuccess'));
        setIdentifier('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admitError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="flex max-w-xl flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('session')}
          <select
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            required
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('selectSession')}</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {locale === 'ar' ? s.title_ar : s.title_en}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('identifierLabel')}
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t('identifierPlaceholder')}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        {success && (
          <p role="status" className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-300">
            {success}
          </p>
        )}

        <div>
          <Button type="submit" disabled={submitting}>
            {t('admitAction')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
