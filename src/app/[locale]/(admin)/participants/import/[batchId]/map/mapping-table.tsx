'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { MAPPING_CONFIDENCE_THRESHOLD } from '@/lib/validation/import';
import { Button } from '@/components/ui/button';
import { confirmMapping } from './actions';

export type Suggestion = {
  sourceColumnIndex: number;
  sourceColumnHeader: string;
  suggestedKind: 'core_field' | 'known_answer' | 'generic_answer' | 'travel_field' | 'health_field';
  suggestedKey: string | null;
  confidence: number;
  requiresReview: boolean;
};

export type MappingSuggestionsResult = {
  headers: string[];
  headerSignature: string;
  suggestions: Suggestion[];
  matchingTemplate: { id: string; name: string; mappings: unknown } | null;
};

type TargetKind = 'core_field' | 'known_answer' | 'generic_answer' | 'ignored' | 'travel_field' | 'health_field';

// Phase B (design doc section 13.9): visual grouping only — computed
// client-side from each row's current targetKind, no server round-trip.
// travel_field/health_field always group under their own restricted
// sections regardless of confidence; everything else falls back to
// "application" (unmapped/generic rows included) until the admin picks a
// more specific kind.
type MappingSection = 'profile' | 'application' | 'travel' | 'health' | 'unmapped';
const PROFILE_CORE_KEYS = new Set([
  'full_name', 'email', 'phone', 'whatsapp_number', 'country', 'nationality', 'city', 'gender',
  'birth_date', 'age_group', 'education_level', 'institution_or_workplace', 'field_of_work',
  'preferred_language', 'linkedin_url', 'primary_track', 'secondary_track',
]);
function sectionForRow(row: { targetKind: TargetKind; targetKey: string }): MappingSection {
  if (row.targetKind === 'travel_field') return 'travel';
  if (row.targetKind === 'health_field') return 'health';
  if (row.targetKind === 'ignored') return 'unmapped';
  if (row.targetKind === 'core_field' && PROFILE_CORE_KEYS.has(row.targetKey)) return 'profile';
  if (row.targetKey.trim() === '') return 'unmapped';
  return 'application';
}

type RowState = {
  sourceColumnIndex: number;
  sourceColumnHeader: string;
  targetKind: TargetKind;
  targetKey: string;
  isManualOverride: boolean;
  confidence: number;
  requiresReview: boolean;
};

// Narrow, defensive shape-check for a template's stored `mappings` jsonb blob
// — templates are user-created data read back from the database, not
// something this code fully controls the shape of, so validate before
// trusting it to drive state.
type TemplateMappingEntry = {
  sourceColumnIndex: number;
  targetKind: TargetKind;
  targetKey: string | null;
  isManualOverride?: boolean;
};

function isTemplateMappingEntry(value: unknown): value is TemplateMappingEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sourceColumnIndex === 'number' &&
    typeof v.targetKind === 'string' &&
    ['core_field', 'known_answer', 'generic_answer', 'ignored', 'travel_field', 'health_field'].includes(v.targetKind) &&
    (v.targetKey === null || typeof v.targetKey === 'string')
  );
}

