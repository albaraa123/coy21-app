'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import PhoneInput from 'react-phone-number-input';
import 'react-phone-number-input/style.css';
import { updateGuardianInfo } from '../care/actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function GuardianControls({
  applicationId,
  guardianName,
  guardianPhone,
}: {
  applicationId: string;
  guardianName: string | null;
  guardianPhone: string | null;
}) {
  const t = useTranslations('participants.guardian');
  const [name, setName] = useState(guardianName ?? '');
  const [phone, setPhone] = useState(guardianPhone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await updateGuardianInfo(applicationId, {
        guardian_name: name.trim() === '' ? null : name.trim(),
        guardian_phone: phone.trim() === '' ? null : phone.trim(),
      });
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <Card className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{t('name')}</label>
            <input
              className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{t('phone')}</label>
            <PhoneInput
              international
              countryCallingCodeEditable={false}
              defaultCountry="TR"
              value={phone}
              disabled={busy}
              onChange={(v) => setPhone(v ?? '')}
              className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
            />
          </div>
        </div>
        <div>
          <Button size="sm" disabled={busy} onClick={() => void handleSave()}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </Card>
    </section>
  );
}
