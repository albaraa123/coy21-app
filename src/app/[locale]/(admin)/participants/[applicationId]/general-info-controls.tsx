// src/app/[locale]/(admin)/participants/[applicationId]/general-info-controls.tsx
//
// Mirrors guardian-controls.tsx's shape (local form state, single
// busy/error, one Save button calling one server action), scaled to
// the design spec's 31-column scope. Array fields are edited as
// comma-separated text via general-info-array-field.ts's helpers.
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { updateGeneralInfoAction, type GeneralInfoUpdateInput } from './actions';
import { arrayFieldToInput, inputToArrayField } from '@/lib/participants/general-info-array-field';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type GeneralInfoValues = {
  full_name: string | null;
  phone: string | null;
  whatsapp_number: string | null;
  country: string | null;
  nationality: string | null;
  city: string | null;
  gender: string | null;
  birth_date: string | null;
  age_group: string | null;
  education_level: string | null;
  institution_or_workplace: string | null;
  field_of_work: string | null;
  organization: string | null;
  preferred_language: string | null;
  linkedin_url: string | null;
  primary_track: string | null;
  secondary_track: string | null;
  topics_to_learn: string | null;
  content_type_pref: string | null;
  experience_level: string | null;
  climate_experience: string | null;
  past_initiatives: string | null;
  participation_goals: string | null;
  priority_sessions: string | null;
  special_needs: string | null;
  interests: string[] | null;
  track_interests: string[] | null;
  session_languages: string[] | null;
  track_1_focus_areas: string[] | null;
  track_2_focus_areas: string[] | null;
  track_3_focus_areas: string[] | null;
};

const TEXT_FIELD_KEYS = [
  'full_name', 'phone', 'whatsapp_number', 'country', 'nationality', 'city', 'gender',
  'birth_date', 'age_group', 'education_level', 'institution_or_workplace', 'field_of_work',
  'organization', 'preferred_language', 'linkedin_url', 'primary_track', 'secondary_track',
  'topics_to_learn', 'content_type_pref', 'experience_level', 'climate_experience',
  'past_initiatives', 'participation_goals', 'priority_sessions', 'special_needs',
] as const;

const ARRAY_FIELD_KEYS = [
  'interests', 'track_interests', 'session_languages',
  'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
] as const;

// camelCase i18n key per snake_case field key, e.g. full_name -> fullName.
// Verified against src/messages/en.json's participants.generalInfo.fields
// keys for all 31 field keys, including the digit-in-the-middle case
// (track_1_focus_areas -> track1FocusAreas): the regex produces an exact
// match for every key, so no explicit lookup table is needed here.
function i18nKeyFor(fieldKey: string): string {
  return fieldKey.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export default function GeneralInfoControls({
  applicationId,
  initialValues,
}: {
  applicationId: string;
  initialValues: GeneralInfoValues;
}) {
  const t = useTranslations('participants.generalInfo');
  const [textValues, setTextValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(TEXT_FIELD_KEYS.map((k) => [k, initialValues[k] ?? '']))
  );
  const [arrayInputs, setArrayInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(ARRAY_FIELD_KEYS.map((k) => [k, arrayFieldToInput(initialValues[k])]))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const input: GeneralInfoUpdateInput = {};
      for (const key of TEXT_FIELD_KEYS) {
        const trimmed = textValues[key].trim();
        (input as Record<string, string | null>)[key] = trimmed === '' ? null : trimmed;
      }
      for (const key of ARRAY_FIELD_KEYS) {
        const arr = inputToArrayField(arrayInputs[key]);
        (input as Record<string, string[] | null>)[key] = arr.length === 0 ? null : arr;
      }
      await updateGeneralInfoAction(applicationId, input);
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
          {TEXT_FIELD_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{t(`fields.${i18nKeyFor(key)}`)}</label>
              <Input
                className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
                value={textValues[key]}
                disabled={busy}
                onChange={(e) => setTextValues((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </div>
          ))}
          {ARRAY_FIELD_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-xs font-medium text-charcoal/70 dark:text-gray-400">{t(`fields.${i18nKeyFor(key)}`)}</label>
              <Input
                className="rounded-md border border-charcoal/20 bg-transparent px-2 py-1.5 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100"
                value={arrayInputs[key]}
                disabled={busy}
                onChange={(e) => setArrayInputs((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </div>
          ))}
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
