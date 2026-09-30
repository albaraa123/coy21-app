'use client';

// src/app/[locale]/(admin)/participants/accounts/classification-dialog.tsx
//
// Extracted from accounts-table.tsx (Task 6) purely for size — that file is
// already 380+ lines. This is the bulk "change classification" confirmation
// dialog's content: a <select> of the 5 participant_type values with NO
// default selection (this is a bulk SET operation across every selected
// row, not a per-row edit that could sensibly default to "the current
// value" — there isn't a single current value across an arbitrary
// selection), and a confirm button disabled until a type is actually
// chosen, following the same disabled={processing || ...} guard pattern as
// accounts-table.tsx's existing 'reset' action (resetConfirmText !== 'CONFIRM').
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { Database } from '@/types/database';

type ParticipantType = Database['public']['Enums']['participant_type'];

// Order mirrors the enum's DB declaration, same as
// participants/[applicationId]/classification-controls.tsx's PARTICIPANT_TYPES.
const PARTICIPANT_TYPES: ParticipantType[] = ['delegate', 'volunteer', 'knowledge_partner', 'youngo', 'speaker'];

export default function ClassificationDialog({
  selectedCount,
  processing,
  onConfirm,
  onCancel,
}: {
  selectedCount: number;
  processing: boolean;
  onConfirm: (newType: ParticipantType) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('participants.accounts');
  const tTypes = useTranslations('participants.classification');
  // No default selection — a bulk SET operation has no sensible "current
  // value" to preselect across an arbitrary multi-row selection.
  const [selectedType, setSelectedType] = useState<ParticipantType | ''>('');

  return (
    <div role="dialog" className="flex flex-col gap-3 rounded-lg border border-gold bg-gold/10 p-4 dark:border-amber-700 dark:bg-amber-900/20">
      <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('changeClassificationConfirmTitle')}</h2>
      <p className="text-sm text-charcoal dark:text-gray-100">{t('confirmSelected', { count: selectedCount })}</p>

      <div className="flex flex-col gap-1">
        <label htmlFor="bulk-participant-type-select" className="text-sm text-charcoal/70 dark:text-gray-400">
          {t('changeClassificationNewType')}
        </label>
        <select
          id="bulk-participant-type-select"
          value={selectedType}
          disabled={processing}
          onChange={(e) => setSelectedType(e.target.value as ParticipantType)}
          className="w-full max-w-xs rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="" disabled>
            {t('changeClassificationSelectPlaceholder')}
          </option>
          {PARTICIPANT_TYPES.map((type) => (
            <option key={type} value={type}>
              {tTypes(`types.${type}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={processing || selectedType === ''}
          onClick={() => selectedType !== '' && onConfirm(selectedType)}
        >
          {processing ? t('processing') : t('confirmButton')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={processing} onClick={onCancel}>
          {t('cancelButton')}
        </Button>
      </div>
    </div>
  );
}
