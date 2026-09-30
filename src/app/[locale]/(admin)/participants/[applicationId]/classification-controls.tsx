'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { updateParticipantTypeAction } from './actions';
import { issueQrForApplicationAction } from './qr-actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Database } from '@/types/database';

type ParticipantType = Database['public']['Enums']['participant_type'];

// Order mirrors the enum's DB declaration
// (supabase/migrations — see src/types/database.ts's
// Enums['participant_type'] / Constants.public.Enums.participant_type).
const PARTICIPANT_TYPES: ParticipantType[] = ['delegate', 'volunteer', 'knowledge_partner', 'youngo', 'speaker'];

export default function ClassificationControls({
  applicationId,
  currentParticipantType,
  applicationStatus,
  hasActiveQrCredential,
}: {
  applicationId: string;
  currentParticipantType: string | null;
  applicationStatus: string;
  hasActiveQrCredential: boolean;
}) {
  const t = useTranslations('participants.classification');
  const [selectedType, setSelectedType] = useState<ParticipantType>(
    (currentParticipantType as ParticipantType | null) ?? PARTICIPANT_TYPES[0]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handles two different Server Action error conventions that coexist on
  // this page: updateParticipantTypeAction throws on failure (actions.ts's
  // established pattern), while issueQrForApplicationAction returns
  // { error: string | null } (qr-actions.ts's pattern, matching the plan's
  // spec). Checking for a truthy `error` field on the resolved value — in
  // addition to catching a thrown error — means neither convention can
  // silently succeed in the UI when the underlying action actually failed.
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        setError(String(result.error));
        return;
      }
      // Same convention as invitation-controls.tsx: re-derive page state via
      // a full reload rather than hand-rolling optimistic client state, so
      // the display stays honest with what's actually in the DB (e.g. a
      // regenerated application_number or a newly issued/reissued QR).
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  const canIssueQr = applicationStatus === 'accepted' && !hasActiveQrCredential;

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <Card className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="participant-type-select" className="text-sm text-charcoal/60 dark:text-gray-400">
            {t('participantType')}:
          </label>
          <select
            id="participant-type-select"
            className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
            value={selectedType}
            disabled={busy}
            onChange={(e) => setSelectedType(e.target.value as ParticipantType)}
          >
            {PARTICIPANT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={busy || selectedType === currentParticipantType}
            onClick={() => void run(() => updateParticipantTypeAction(applicationId, selectedType))}
          >
            {busy ? t('saving') : t('save')}
          </Button>
        </div>

        {canIssueQr && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void run(() => issueQrForApplicationAction(applicationId))}
            >
              {busy ? t('issuingQr') : t('issueQr')}
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}
