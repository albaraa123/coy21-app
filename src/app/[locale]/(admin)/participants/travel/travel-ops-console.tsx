'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { searchParticipantsForTravel, fetchTravelInfo, updateTravelInfo, type ParticipantSearchResult, type TravelInfo, type TravelInfoUpdateInput } from './actions';
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

const EMPTY_FORM: TravelInfoUpdateInput = {
  support_level_requested: '',
  can_attend_without_full_support: null,
  departure_airport: '',
  visa_required: null,
  invitation_letter_required: null,
  passport_full_name: '',
  passport_full_name_ar: '',
  passport_issue_date: '',
  passport_expiry_date: '',
  passport_place_of_issue: '',
  passport_birth_date: '',
};

function toFormState(info: TravelInfo | null): TravelInfoUpdateInput {
  if (!info) return { ...EMPTY_FORM };
  return {
    support_level_requested: info.support_level_requested ?? '',
    can_attend_without_full_support: info.can_attend_without_full_support,
    departure_airport: info.departure_airport ?? '',
    visa_required: info.visa_required,
    invitation_letter_required: info.invitation_letter_required,
    passport_full_name: info.passport_full_name ?? '',
    passport_full_name_ar: info.passport_full_name_ar ?? '',
    passport_issue_date: info.passport_issue_date ?? '',
    passport_expiry_date: info.passport_expiry_date ?? '',
    passport_place_of_issue: info.passport_place_of_issue ?? '',
    passport_birth_date: info.passport_birth_date ?? '',
  };
}

// Empty-string free-text/date fields normalize to null before saving, same
// reasoning as participant-care-console.tsx's toUpdateInput.
function toUpdateInput(form: TravelInfoUpdateInput): TravelInfoUpdateInput {
  const normalize = (v: string | null) => (v && v.trim() !== '' ? v : null);
  return {
    support_level_requested: normalize(form.support_level_requested),
    can_attend_without_full_support: form.can_attend_without_full_support,
    departure_airport: normalize(form.departure_airport),
    visa_required: form.visa_required,
    invitation_letter_required: form.invitation_letter_required,
    passport_full_name: normalize(form.passport_full_name),
    passport_full_name_ar: normalize(form.passport_full_name_ar),
    passport_issue_date: normalize(form.passport_issue_date),
    passport_expiry_date: normalize(form.passport_expiry_date),
    passport_place_of_issue: normalize(form.passport_place_of_issue),
    passport_birth_date: normalize(form.passport_birth_date),
  };
}

const TEXT_FIELDS: { key: keyof Pick<TravelInfoUpdateInput, 'support_level_requested' | 'departure_airport' | 'passport_full_name' | 'passport_full_name_ar' | 'passport_place_of_issue'>; labelKey: string }[] = [
  { key: 'support_level_requested', labelKey: 'supportLevelRequested' },
  { key: 'departure_airport', labelKey: 'departureAirport' },
  { key: 'passport_full_name', labelKey: 'passportFullName' },
  { key: 'passport_full_name_ar', labelKey: 'passportFullNameAr' },
  { key: 'passport_place_of_issue', labelKey: 'passportPlaceOfIssue' },
];

const DATE_FIELDS: { key: keyof Pick<TravelInfoUpdateInput, 'passport_issue_date' | 'passport_expiry_date' | 'passport_birth_date'>; labelKey: string }[] = [
  { key: 'passport_birth_date', labelKey: 'passportBirthDate' },
  { key: 'passport_issue_date', labelKey: 'passportIssueDate' },
  { key: 'passport_expiry_date', labelKey: 'passportExpiryDate' },
];

const BOOLEAN_FIELDS: { key: keyof Pick<TravelInfoUpdateInput, 'can_attend_without_full_support' | 'visa_required' | 'invitation_letter_required'>; labelKey: string }[] = [
  { key: 'visa_required', labelKey: 'visaRequired' },
  { key: 'invitation_letter_required', labelKey: 'invitationLetterRequired' },
  { key: 'can_attend_without_full_support', labelKey: 'canAttendWithoutFullSupport' },
];

export default function TravelOpsConsole() {
  const t = useTranslations('travelOps');
  const locale = useLocale();

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<ParticipantSearchResult[]>([]);
  const [searched, setSearched] = useState(false);

  const [selected, setSelected] = useState<ParticipantSearchResult | null>(null);
  const [info, setInfo] = useState<TravelInfo | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<TravelInfoUpdateInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearchError(null);
    setSearching(true);
    try {
      const found = await searchParticipantsForTravel(query);
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
      const data = await fetchTravelInfo(participant.id);
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
      const saved = await updateTravelInfo(selected.id, toUpdateInput(form));
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

  function textFieldValue(key: (typeof TEXT_FIELDS)[number]['key']): string {
    if (!info) return '';
    return (info[key] as string | null) ?? '';
  }

  function dateFieldValue(key: (typeof DATE_FIELDS)[number]['key']): string {
    if (!info) return '';
    return (info[key] as string | null) ?? '';
  }

  function booleanFieldLabel(key: (typeof BOOLEAN_FIELDS)[number]['key']): string {
    const value = info?.[key];
    if (value === true) return t('yes');
    if (value === false) return t('no');
    return t('notProvided');
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
              {TEXT_FIELDS.map(({ key, labelKey }) => (
                <label key={key} className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
                  {t(labelKey)}
                  <input
                    type="text"
                    value={form[key] ?? ''}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
              ))}
              {DATE_FIELDS.map(({ key, labelKey }) => (
                <label key={key} className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
                  {t(labelKey)}
                  <input
                    type="date"
                    value={form[key] ?? ''}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
              ))}
              {BOOLEAN_FIELDS.map(({ key, labelKey }) => (
                <label key={key} className="flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
                  <input
                    type="checkbox"
                    checked={form[key] ?? false}
                    onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                  />
                  {t(labelKey)}
                </label>
              ))}

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
                    <dd className="text-sm text-charcoal dark:text-gray-100">{textFieldValue(key) || t('notProvided')}</dd>
                  </div>
                ))}
                {DATE_FIELDS.map(({ key, labelKey }) => (
                  <div key={key}>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t(labelKey)}</dt>
                    <dd className="text-sm text-charcoal dark:text-gray-100">{dateFieldValue(key) || t('notProvided')}</dd>
                  </div>
                ))}
                {BOOLEAN_FIELDS.map(({ key, labelKey }) => (
                  <div key={key}>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t(labelKey)}</dt>
                    <dd className="text-sm text-charcoal dark:text-gray-100">{booleanFieldLabel(key)}</dd>
                  </div>
                ))}
                {/* Read-only: raw Google Drive link text, never editable
                    here — see travel-info-management.ts's own doc comment
                    for why (out-of-scope Drive-to-Storage migration). */}
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('passportCopyUrl')}</dt>
                  <dd className="text-sm text-charcoal dark:text-gray-100">
                    {info?.passport_copy_url ? (
                      <a href={info.passport_copy_url} target="_blank" rel="noopener noreferrer" className="text-turquoise hover:underline break-all">
                        {t('openLink')}
                      </a>
                    ) : (
                      t('notProvided')
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('passportPhotoUrl')}</dt>
                  <dd className="text-sm text-charcoal dark:text-gray-100">
                    {info?.passport_photo_url ? (
                      <a href={info.passport_photo_url} target="_blank" rel="noopener noreferrer" className="text-turquoise hover:underline break-all">
                        {t('openLink')}
                      </a>
                    ) : (
                      t('notProvided')
                    )}
                  </dd>
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
