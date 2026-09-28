'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import {
  createSessionAssignment,
  createRoomAssignment,
  checkSessionAssignmentWarning,
  deactivateAssignment,
  reassignToSession,
  reassignToRoom,
} from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type Scanner = { id: string; full_name: string; email: string };
type Session = { id: string; title_ar: string; title_en: string; status: string; room_id: string; start_time: string; end_time: string };
type Room = { id: string; code: string; name_ar: string; name_en: string };
type Assignment = {
  id: string;
  scanner_user_id: string;
  session_id: string | null;
  room_id: string | null;
  is_active: boolean;
  assigned_at: string;
  sessions: { id: string; title_ar: string; title_en: string; status: string; room_id: string } | null;
  rooms: { id: string; code: string; name_ar: string; name_en: string } | null;
};

type FormState = {
  scannerUserId: string;
  scope: 'session' | 'room';
  sessionId: string;
  roomId: string;
};

const EMPTY_FORM: FormState = { scannerUserId: '', scope: 'session', sessionId: '', roomId: '' };

export default function ScannerAssignmentManager({
  scanners,
  assignments,
  sessions,
  rooms,
}: {
  scanners: Scanner[];
  assignments: Assignment[];
  sessions: Session[];
  rooms: Room[];
}) {
  const t = useTranslations('scannerAssignments');
  const locale = useLocale();
  const router = useRouter();

  const [creating, setCreating] = useState(false);
  const [reassigningId, setReassigningId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [warning, setWarning] = useState<{ code: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [filterScanner, setFilterScanner] = useState('');
  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'inactive'>('active');

  const scannerName = (id: string) => scanners.find((s) => s.id === id)?.full_name ?? id;

  const visibleAssignments = useMemo(() => {
    return assignments.filter((a) => {
      if (filterScanner && a.scanner_user_id !== filterScanner) return false;
      if (filterActive === 'active' && !a.is_active) return false;
      if (filterActive === 'inactive' && a.is_active) return false;
      return true;
    });
  }, [assignments, filterScanner, filterActive]);

  function startCreate() {
    setError(null);
    setWarning(null);
    setReassigningId(null);
    setCreating(true);
    setForm(EMPTY_FORM);
  }

  function startReassign(assignment: Assignment) {
    setError(null);
    setWarning(null);
    setCreating(false);
    setReassigningId(assignment.id);
    setForm({
      scannerUserId: assignment.scanner_user_id,
      scope: assignment.session_id ? 'session' : 'room',
      sessionId: assignment.session_id ?? '',
      roomId: assignment.room_id ?? '',
    });
  }

  function cancel() {
    setError(null);
    setWarning(null);
    setCreating(false);
    setReassigningId(null);
    setForm(EMPTY_FORM);
  }

  async function checkWarning(next: FormState) {
    setWarning(null);
    if (next.scope !== 'session' || !next.scannerUserId || !next.sessionId) return;
    try {
      const result = await checkSessionAssignmentWarning(next.scannerUserId, next.sessionId);
      if (result) setWarning(result);
    } catch {
      // Warning check is advisory only — never blocks the form on its own failure.
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!form.scannerUserId) throw new Error(t('scannerRequiredError'));
      if (form.scope === 'session') {
        if (!form.sessionId) throw new Error(t('sessionRequiredError'));
        if (reassigningId) {
          await reassignToSession(reassigningId, form.scannerUserId, form.sessionId);
        } else {
          await createSessionAssignment({ scannerUserId: form.scannerUserId, sessionId: form.sessionId });
        }
      } else {
        if (!form.roomId) throw new Error(t('roomRequiredError'));
        if (reassigningId) {
          await reassignToRoom(reassigningId, form.scannerUserId, form.roomId);
        } else {
          await createRoomAssignment({ scannerUserId: form.scannerUserId, roomId: form.roomId });
        }
      }
      cancel();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeactivate(id: string) {
    setError(null);
    try {
      await deactivateAssignment(id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deactivateError'));
    }
  }

  const showForm = creating || reassigningId !== null;

  function assignmentTarget(a: Assignment): string {
    if (a.sessions) return locale === 'ar' ? a.sessions.title_ar : a.sessions.title_en;
    if (a.rooms) return locale === 'ar' ? a.rooms.name_ar : a.rooms.name_en;
    return '—';
  }

  function assignmentScopeLabel(a: Assignment): string {
    return a.session_id ? t('scopeSession') : t('scopeRoom');
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filterByScanner')}
          <select
            value={filterScanner}
            onChange={(e) => setFilterScanner(e.target.value)}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('allScanners')}</option>
            {scanners.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filterByStatus')}
          <select
            value={filterActive}
            onChange={(e) => setFilterActive(e.target.value as typeof filterActive)}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="active">{t('active')}</option>
            <option value="inactive">{t('inactive')}</option>
            <option value="all">{t('allStatuses')}</option>
          </select>
        </label>
      </div>

      {visibleAssignments.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          <div className="flex flex-col gap-2 md:hidden">
            {visibleAssignments.map((a) => (
              <Card key={a.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{scannerName(a.scanner_user_id)}</p>
                  <Badge variant={a.is_active ? 'changed' : 'neutral'}>{a.is_active ? t('active') : t('inactive')}</Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                  {assignmentScopeLabel(a)}: {assignmentTarget(a)}
                </p>
                {a.is_active && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => startReassign(a)}>
                      {t('reassign')}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => handleDeactivate(a.id)}>
                      {t('deactivate')}
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('scanner')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('scope')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('target')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('status')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    {t('actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {visibleAssignments.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{scannerName(a.scanner_user_id)}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{assignmentScopeLabel(a)}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{assignmentTarget(a)}</td>
                    <td className="px-4 py-2">
                      <Badge variant={a.is_active ? 'changed' : 'neutral'}>{a.is_active ? t('active') : t('inactive')}</Badge>
                    </td>
                    <td className="px-4 py-2">
                      {a.is_active && (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" onClick={() => startReassign(a)}>
                            {t('reassign')}
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => handleDeactivate(a.id)}>
                            {t('deactivate')}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!showForm && (
        <div className="mt-4">
          <Button onClick={startCreate}>{t('addNew')}</Button>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{reassigningId ? t('formTitleReassign') : t('formTitleCreate')}</h2>

          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('scanner')}
            <select
              value={form.scannerUserId}
              onChange={(e) => {
                const next = { ...form, scannerUserId: e.target.value };
                setForm(next);
                void checkWarning(next);
              }}
              required
              disabled={reassigningId !== null}
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">{t('selectScanner')}</option>
              {scanners.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name} ({s.email})
                </option>
              ))}
            </select>
          </label>

          <fieldset className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            <legend className="mb-1">{t('scope')}</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={form.scope === 'session'}
                  onChange={() => {
                    const next = { ...form, scope: 'session' as const };
                    setForm(next);
                    void checkWarning(next);
                  }}
                />
                {t('scopeSession')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={form.scope === 'room'}
                  onChange={() => {
                    setWarning(null);
                    setForm({ ...form, scope: 'room' });
                  }}
                />
                {t('scopeRoom')}
              </label>
            </div>
          </fieldset>

          {form.scope === 'session' ? (
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('session')}
              <select
                value={form.sessionId}
                onChange={(e) => {
                  const next = { ...form, sessionId: e.target.value };
                  setForm(next);
                  void checkWarning(next);
                }}
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
          ) : (
            <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
              {t('room')}
              <select
                value={form.roomId}
                onChange={(e) => setForm({ ...form, roomId: e.target.value })}
                required
                className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">{t('selectRoom')}</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {locale === 'ar' ? r.name_ar : r.name_en} ({r.code})
                  </option>
                ))}
              </select>
              <span className="text-xs text-charcoal/60 dark:text-gray-400">{t('roomScopeExplanation')}</span>
            </label>
          )}

          {warning && (
            <p role="status" className="rounded-md border border-amber-600 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-400 dark:bg-amber-950/40 dark:text-amber-300">
              {warning.message}
            </p>
          )}

          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting || (warning?.code === 'exact_duplicate')}>
              {reassigningId ? t('reassignAction') : t('create')}
            </Button>
            <Button type="button" variant="secondary" onClick={cancel}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
