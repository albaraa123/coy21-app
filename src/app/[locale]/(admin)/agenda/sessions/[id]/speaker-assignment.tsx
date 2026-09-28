'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { assignSessionPerson, removeSessionPerson } from './actions';
import { SESSION_PERSON_ROLES, type SessionPersonRole } from '@/lib/validation/agenda';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type SessionPersonRow = {
  id: string;
  person_id: string;
  role: SessionPersonRole;
  display_order: number;
  is_primary: boolean;
  people: { id: string; full_name_ar: string; full_name_en: string } | null;
};

type RefOption = { id: string; [key: string]: unknown };

export default function SpeakerAssignment({
  sessionId,
  sessionPeople,
  people,
}: {
  sessionId: string;
  sessionPeople: SessionPersonRow[];
  people: RefOption[];
}) {
  const t = useTranslations('agenda.sessions.detail.speakers');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [newPersonId, setNewPersonId] = useState('');
  const [newPersonRole, setNewPersonRole] = useState<SessionPersonRole>(SESSION_PERSON_ROLES[0]);

  async function handleAssignPerson(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!newPersonId) return;
    setSubmitting(true);
    try {
      await assignSessionPerson(sessionId, {
        personId: newPersonId,
        role: newPersonRole,
        // Best-effort ordering: appends to the end based on the current page's
        // snapshot of sessionPeople.length. Not a guaranteed sequence under
        // concurrent edits (two admins assigning at once could both compute
        // the same display_order).
        displayOrder: sessionPeople.length,
        isPrimary: false,
      });
      setNewPersonId('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('assignError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemovePerson(sessionPeopleId: string) {
    setError(null);
    setSubmitting(true);
    try {
      await removeSessionPerson(sessionPeopleId);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('removeError'));
    } finally {
      setSubmitting(false);
    }
  }

  const assignedPersonIds = new Set(sessionPeople.map((sp) => sp.person_id));
  const availablePeopleForAssignment = people.filter((p) => !assignedPersonIds.has(p.id));

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <Card className="flex flex-col gap-3">
        {sessionPeople.length === 0 ? (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">—</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sessionPeople.map((sp) => (
              <li key={sp.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-charcoal/10 p-2 dark:border-gray-700">
                <span className="text-sm text-charcoal dark:text-gray-100">
                  {sp.people?.full_name_en} — {t(`roleValues.${sp.role}`)}
                  {sp.is_primary && ` (${t('primary')})`}
                </span>
                <Button size="sm" variant="destructive" onClick={() => handleRemovePerson(sp.id)} disabled={submitting}>
                  {t('remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={handleAssignPerson} className="flex flex-wrap items-end gap-2">
          <select
            value={newPersonId}
            onChange={(e) => setNewPersonId(e.target.value)}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('selectPerson')}</option>
            {availablePeopleForAssignment.map((p) => (
              <option key={p.id} value={p.id}>{String(p.full_name_en)}</option>
            ))}
          </select>
          <select
            value={newPersonRole}
            onChange={(e) => setNewPersonRole(e.target.value as SessionPersonRole)}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            {SESSION_PERSON_ROLES.map((role) => (
              <option key={role} value={role}>{t(`roleValues.${role}`)}</option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={!newPersonId || submitting}>{t('assign')}</Button>
        </form>
      </Card>
    </div>
  );
}