export default function MappingTable({ batchId, initialData }: { batchId: string; initialData: MappingSuggestionsResult }) {
  const t = useTranslations('participants.import.map');
  const router = useRouter();
  const [rows, setRows] = useState<RowState[]>(() =>
    initialData.suggestions.map((s) => ({
      sourceColumnIndex: s.sourceColumnIndex,
      sourceColumnHeader: s.sourceColumnHeader,
      targetKind: s.suggestedKind,
      targetKey: s.suggestedKey ?? '',
      isManualOverride: false,
      confidence: s.confidence,
      requiresReview: s.requiresReview,
    }))
  );
  const [uniqueIdentifierColumnIndex, setUniqueIdentifierColumnIndex] = useState<number | null>(null);
  const [saveAsTemplateName, setSaveAsTemplateName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [templateApplied, setTemplateApplied] = useState(false);

  function updateRow(index: number, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch, isManualOverride: true } : r)));
  }

  // Explicit, user-initiated action only — a matching template is never
  // auto-applied on page load, only surfaced as a banner with this button.
  function applyTemplate() {
    const templateMappings = initialData.matchingTemplate?.mappings;
    if (!Array.isArray(templateMappings)) return;
    setRows((prev) =>
      prev.map((r) => {
        const match = templateMappings.find((m): m is TemplateMappingEntry => isTemplateMappingEntry(m) && m.sourceColumnIndex === r.sourceColumnIndex);
        if (!match) return r;
        return {
          ...r,
          targetKind: match.targetKind,
          targetKey: match.targetKey ?? '',
          isManualOverride: true,
        };
      })
    );
    setTemplateApplied(true);
  }

  async function handleSubmit() {
    setError(null);
    if (uniqueIdentifierColumnIndex === null) {
      setError(t('selectUniqueIdentifierError'));
      return;
    }
    setSubmitting(true);
    try {
      await confirmMapping({
        batchId,
        mappings: rows.map((r) => ({
          sourceColumnIndex: r.sourceColumnIndex,
          targetKind: r.targetKind,
          targetKey: r.targetKind === 'ignored' ? null : r.targetKey.trim() === '' ? null : r.targetKey.trim(),
          isManualOverride: r.isManualOverride,
        })),
        uniqueIdentifierColumnIndex,
        saveAsTemplateName: saveAsTemplateName.trim() === '' ? undefined : saveAsTemplateName.trim(),
      });
      router.push(`/participants/import/${batchId}/preview`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {initialData.matchingTemplate && !templateApplied && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gold bg-gold/10 p-4 dark:border-amber-700 dark:bg-amber-900/20">
          <p className="text-sm text-charcoal dark:text-gray-100">
            {t('templateMatch', { name: initialData.matchingTemplate.name })}
          </p>
          <Button type="button" size="sm" variant="secondary" onClick={applyTemplate}>
            {t('useTemplate')}
          </Button>
        </div>
      )}

      {/* Mobile: card-per-column list. Desktop (md+): table. Both trees
          render the same `rows` state and must be kept in sync — any
          field/control added to one must be added to the other. */}
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((row, index) => (
          <div
            key={row.sourceColumnIndex}
            className={`rounded-lg border p-4 ${
              row.requiresReview
                ? 'border-gold bg-gold/10 dark:border-amber-700 dark:bg-amber-900/20'
                : 'border-charcoal/10 bg-warm-white dark:border-gray-700 dark:bg-gray-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                {row.sourceColumnHeader || <em>{t('blank')}</em>}
              </p>
              {(row.targetKind === 'travel_field' || row.targetKind === 'health_field') && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
                  {t('restrictedBadge')}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-col gap-2">
              <label className="text-xs font-medium text-charcoal/60 dark:text-gray-400">
                {t('targetKind')}
                <select
                  value={row.targetKind}
                  onChange={(e) => updateRow(index, { targetKind: e.target.value as TargetKind })}
                  className="mt-1 block w-full rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="core_field">{t('kindCoreField')}</option>
                  <option value="known_answer">{t('kindKnownAnswer')}</option>
                  <option value="generic_answer">{t('kindGenericAnswer')}</option>
                  <option value="travel_field">{t('kindTravelField')}</option>
                  <option value="health_field">{t('kindHealthField')}</option>
                  <option value="ignored">{t('kindIgnored')}</option>
                </select>
              </label>
              {row.targetKind !== 'ignored' && (
                <label className="text-xs font-medium text-charcoal/60 dark:text-gray-400">
                  {t('targetKey')}
                  <input
                    type="text"
                    value={row.targetKey}
                    onChange={(e) => updateRow(index, { targetKey: e.target.value })}
                    placeholder={t('targetKeyPlaceholder')}
                    className="mt-1 block w-full rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                  />
                </label>
              )}
              <p className="text-xs text-charcoal/70 dark:text-gray-400">
                {t('confidence')}: {Math.round(row.confidence * 100)}%
                {row.requiresReview && <strong className="text-charcoal dark:text-gray-100"> {t('needsReview')}</strong>}
                {row.confidence > 0 && row.confidence < MAPPING_CONFIDENCE_THRESHOLD && ` ${t('lowConfidence')}`}
              </p>
              <label className="flex items-center gap-2 text-xs font-medium text-charcoal/60 dark:text-gray-400">
                <input
                  type="radio"
                  name="unique-identifier-mobile"
                  checked={uniqueIdentifierColumnIndex === row.sourceColumnIndex}
                  onChange={() => setUniqueIdentifierColumnIndex(row.sourceColumnIndex)}
                />
                {t('uniqueIdentifier')}
              </label>
            </div>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
        <table className="w-full text-start text-sm">
          <thead>
            <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('column')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('targetKind')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('targetKey')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('confidence')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('uniqueIdentifier')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {rows.map((row, index) => {
              const section = sectionForRow(row);
              const previousSection = index > 0 ? sectionForRow(rows[index - 1]) : null;
              const sectionLabel: Record<MappingSection, string> = {
                profile: t('sectionProfile'),
                application: t('sectionApplication'),
                travel: t('sectionTravel'),
                health: t('sectionHealth'),
                unmapped: t('sectionUnmapped'),
              };
              return (
                <>
                  {section !== previousSection && (
                    <tr key={`section-${section}-${row.sourceColumnIndex}`} className="bg-charcoal/5 dark:bg-gray-800">
                      <td colSpan={5} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">
                        {sectionLabel[section]}
                      </td>
                    </tr>
                  )}
                  <tr
                    key={row.sourceColumnIndex}
                    className={row.requiresReview ? 'bg-gold/10 dark:bg-amber-900/20' : undefined}
                  >
                <td className="px-4 py-2 text-charcoal dark:text-gray-100">
                  <div className="flex items-center gap-2">
                    {row.sourceColumnHeader || <em>{t('blank')}</em>}
                    {(row.targetKind === 'travel_field' || row.targetKind === 'health_field') && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
                        {t('restrictedBadge')}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <select
                    value={row.targetKind}
                    onChange={(e) => updateRow(index, { targetKind: e.target.value as TargetKind })}
                    className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  >
                    <option value="core_field">{t('kindCoreField')}</option>
                    <option value="known_answer">{t('kindKnownAnswer')}</option>
                    <option value="generic_answer">{t('kindGenericAnswer')}</option>
                    <option value="travel_field">{t('kindTravelField')}</option>
                    <option value="health_field">{t('kindHealthField')}</option>
                    <option value="ignored">{t('kindIgnored')}</option>
                  </select>
                </td>
                <td className="px-4 py-2">
                  {row.targetKind !== 'ignored' && (
                    <input
                      type="text"
                      value={row.targetKey}
                      onChange={(e) => updateRow(index, { targetKey: e.target.value })}
                      placeholder={t('targetKeyPlaceholder')}
                      className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal placeholder:text-charcoal/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                    />
                  )}
                </td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                  {Math.round(row.confidence * 100)}%
                  {row.requiresReview && <strong className="text-charcoal dark:text-gray-100"> {t('needsReview')}</strong>}
                  {row.confidence > 0 && row.confidence < MAPPING_CONFIDENCE_THRESHOLD && ` ${t('lowConfidence')}`}
                </td>
                <td className="px-4 py-2">
                  <input
                    type="radio"
                    name="unique-identifier"
                    checked={uniqueIdentifierColumnIndex === row.sourceColumnIndex}
                    onChange={() => setUniqueIdentifierColumnIndex(row.sourceColumnIndex)}
                  />
                </td>
                  </tr>
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <label className="text-sm text-charcoal/70 dark:text-gray-400">
          {t('saveTemplateLabel')}{' '}
          <input
            type="text"
            value={saveAsTemplateName}
            onChange={(e) => setSaveAsTemplateName(e.target.value)}
            placeholder={t('templateNamePlaceholder')}
            className="mt-1 block w-full max-w-sm rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </label>
      </div>

      <div>
        <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? t('saving') : t('continue')}
        </Button>
      </div>
    </div>
  );
}
