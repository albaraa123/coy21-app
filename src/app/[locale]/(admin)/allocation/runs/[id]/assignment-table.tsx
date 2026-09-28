'use client';

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { confirmAllocationRun, discardAllocationRun } from './actions';
import AssignmentDetail from './assignment-detail';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

export type SessionRef = {
  id: string;
  session_code: string;
  title_en: string;
} | null;

export type Assignment = {
  id: string;
  application_id: string;
  session_id: string;
  time_slot_group_key: string;
  suitability_score: number;
  is_low_confidence: boolean;
  is_mandatory_assignment: boolean;
  is_manual_override: boolean;
  override_reason: string | null;
  status: string;
  sessions: SessionRef;
};

export type Explanation = {
  id: string;
  allocation_assignment_id: string;
  constraint_type: string;
  passed: boolean;
  detail: string;
};

export type Alternative = {
  id: string;
  allocation_assignment_id: string;
  session_id: string;
  suitability_score: number;
  rank: number;
  sessions: SessionRef;
};

export default function AssignmentTable({
  runId,
  runStatus,
  assignments,
  explanations,
  alternatives,
}: {
  runId: string;
  runStatus: string;
  assignments: Assignment[];
  explanations: Explanation[];
  alternatives: Alternative[];
}) {
  const t = useTranslations('allocation.runs.detail');
  const tA = useTranslations('allocation.runs.detail.assignments');
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lowConfidenceOnly, setLowConfidenceOnly] = useState(false);

  const isDraft = runStatus === 'draft';

  async function handleConfirm() {
    setError(null);
    setBusy(true);
    try {
      await confirmAllocationRun(runId);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.confirmFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    setError(null);
    setBusy(true);
    try {
      await discardAllocationRun(runId);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.discardFailed'));
    } finally {
      setBusy(false);
    }
  }

  const visible = lowConfidenceOnly ? assignments.filter((a) => a.is_low_confidence) : assignments;

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handleConfirm} disabled={!isDraft || busy}>{t('confirmRun')}</Button>
        <Button type="button" variant="destructive" onClick={handleDiscard} disabled={!isDraft || busy}>{t('discardRun')}</Button>
        {!isDraft && (
          <span className="text-sm text-charcoal/60 dark:text-gray-400">{t('runNotDraft', { status: runStatus })}</span>
        )}
      </div>

      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{tA('title')}</h2>
      <label className="mb-3 flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
        <input
          type="checkbox"
          checked={lowConfidenceOnly}
          onChange={(e) => setLowConfidenceOnly(e.target.checked)}
          className="h-4 w-4 rounded border-charcoal/30 text-turquoise focus:ring-turquoise dark:border-gray-600"
        />
        {tA('lowConfidenceOnly')}
      </label>

      {visible.length === 0 ? (
        <EmptyState title={tA('emptyTitle')} description={tA('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-assignment list. Desktop (md+): table. Both
              trees render the same `visible` data and must be kept in sync —
              any column added to one must be added to the other. This is the
              densest table in the allocation restyle (potentially hundreds
              of assignment rows), so the mobile card intentionally surfaces
              only the fields an admin needs to triage at a glance
              (application, session, score, flags); the full column set is
              reserved for the desktop table and the per-row detail drawer. */}
          <div className="flex flex-col gap-2 md:hidden">
            {visible.map((a) => (
              <div
                key={a.id}
                className="rounded-lg border border-charcoal/10 bg-warm-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{a.application_id}</p>
                  <Badge variant={a.status === 'confirmed' ? 'changed' : 'pending'}>{a.status}</Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                  {a.sessions ? `${a.sessions.session_code} — ${a.sessions.title_en}` : a.session_id}
                </p>
                <p className="text-sm text-charcoal/70 dark:text-gray-400">
                  {tA('timeSlot')}: {a.time_slot_group_key} · {tA('score')}: {a.suitability_score}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.is_low_confidence && <Badge variant="mandatory">{tA('lowConfidence')}</Badge>}
                  {a.is_mandatory_assignment && <Badge variant="neutral">{tA('mandatory')}</Badge>}
                  {a.is_manual_override && <Badge variant="changed">{tA('override')}</Badge>}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setSelectedId(selectedId === a.id ? null : a.id)}
                  >
                    {selectedId === a.id ? tA('hideDetails') : tA('viewDetails')}
                  </Button>
                </div>
                {selectedId === a.id && (
                  <AssignmentDetail
                    assignment={a}
                    runStatus={runStatus}
                    explanations={explanations.filter((e) => e.allocation_assignment_id === a.id)}
                    alternatives={alternatives.filter((alt) => alt.allocation_assignment_id === a.id)}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('applicationId')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('session')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('timeSlot')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('score')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('lowConfidence')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('mandatory')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('override')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('status')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{tA('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {visible.map((a) => (
                  <Fragment key={a.id}>
                    <tr>
                      <td className="px-4 py-2 text-charcoal dark:text-gray-100">{a.application_id}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                        {a.sessions ? `${a.sessions.session_code} — ${a.sessions.title_en}` : a.session_id}
                      </td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{a.time_slot_group_key}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{a.suitability_score}</td>
                      <td className="px-4 py-2">
                        <Badge variant={a.is_low_confidence ? 'mandatory' : 'neutral'}>
                          {a.is_low_confidence ? tA('yes') : tA('no')}
                        </Badge>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="neutral">{a.is_mandatory_assignment ? tA('yes') : tA('no')}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={a.is_manual_override ? 'changed' : 'neutral'}>
                          {a.is_manual_override ? tA('yes') : tA('no')}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{a.status}</td>
                      <td className="px-4 py-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => setSelectedId(selectedId === a.id ? null : a.id)}
                        >
                          {selectedId === a.id ? tA('hideDetails') : tA('viewDetails')}
                        </Button>
                      </td>
                    </tr>
                    {selectedId === a.id && (
                      <tr>
                        <td colSpan={9} className="bg-warm-white/50 px-4 py-3 dark:bg-gray-900/50">
                          <AssignmentDetail
                            assignment={a}
                            runStatus={runStatus}
                            explanations={explanations.filter((e) => e.allocation_assignment_id === a.id)}
                            alternatives={alternatives.filter((alt) => alt.allocation_assignment_id === a.id)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
