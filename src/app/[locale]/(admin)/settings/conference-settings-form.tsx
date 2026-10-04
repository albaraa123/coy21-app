'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { setGlobalBookingDeadline, clearGlobalBookingDeadline } from './actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { isoToConferenceLocalInputValue, conferenceLocalInputValueToIso, formatConferenceDate, formatConferenceTime } from '@/lib/datetime/conference-time';

type Props = {
  globalBookingDeadline: string | null;
  isSuperAdmin: boolean;
};

export default function ConferenceSettingsForm({ globalBookingDeadline, isSuperAdmin }: Props) {
  const t = useTranslations('settings');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const router = useRouter();

  // isoToConferenceLocalInputValue/conferenceLocalInputValueToIso (not a
  // raw toISOString()/slice(0,16) round-trip) are required here, same as
  // session-edit-form.tsx's startTime/endTime/checkin fields -- a
  // datetime-local input has no timezone of its own, so a plain ISO
  // round-trip would silently reinterpret the stored UTC instant as the
  // *browser's* local time on every unmodified save, shifting it by
  // whatever offset separates the admin's browser from UTC. These
  // helpers instead fix the interpretation to Europe/Istanbul (the
  // conference's own timezone), independent of the browser.
  const [deadlineInput, setDeadlineInput] = useState(
    globalBookingDeadline ? isoToConferenceLocalInputValue(globalBookingDeadline) : ''
  );
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submitting = saving || clearing;

  function clearMessages() {
    setError(null);
    setSuccess(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    clearMessages();
    setSaving(true);
    try {
      const deadlineIso = conferenceLocalInputValueToIso(deadlineInput);
      const result = await setGlobalBookingDeadline(deadlineIso);
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(t('globalDeadlineSaved'));
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('globalDeadlineSaveError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    clearMessages();
    setClearing(true);
    try {
      const result = await clearGlobalBookingDeadline();
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(t('globalDeadlineCleared'));
        setDeadlineInput('');
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('globalDeadlineClearError'));
    } finally {
      setClearing(false);
    }
  }

  const inputClass = 'rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none w-full dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';
  const labelClass = 'flex flex-col gap-1 text-sm font-medium text-charcoal dark:text-gray-100';

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="rounded-md border border-green-700 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-400 dark:bg-green-950/40 dark:text-green-300">
          {success}
        </p>
      )}

      <div className="rounded-lg border border-charcoal/10 bg-warm-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('globalDeadlineTitle')}</h2>
            <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">{t('globalDeadlineDescription')}</p>
          </div>
          <Badge variant={globalBookingDeadline ? 'changed' : 'neutral'}>
            {globalBookingDeadline ? t('globalDeadlineSet') : t('globalDeadlineNotSet')}
          </Badge>
        </div>

        {isSuperAdmin ? (
          <form onSubmit={handleSave} className="mt-4 flex flex-col gap-4 md:max-w-md">
            <label className={labelClass}>
              {t('globalDeadlineLabel')}
              <input
                type="datetime-local"
                value={deadlineInput}
                onChange={(e) => setDeadlineInput(e.target.value)}
                required
                className={inputClass}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={submitting || deadlineInput.length === 0}>
                {t('globalDeadlineSaveButton')}
              </Button>
              {globalBookingDeadline && (
                <Button type="button" size="sm" variant="destructive" disabled={submitting} onClick={handleClear}>
                  {t('globalDeadlineClearButton')}
                </Button>
              )}
            </div>
          </form>
        ) : (
          <p className="mt-4 text-sm text-charcoal dark:text-gray-100">
            {globalBookingDeadline
              ? `${formatConferenceDate(globalBookingDeadline, locale)} ${formatConferenceTime(globalBookingDeadline, locale)}`
              : t('globalDeadlineNotSet')}
          </p>
        )}
      </div>
    </div>
  );
}
