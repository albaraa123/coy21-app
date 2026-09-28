'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { searchParticipantsForCare, fetchHealthInfo, updateHealthInfo, type ParticipantSearchResult, type HealthInfo, type HealthInfoUpdateInput } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  submitted: 'pending',
  under_review: 'pending',
  accepted: 'changed',
  waitlisted: 'mandatory',
  rejected: 'cancelled',
  withdrawn: 'neutral',
  draft: 'neutral',
};

const EMPTY_FORM: HealthInfoUpdateInput = {
  allergies: '',
  medical_conditions: '',
  emergency_medication: '',
  accessibility_requirements: '',
  dietary_requirements: '',
  accommodation_preference: '',
  cultural_or_religious_requirements: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  emergency_contact_relationship: '',
  consent_given: null,
};

function toFormState(info: HealthInfo | null): HealthInfoUpdateInput {
  if (!info) return { ...EMPTY_FORM };
  return {
    allergies: info.allergies ?? '',
    medical_conditions: info.medical_conditions ?? '',
    emergency_medication: info.emergency_medication ?? '',
    accessibility_requirements: info.accessibility_requirements ?? '',
    dietary_requirements: info.dietary_requirements ?? '',
    accommodation_preference: info.accommodation_preference ?? '',
    cultural_or_religious_requirements: info.cultural_or_religious_requirements ?? '',
    emergency_contact_name: info.emergency_contact_name ?? '',
    emergency_contact_phone: info.emergency_contact_phone ?? '',
    emergency_contact_relationship: info.emergency_contact_relationship ?? '',
    consent_given: info.consent_given,
  };
}

// Empty-string free-text fields are normalized to null before saving — an
// intentionally cleared field should read back as "no data" (matching
// fetchHealthInfoForCaller's null-row semantics for a participant with no
// data yet), not as a stored empty string.
function toUpdateInput(form: HealthInfoUpdateInput): HealthInfoUpdateInput {
  const normalize = (v: string | null) => (v && v.trim() !== '' ? v : null);
  return {
    allergies: normalize(form.allergies),
    medical_conditions: normalize(form.medical_conditions),
    emergency_medication: normalize(form.emergency_medication),
    accessibility_requirements: normalize(form.accessibility_requirements),
    dietary_requirements: normalize(form.dietary_requirements),
    accommodation_preference: normalize(form.accommodation_preference),
    cultural_or_religious_requirements: normalize(form.cultural_or_religious_requirements),
    emergency_contact_name: normalize(form.emergency_contact_name),
    emergency_contact_phone: normalize(form.emergency_contact_phone),
    emergency_contact_relationship: normalize(form.emergency_contact_relationship),
    consent_given: form.consent_given,
  };
}

const TEXT_FIELDS: { key: keyof Omit<HealthInfoUpdateInput, 'consent_given'>; labelKey: string; multiline?: boolean }[] = [
  { key: 'allergies', labelKey: 'allergies', multiline: true },
  { key: 'medical_conditions', labelKey: 'medicalConditions', multiline: true },
  { key: 'emergency_medication', labelKey: 'emergencyMedication', multiline: true },
  { key: 'accessibility_requirements', labelKey: 'accessibilityRequirements', multiline: true },
  { key: 'dietary_requirements', labelKey: 'dietaryRequirements', multiline: true },
  { key: 'accommodation_preference', labelKey: 'accommodationPreference', multiline: true },
  { key: 'cultural_or_religious_requirements', labelKey: 'culturalOrReligiousRequirements', multiline: true },
  { key: 'emergency_contact_name', labelKey: 'emergencyContactName' },
  { key: 'emergency_contact_phone', labelKey: 'emergencyContactPhone' },
  { key: 'emergency_contact_relationship', labelKey: 'emergencyContactRelationship' },
];

