'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { updateSandboxRecipient, enableSandboxMode, disableSandboxMode } from './actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const DISABLE_CONFIRMATION_PHRASE = 'DISABLE';

type Props = {
  sandboxEnabled: boolean;
  sandboxRecipientEmail: string | null;
  isSuperAdmin: boolean;
};

export default function SettingsForm({ sandboxEnabled, sandboxRecipientEmail, isSuperAdmin }: Props) {
  const t = useTranslations('settings');
  const router = useRouter();

  const [recipientInput, setRecipientInput] = useState(sandboxRecipientEmail ?? '');
  const [confirmText, setConfirmText] = useState('');
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [savingRecipient, setSavingRecipient] = useState(false);
  const [togglingSandbox, setTogglingSandbox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submitting = savingRecipient || togglingSandbox;

  function clearMessages() {
    setError(null);
    setSuccess(null);
  }

  async function handleSaveRecipient(e: React.FormEvent) {
    e.preventDefault();
    clearMessages();
    setSavingRecipient(true);
    try {
      const result = await updateSandboxRecipient(recipientInput);
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(t('recipientSaved'));
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('recipientSaveError'));
    } finally {
      setSavingRecipient(false);
    }
  }

  async function handleEnable() {
    clearMessages();
    setTogglingSandbox(true);
    try {
      const result = await enableSandboxMode();
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(t('sandboxEnabled'));
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('toggleError'));
    } finally {
      setTogglingSandbox(false);
    }
  }

  async function handleDisable() {
    clearMessages();
    setTogglingSandbox(true);
    try {
      // The client-side DISABLE_CONFIRMATION_PHRASE check below only
      // disables the button — it is a UX guard, not a security boundary.
      // The raw confirmText is passed through unchanged so the server
      // action (disableSandboxMode) re-validates it itself; that
      // server-side check remains the real gate.
      const result = await disableSandboxMode(confirmText);
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(t('sandboxDisabled'));
        setShowDisableConfirm(false);
        setConfirmText('');
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('toggleError'));
    } finally {
      setTogglingSandbox(false);
    }
  }

  function cancelDisable() {
    setShowDisableConfirm(false);
    setConfirmText('');
  }

  const inputClass = 'rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal focus:border-turquoise focus:outline-none w-full dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';
  const labelClass = 'flex flex-col gap-1 text-sm font-medium text-charcoal dark:text-gray-100';

  const confirmMatches = confirmText === DISABLE_CONFIRMATION_PHRASE;

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

      {/* Current status */}
      <div className="rounded-lg border border-charcoal/10 bg-warm-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('sandboxModeTitle')}</h2>
            <p className="mt-1 text-sm text-charcoal/60 dark:text-gray-400">{t('sandboxModeDescription')}</p>
          </div>
          <Badge variant={sandboxEnabled ? 'changed' : 'neutral'}>
            {sandboxEnabled ? t('statusEnabled') : t('statusDisabled')}
          </Badge>
        </div>

        {isSuperAdmin && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {!sandboxEnabled && (
              <Button size="sm" disabled={submitting} onClick={handleEnable}>
                {t('enableButton')}
              </Button>
            )}
            {sandboxEnabled && !showDisableConfirm && (
              <Button size="sm" variant="destructive" disabled={submitting} onClick={() => setShowDisableConfirm(true)}>
                {t('disableButton')}
              </Button>
            )}
            {sandboxEnabled && showDisableConfirm && (
              <div className="flex w-full flex-col gap-2 rounded-md border border-red-700/40 bg-red-50 p-3 dark:border-red-400/40 dark:bg-red-950/20">
                <label className="flex flex-col gap-1 text-sm text-red-700 dark:text-red-300">
                  {t('disableConfirmPrompt')}
                  <input
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={DISABLE_CONFIRMATION_PHRASE}
                    className="rounded-md border border-red-700/40 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-red-700 focus:outline-none dark:border-red-400/40 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" disabled={submitting || !confirmMatches} onClick={handleDisable}>
                    {t('disableConfirmButton')}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={submitting} onClick={cancelDisable}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sandbox recipient */}
      <div className="rounded-lg border border-charcoal/10 bg-warm-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="mb-1 text-sm font-semibold text-charcoal dark:text-gray-100">{t('recipientTitle')}</h2>
        <p className="mb-4 text-sm text-charcoal/60 dark:text-gray-400">{t('recipientDescription')}</p>

        {isSuperAdmin ? (
          <form onSubmit={handleSaveRecipient} className="flex flex-col gap-4 md:max-w-md">
            <label className={labelClass}>
              {t('recipientLabel')}
              <input
                type="email"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                required
                placeholder="ops@example.com"
                className={inputClass}
              />
            </label>
            <div>
              <Button type="submit" size="sm" disabled={submitting}>
                {t('recipientSaveButton')}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-charcoal dark:text-gray-100">
            {sandboxRecipientEmail || t('recipientNotSet')}
          </p>
        )}
      </div>
    </div>
  );
}
