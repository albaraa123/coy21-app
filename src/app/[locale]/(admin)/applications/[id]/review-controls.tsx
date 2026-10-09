'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { updateApplicationStatus, assignReviewer, addNote } from './actions';
import type { ApplicationStatus } from '@/lib/validation/admission-review';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Reviewer = { id: string; full_name: string; email: string };
type Note = { id: string; body: string; created_at: string; profiles: { full_name: string } | null };

// Visual weight for each possible status transition, matching the
// visual-weight-matches-consequence principle established in Group A's
// review (see Button's `destructive` variant): rejecting/waitlisting an
// applicant reads as more cautious than accepting them, and rejecting is
// never rendered as more inviting than accepting.
const TRANSITION_VARIANT: Record<ApplicationStatus, 'primary' | 'secondary' | 'destructive'> = {
  draft: 'secondary',
  submitted: 'secondary',
  under_review: 'secondary',
  accepted: 'primary',
  waitlisted: 'secondary',
  rejected: 'destructive',
  withdrawn: 'secondary',
};

export default function ReviewControls({
  applicationId,
  currentStatus,
  validNextStatuses,
  assignedReviewerId,
  reviewers,
  notes,
  locale,
}: {
  applicationId: string;
  currentStatus: string;
  validNextStatuses: ApplicationStatus[];
  assignedReviewerId: string | null;
  reviewers: Reviewer[];
  notes: Note[];
  locale: string;
}) {
  const t = useTranslations('applications.review');
  const router = useRouter();
  const [noteBody, setNoteBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [reviewerBusy, setReviewerBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);

  // Status transition labels are intentionally NOT translated (the raw enum
  // value is shown), matching the original behavior of rendering
  // `status`/`newStatus` verbatim — same as the status Badge on the list and
  // detail pages. Translating a fixed vocabulary here would risk staff
  // misreading a translated label as a different underlying enum value on a
  // security-sensitive action.
  async function handleStatusChange(newStatus: string) {
    setError(null);
    setBusyStatus(newStatus);
    try {
      await updateApplicationStatus(applicationId, newStatus as ApplicationStatus);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('statusError'));
    } finally {
      setBusyStatus(null);
    }
  }

  async function handleReviewerChange(reviewerId: string) {
    setError(null);
    setReviewerBusy(true);
    try {
      await assignReviewer(applicationId, reviewerId || null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reviewerError'));
    } finally {
      setReviewerBusy(false);
    }
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNoteBusy(true);
    try {
      await addNote(applicationId, noteBody);
      setNoteBody('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('noteError'));
    } finally {
      setNoteBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('statusTitle')}</h2>
        <Card className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-charcoal/70 dark:text-gray-400">
            {t('currentStatus')}: <span className="font-medium text-charcoal dark:text-gray-100">{currentStatus}</span>
          </span>
          {validNextStatuses.length === 0 ? (
            <span className="text-sm text-charcoal/60 dark:text-gray-400">{t('noTransitions')}</span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {validNextStatuses.map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant={TRANSITION_VARIANT[status]}
                  disabled={busyStatus !== null}
                  onClick={() => void handleStatusChange(status)}
                >
                  {busyStatus === status ? t('statusUpdating') : t('moveTo', { status })}
                </Button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('reviewerTitle')}</h2>
        <Card>
          <label htmlFor="reviewer-select" className="mb-1 block text-xs font-medium text-charcoal/60 dark:text-gray-400">
            {t('assignedReviewer')}
          </label>
          <select
            id="reviewer-select"
            value={assignedReviewerId ?? ''}
            disabled={reviewerBusy}
            onChange={(e) => void handleReviewerChange(e.target.value)}
            className="w-full max-w-sm rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('unassigned')}</option>
            {reviewers.map((r) => (
              <option key={r.id} value={r.id}>{r.full_name || r.email}</option>
            ))}
          </select>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('notesTitle')}</h2>
        <Card className="flex flex-col gap-3">
          <form onSubmit={handleAddNote} className="flex flex-col gap-2">
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder={t('notePlaceholder')}
              rows={3}
              className="w-full rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
            <div>
              <Button type="submit" size="sm" disabled={noteBusy}>
                {noteBusy ? t('addingNote') : t('addNote')}
              </Button>
            </div>
          </form>

          {notes.length === 0 ? (
            <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noNotes')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {notes.map((note) => (
                <li key={note.id} className="rounded-md border border-charcoal/10 p-3 dark:border-gray-700">
                  <p className="text-sm text-charcoal dark:text-gray-100">{note.body}</p>
                  <p className="mt-1 text-xs text-charcoal/60 dark:text-gray-400">
                    {note.profiles?.full_name} — {new Date(note.created_at).toLocaleString(locale)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </section>
  );
}