export default function ParticipantCareConsole() {
  const t = useTranslations('participantCare');
  const locale = useLocale();

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<ParticipantSearchResult[]>([]);
  const [searched, setSearched] = useState(false);

  const [selected, setSelected] = useState<ParticipantSearchResult | null>(null);
  const [info, setInfo] = useState<HealthInfo | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<HealthInfoUpdateInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearchError(null);
    setSearching(true);
    try {
      const found = await searchParticipantsForCare(query);
      setResults(found);
      setSearched(true);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : t('searchError'));
    } finally {
      setSearching(false);
    }
  }

  async function loadDetail(participant: ParticipantSearchResult) {
    setSelected(participant);
    setEditing(false);
    setSaveError(null);
    setSaveSuccess(false);
    setDetailError(null);
    setLoadingDetail(true);
    try {
      const data = await fetchHealthInfo(participant.id);
      setInfo(data);
      setForm(toFormState(data));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : t('detailError'));
    } finally {
      setLoadingDetail(false);
    }
  }

  function startEdit() {
    setEditing(true);
    setSaveError(null);
    setSaveSuccess(false);
    setForm(toFormState(info));
  }

  function cancelEdit() {
    setEditing(false);
    setSaveError(null);
    setForm(toFormState(info));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSaveError(null);
    setSaving(true);
    try {
      const saved = await updateHealthInfo(selected.id, toUpdateInput(form));
      setInfo(saved);
      setForm(toFormState(saved));
      setEditing(false);
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  function fieldValue(key: keyof Omit<HealthInfoUpdateInput, 'consent_given'>): string {
    if (!info) return '';
    return (info[key] as string | null) ?? '';
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 min-w-[240px] flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('searchLabel')}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <Button type="submit" disabled={searching}>
          {t('searchAction')}
        </Button>
      </form>

      {searchError && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {searchError}
        </p>
      )}

      {searched && results.length === 0 && !searchError && <EmptyState title={t('noResultsTitle')} description={t('noResultsDescription')} />}

      {results.length > 0 && (
        <div className="flex flex-col gap-2">
          {results.map((p) => (
            <Card key={p.id} className={selected?.id === p.id ? 'ring-2 ring-turquoise' : ''}>
              <button type="button" onClick={() => loadDetail(p)} className="w-full text-start">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-turquoise">{p.application_number ?? p.id}</span>
                  <Badge variant={STATUS_BADGE_VARIANT[p.status] ?? 'neutral'}>{p.status}</Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal dark:text-gray-100">{p.full_name ?? t('unknownName')}</p>
                <p className="text-xs text-charcoal/60 dark:text-gray-400">{p.email ?? t('unknownEmail')}</p>
              </button>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">
              {selected.full_name ?? t('unknownName')} — {selected.application_number ?? selected.id}
            </h2>
            <p className="text-xs text-charcoal/60 dark:text-gray-400">{selected.email ?? t('unknownEmail')}</p>
          </div>

          {detailError && (
            <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
              {detailError}
            </p>
          )}

          {saveSuccess && (
            <p role="status" className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-300">
              {t('saveSuccess')}
            </p>
          )}

          {loadingDetail ? (
            <p className="text-sm text-charcoal/60 dark:text-gray-400">{t('loading')}</p>
          ) : editing ? (
            <form onSubmit={handleSave} className="flex flex-col gap-3">
              {TEXT_FIELDS.map(({ key, labelKey, multiline }) => (
                <label key={key} className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
                  {t(labelKey)}
                  {multiline ? (
                    <textarea
                      value={form[key] ?? ''}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      rows={2}
                      className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    />
                  ) : (
                    <input
                      type="text"
                      value={form[key] ?? ''}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    />
                  )}
                </label>
              ))}

              <label className="flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
                <input
                  type="checkbox"
                  checked={form.consent_given ?? false}
                  onChange={(e) => setForm({ ...form, consent_given: e.target.checked })}
                />
                {t('consentGiven')}
              </label>

              {saveError && (
                <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
                  {saveError}
                </p>
              )}

              <div className="mt-1 flex flex-wrap gap-2">
                <Button type="submit" disabled={saving}>
                  {t('save')}
                </Button>
                <Button type="button" variant="secondary" onClick={cancelEdit}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {TEXT_FIELDS.map(({ key, labelKey }) => (
                  <div key={key}>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t(labelKey)}</dt>
                    <dd className="text-sm text-charcoal dark:text-gray-100">{fieldValue(key) || t('notProvided')}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('consentGiven')}</dt>
                  <dd className="text-sm text-charcoal dark:text-gray-100">{info?.consent_given ? t('yes') : t('no')}</dd>
                </div>
              </dl>
              {info && (
                <p className="text-xs text-charcoal/60 dark:text-gray-400">
                  {t('lastUpdated')}: {new Date(info.updated_at).toLocaleString(locale)}
                </p>
              )}
              {!info && <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noDataYet')}</p>}
              <div>
                <Button size="sm" onClick={startEdit}>
                  {t('editAction')}
                </Button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
