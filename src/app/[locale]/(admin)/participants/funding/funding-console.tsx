'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  searchParticipantsForFunding,
  searchParticipantsForAttendanceConfirmation,
  updateFundingType,
  updateAttendanceConfirmation,
  fetchAttendanceConfirmationCounts,
  type ParticipantSearchResult,
  type ParticipantCareSearchResult,
  type FundingType,
  type AttendanceConfirmation,
} from './actions';
import { FUNDING_TYPE_VALUES, ATTENDANCE_CONFIRMATION_VALUES } from '@/lib/validation/funding-type';
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

// Either shape carries at minimum id/application_number/status/full_name/
// email/attendance_confirmation — funding_type is only present on the
// full-access shape.
type SearchResult = ParticipantSearchResult | ParticipantCareSearchResult;

function hasFundingType(row: SearchResult): row is ParticipantSearchResult {
  return 'funding_type' in row;
}

export default function FundingConsole({ hasFullAccess }: { hasFullAccess: boolean }) {
  const t = useTranslations('funding');

  const [counts, setCounts] = useState<{ confirmed: number; not_confirmed: number; declined: number } | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);

  useEffect(() => {
    fetchAttendanceConfirmationCounts()
      .then(setCounts)
      .catch((err) => setCountsError(err instanceof Error ? err.message : t('countsError')));
  }, [t]);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);

  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [fundingValue, setFundingValue] = useState<FundingType | ''>('');
  const [attendanceValue, setAttendanceValue] = useState<AttendanceConfirmation>('not_confirmed');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearchError(null);
    setSearching(true);
    try {
      const found = hasFullAccess ? await searchParticipantsForFunding(query) : await searchParticipantsForAttendanceConfirmation(query);
      setResults(found);
      setSearched(true);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : t('searchError'));
    } finally {
      setSearching(false);
    }
  }

  function selectParticipant(participant: SearchResult) {
    setSelected(participant);
    setFundingValue(hasFundingType(participant) ? participant.funding_type ?? '' : '');
    setAttendanceValue(participant.attendance_confirmation);
    setSaveError(null);
    setSaveSuccess(false);
  }

  function refreshCounts() {
    fetchAttendanceConfirmationCounts().then(setCounts).catch(() => {});
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !hasFullAccess) return;
    setSaveError(null);
    setSaveSuccess(false);
    setSaving(true);
    try {
      const [fundingResult, attendanceResult] = await Promise.all([
        updateFundingType(selected.id, fundingValue === '' ? null : fundingValue),
        updateAttendanceConfirmation(selected.id, attendanceValue),
      ]);
      const updated: SearchResult = { ...selected, funding_type: fundingResult.funding_type, attendance_confirmation: attendanceResult.attendance_confirmation } as ParticipantSearchResult;
      setSelected(updated);
      setResults((prev) => prev.map((p) => (p.id === selected.id ? updated : p)));
      setSaveSuccess(true);
      refreshCounts();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('countConfirmed')}</p>
          <p className="mt-1 text-2xl font-semibold text-charcoal dark:text-gray-100">{counts ? counts.confirmed : '—'}</p>
        </Card>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('countNotConfirmed')}</p>
          <p className="mt-1 text-2xl font-semibold text-charcoal dark:text-gray-100">{counts ? counts.not_confirmed : '—'}</p>
        </Card>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('countDeclined')}</p>
          <p className="mt-1 text-2xl font-semibold text-charcoal dark:text-gray-100">{counts ? counts.declined : '—'}</p>
        </Card>
      </div>
      {countsError && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {countsError}
        </p>
      )}

      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
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
              <button type="button" onClick={() => selectParticipant(p)} className="w-full text-start">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-turquoise">{p.application_number ?? p.id}</span>
                  <Badge variant={STATUS_BADGE_VARIANT[p.status] ?? 'neutral'}>{p.status}</Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal dark:text-gray-100">{p.full_name ?? t('unknownName')}</p>
                <p className="text-xs text-charcoal/60 dark:text-gray-400">{p.email ?? t('unknownEmail')}</p>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-charcoal/70 dark:text-gray-400">
                  {hasFundingType(p) && (
                    <span>{t('currentFunding')}: {p.funding_type ? t(`fundingValues.${p.funding_type}`) : t('notSet')}</span>
                  )}
                  <span>{t('currentAttendance')}: {t(`attendanceValues.${p.attendance_confirmation}`)}</span>
                </div>
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

          {saveSuccess && (
            <p role="status" className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-300">
              {t('saveSuccess')}
            </p>
          )}

          {hasFullAccess ? (
            <form onSubmit={handleSave} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
                {t('fundingTypeLabel')}
                <select
                  value={fundingValue}
                  onChange={(e) => setFundingValue(e.target.value as FundingType | '')}
                  className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="">{t('notSet')}</option>
                  {FUNDING_TYPE_VALUES.map((v) => (
                    <option key={v} value={v}>{t(`fundingValues.${v}`)}</option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
                {t('attendanceConfirmationLabel')}
                <select
                  value={attendanceValue}
                  onChange={(e) => setAttendanceValue(e.target.value as AttendanceConfirmation)}
                  className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                >
                  {ATTENDANCE_CONFIRMATION_VALUES.map((v) => (
                    <option key={v} value={v}>{t(`attendanceValues.${v}`)}</option>
                  ))}
                </select>
              </label>

              {saveError && (
                <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
                  {saveError}
                </p>
              )}

              <div className="mt-1">
                <Button type="submit" disabled={saving}>
                  {t('save')}
                </Button>
              </div>
            </form>
          ) : (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('attendanceConfirmationLabel')}</dt>
              <dd className="text-sm text-charcoal dark:text-gray-100">{t(`attendanceValues.${selected.attendance_confirmation}`)}</dd>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
