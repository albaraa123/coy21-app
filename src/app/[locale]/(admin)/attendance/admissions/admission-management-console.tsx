'use client';

import { useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  searchApplicationsForAdmission,
  fetchAttendanceStateForApplication,
  fetchAttendanceAuditLog,
  performAdmitOverride,
  performCorrectAttendance,
  performTransferAttendance,
  type ApplicationSearchResult,
  type AttendanceStateRow,
  type AuditLogRow,
} from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type Session = { id: string; title_ar: string; title_en: string; status: string; start_time: string; end_time: string };

type ActionMode = null | 'override' | 'correct' | 'transfer';

const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  admitted: 'changed',
  rejected: 'cancelled',
  transferred_out: 'neutral',
  corrected: 'pending',
};

export default function AdmissionManagementConsole({ sessions }: { sessions: Session[] }) {
  const t = useTranslations('admissionManagement');
  const locale = useLocale();

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<ApplicationSearchResult[]>([]);
  const [searched, setSearched] = useState(false);

  const [selected, setSelected] = useState<ApplicationSearchResult | null>(null);
  const [attendanceRows, setAttendanceRows] = useState<AttendanceStateRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [mode, setMode] = useState<ActionMode>(null);
  const [actionSessionId, setActionSessionId] = useState('');
  const [actionAttendanceId, setActionAttendanceId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const activeAttendance = useMemo(() => attendanceRows.filter((r) => r.status === 'admitted'), [attendanceRows]);

  function sessionLabel(s: { title_ar: string; title_en: string } | null): string {
    if (!s) return '—';
    return locale === 'ar' ? s.title_ar : s.title_en;
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearchError(null);
    setSearching(true);
    try {
      const found = await searchApplicationsForAdmission(query);
      setResults(found);
      setSearched(true);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : t('searchError'));
    } finally {
      setSearching(false);
    }
  }

  async function loadDetail(app: ApplicationSearchResult) {
    setSelected(app);
    setMode(null);
    setActionError(null);
    setActionSuccess(null);
    setDetailError(null);
    setLoadingDetail(true);
    try {
      const rows = await fetchAttendanceStateForApplication(app.id);
      setAttendanceRows(rows);
      const audit = await fetchAttendanceAuditLog(rows.map((r) => r.id));
      setAuditRows(audit);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : t('detailError'));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function refreshDetail() {
    if (!selected) return;
    await loadDetail(selected);
  }

  function startOverride() {
    setMode('override');
    setActionError(null);
    setActionSuccess(null);
    setActionSessionId('');
    setReason('');
  }

  function startCorrect(attendanceId: string) {
    setMode('correct');
    setActionError(null);
    setActionSuccess(null);
    setActionAttendanceId(attendanceId);
    setReason('');
  }

  function startTransfer(attendanceId: string) {
    setMode('transfer');
    setActionError(null);
    setActionSuccess(null);
    setActionAttendanceId(attendanceId);
    setActionSessionId('');
    setReason('');
  }

  function cancelAction() {
    setMode(null);
    setActionError(null);
    setReason('');
  }

  async function handleActionSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setActionError(null);
    if (reason.trim() === '') {
      setActionError(t('reasonRequiredError'));
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'override') {
        if (!actionSessionId) throw new Error(t('sessionRequiredError'));
        await performAdmitOverride({ applicationId: selected.id, sessionId: actionSessionId, deviceIdentifier: null, reason });
        setActionSuccess(t('overrideSuccess'));
      } else if (mode === 'correct') {
        await performCorrectAttendance({ attendanceId: actionAttendanceId, reason });
        setActionSuccess(t('correctSuccess'));
      } else if (mode === 'transfer') {
        if (!actionSessionId) throw new Error(t('sessionRequiredError'));
        await performTransferAttendance({ attendanceId: actionAttendanceId, newSessionId: actionSessionId, reason });
        setActionSuccess(t('transferSuccess'));
      }
      setMode(null);
      setReason('');
      await refreshDetail();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('actionError'));
    } finally {
      setSubmitting(false);
    }
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
          {results.map((app) => (
            <Card key={app.id} className={selected?.id === app.id ? 'ring-2 ring-turquoise' : ''}>
              <button type="button" onClick={() => loadDetail(app)} className="w-full text-start">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-turquoise">{app.application_number ?? app.id}</span>
                  <Badge variant={STATUS_BADGE_VARIANT[app.status] ?? 'neutral'}>{app.status}</Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal dark:text-gray-100">{app.full_name ?? t('unknownName')}</p>
                <p className="text-xs text-charcoal/60 dark:text-gray-400">{app.email ?? t('unknownEmail')}</p>
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

          {loadingDetail ? (
            <p className="text-sm text-charcoal/60 dark:text-gray-400">{t('loading')}</p>
          ) : (
            <>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('currentState')}</h3>
                {attendanceRows.length === 0 ? (
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noAttendanceRecords')}</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700">
                    <table className="w-full text-start text-sm">
                      <thead>
                        <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('session')}</th>
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('entryType')}</th>
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('admittedAt')}</th>
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('actions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                        {attendanceRows.map((row) => (
                          <tr key={row.id}>
                            <td className="px-4 py-2 text-charcoal dark:text-gray-100">{sessionLabel(row.sessions)}</td>
                            <td className="px-4 py-2">
                              <Badge variant={STATUS_BADGE_VARIANT[row.status] ?? 'neutral'}>{row.status}</Badge>
                            </td>
                            <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.entry_type}</td>
                            <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{new Date(row.admitted_at).toLocaleString(locale)}</td>
                            <td className="px-4 py-2">
                              {row.status === 'admitted' && (
                                <div className="flex flex-wrap gap-2">
                                  <Button size="sm" variant="secondary" onClick={() => startCorrect(row.id)}>
                                    {t('correctAction')}
                                  </Button>
                                  <Button size="sm" variant="secondary" onClick={() => startTransfer(row.id)}>
                                    {t('transferAction')}
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="mt-3">
                  <Button size="sm" onClick={startOverride}>
                    {t('overrideAction')}
                  </Button>
                </div>
              </div>

              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">{t('auditTrail')}</h3>
                {auditRows.length === 0 ? (
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noAuditEntries')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {auditRows.map((log) => (
                      <li key={log.id} className="rounded-md border border-charcoal/10 px-3 py-2 text-xs text-charcoal/70 dark:border-gray-700 dark:text-gray-400">
                        <span className="font-medium text-charcoal dark:text-gray-100">{log.action}</span> — {new Date(log.created_at).toLocaleString(locale)}
                        {log.metadata != null && <div className="mt-1 break-all font-mono">{JSON.stringify(log.metadata)}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {actionSuccess && (
            <p role="status" className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-300">
              {actionSuccess}
            </p>
          )}

          {mode && (
            <form onSubmit={handleActionSubmit} className="flex flex-col gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h3 className="text-sm font-semibold text-charcoal dark:text-gray-100">
                {mode === 'override' ? t('overrideFormTitle') : mode === 'correct' ? t('correctFormTitle') : t('transferFormTitle')}
              </h3>

              {(mode === 'override' || mode === 'transfer') && (
                <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
                  {t('session')}
                  <select
                    value={actionSessionId}
                    onChange={(e) => setActionSessionId(e.target.value)}
                    required
                    className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  >
                    <option value="">{t('selectSession')}</option>
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {locale === 'ar' ? s.title_ar : s.title_en}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
                {t('reasonLabel')}
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  rows={3}
                  className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </label>

              {actionError && (
                <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
                  {actionError}
                </p>
              )}

              <div className="mt-1 flex flex-wrap gap-2">
                <Button type="submit" disabled={submitting}>
                  {t('confirmAction')}
                </Button>
                <Button type="button" variant="secondary" onClick={cancelAction}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          )}

          {!mode && activeAttendance.length === 0 && attendanceRows.length === 0 && (
            <p className="text-xs text-charcoal/60 dark:text-gray-400">{t('overrideHint')}</p>
          )}
        </Card>
      )}
    </div>
  );
}
