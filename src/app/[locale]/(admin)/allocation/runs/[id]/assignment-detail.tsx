'use client';

import { useTranslations } from 'next-intl';
import type { Alternative, Assignment, Explanation } from './assignment-table';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import OverrideForm from './override-form';

export default function AssignmentDetail({
  assignment,
  runStatus,
  explanations,
  alternatives,
}: {
  assignment: Assignment;
  runStatus: string;
  explanations: Explanation[];
  alternatives: Alternative[];
}) {
  const t = useTranslations('allocation.runs.detail.assignments');
  const tOverride = useTranslations('allocation.runs.detail.override');

  return (
    <Card className="mt-4">
      <h3 className="text-sm font-semibold text-charcoal dark:text-gray-100">
        {t('detailTitle', { applicationId: assignment.application_id })}
      </h3>
      <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
        {t('assignedSession')}:{' '}
        {assignment.sessions
          ? `${assignment.sessions.session_code} — ${assignment.sessions.title_en}`
          : assignment.session_id}
      </p>
      {assignment.override_reason && (
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
          {t('overrideReason', { reason: assignment.override_reason })}
        </p>
      )}

      <h4 className="mt-4 text-sm font-semibold text-charcoal dark:text-gray-100">{t('explanationsTitle')}</h4>
      {explanations.length === 0 ? (
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('explanationsEmpty')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700">
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('constraintType')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('passed')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('detail')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
              {explanations.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2 text-charcoal dark:text-gray-100">{e.constraint_type}</td>
                  <td className="px-3 py-2">
                    <Badge variant={e.passed ? 'elective' : 'mandatory'}>{e.passed ? t('yes') : t('no')}</Badge>
                  </td>
                  <td className="px-3 py-2 text-charcoal/70 dark:text-gray-400">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 className="mt-4 text-sm font-semibold text-charcoal dark:text-gray-100">{t('alternativesTitle')}</h4>
      {alternatives.length === 0 ? (
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('alternativesEmpty')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700">
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('rank')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('alternativeSession')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('alternativeScore')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
              {alternatives.map((alt) => (
                <tr key={alt.id}>
                  <td className="px-3 py-2 text-charcoal dark:text-gray-100">{alt.rank}</td>
                  <td className="px-3 py-2 text-charcoal/70 dark:text-gray-400">
                    {alt.sessions
                      ? `${alt.sessions.session_code} — ${alt.sessions.title_en}`
                      : alt.session_id}
                  </td>
                  <td className="px-3 py-2 text-charcoal/70 dark:text-gray-400">{alt.suitability_score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 className="mt-4 text-sm font-semibold text-charcoal dark:text-gray-100">{tOverride('title')}</h4>
      {runStatus === 'draft' ? (
        <OverrideForm assignmentId={assignment.id} />
      ) : (
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{tOverride('onlyInDraft')}</p>
      )}
    </Card>
  );
}
