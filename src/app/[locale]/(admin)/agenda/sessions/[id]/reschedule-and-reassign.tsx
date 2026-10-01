'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { updateSessionScheduleAndAssignments } from './actions';
import { SESSION_PERSON_ROLES, type SessionPersonRole } from '@/lib/validation/agenda';
import { isoToConferenceLocalInputValue, conferenceLocalInputValueToIso } from '@/lib/datetime/conference-time';
import type { Database } from '@/types/database';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Session = Database['public']['Tables']['sessions']['Row'];

type SessionPersonRow = {
  id: string;
  person_id: string;
  role: SessionPersonRole;
  display_order: number;
  is_primary: boolean;
  people: { id: string; full_name_ar: string; full_name_en: string } | null;
};

type RefOption = { id: string; [key: string]: unknown };

export default function RescheduleAndReassign({
  session,
  sessionPeople,
  people,
  rooms,
}: {
  session: Session;
  sessionPeople: SessionPersonRow[];
  people: RefOption[];
  rooms: RefOption[];
}) {
  const t = useTranslations('agenda.sessions.detail.reschedule');
  const tRoles = useTranslations('agenda.sessions.detail.speakers');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [startTime, setStartTime] = useState(() => isoToConferenceLocalInputValue(session.start_time));
  const [endTime, setEndTime] = useState(() => isoToConferenceLocalInputValue(session.end_time));
  const [roomId, setRoomId] = useState(session.room_id);

  const [selectedPersonIds, setSelectedPersonIds] = useState<Set<string>>(
    () => new Set(sessionPeople.map((sp) => sp.person_id))
  );
  const [personRoles, setPersonRoles] = useState<Record<string, SessionPersonRole>>(() => {
    const initial: Record<string, SessionPersonRole> = {};
    for (const sp of sessionPeople) {
      initial[sp.person_id] = sp.role;
    }
    return initial;
  });
  const [primaryPersonId, setPrimaryPersonId] = useState<string | null>(
    () => sessionPeople.find((sp) => sp.is_primary)?.person_id ?? null
  );

  function togglePerson(personId: string) {
    setSelectedPersonIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) {
        next.delete(personId);
        // A person who is no longer assigned can't remain the designated
        // primary — clear it rather than silently submitting a primary
        // designation for someone not in the assignment list.
        setPrimaryPersonId((current) => (current === personId ? null : current));
      } else {
        next.add(personId);
        if (!(personId in personRoles)) {
          setPersonRoles((r) => ({ ...r, [personId]: SESSION_PERSON_ROLES[0] }));
        }
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const selectedIds = [...selectedPersonIds];
      await updateSessionScheduleAndAssignments(session.id, {
        startTime: conferenceLocalInputValueToIso(startTime),
        endTime: conferenceLocalInputValueToIso(endTime),
        roomId,
        // Best-effort ordering, same approach as SpeakerAssignment: index-based
        // displayOrder over this submission's selected people. isPrimary is
        // true only for the person selected via the "Primary" radio below
        // (if any) — this RPC replaces the full session_people set, so the
        // current is_primary designation must be explicitly re-submitted or
        // it is silently cleared.
        assignments: selectedIds.map((personId, index) => ({
          personId,
          role: personRoles[personId] ?? SESSION_PERSON_ROLES[0],
          displayOrder: index,
          isPrimary: personId === primaryPersonId,
        })),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <Card className="border-gold/60 bg-gold/5 dark:border-amber-700/60 dark:bg-amber-950/10">
        <p className="mb-3 text-sm text-charcoal/70 dark:text-gray-400">{t('description')}</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('startTime')}
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('endTime')}
            <input
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            {t('room')}
            <select
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              required
              className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{String(r.name_en)}</option>
              ))}
            </select>
          </label>

          <fieldset className="rounded-lg border border-charcoal/10 p-3 dark:border-gray-700">
            <legend className="px-1 text-sm font-medium text-charcoal dark:text-gray-100">{t('speakersLegend')}</legend>
            <ul className="flex flex-col gap-2">
              {people.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
                    <input
                      type="checkbox"
                      checked={selectedPersonIds.has(p.id)}
                      onChange={() => togglePerson(p.id)}
                      className="h-4 w-4 rounded border-charcoal/30 text-turquoise focus:ring-turquoise dark:border-gray-600"
                    />
                    {String(p.full_name_en)}
                  </label>
                  {selectedPersonIds.has(p.id) && (
                    <>
                      <select
                        value={personRoles[p.id] ?? SESSION_PERSON_ROLES[0]}
                        onChange={(e) => setPersonRoles((r) => ({ ...r, [p.id]: e.target.value as SessionPersonRole }))}
                        className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                      >
                        {SESSION_PERSON_ROLES.map((role) => (
                          <option key={role} value={role}>{tRoles(`roleValues.${role}`)}</option>
                        ))}
                      </select>
                      <label className="flex items-center gap-1 text-xs text-charcoal/70 dark:text-gray-400">
                        <input
                          type="radio"
                          name="primaryPerson"
                          checked={primaryPersonId === p.id}
                          onChange={() => setPrimaryPersonId(p.id)}
                          className="h-4 w-4 border-charcoal/30 text-turquoise focus:ring-turquoise dark:border-gray-600"
                        />
                        {t('primary')}
                      </label>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>

          <div>
            <Button type="submit" variant="destructive" disabled={submitting}>{t('save')}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
