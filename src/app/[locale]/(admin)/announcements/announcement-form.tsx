'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { createAnnouncement } from './actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Minimal composer per the plan's Task 5 scope: title field, body field,
// send button -- deliberately no history/list view of past announcements
// (explicit Non-Goal). Styling/structure follows review-controls.tsx's
// handleAddNote form (same file area: title + raw <input>/<textarea>,
// Button type="submit" with a busy-label swap, role="alert" error text) --
// the closest existing precedent for "a staff member submits free text via
// a Server Action from a Client Component" in this codebase.
export default function AnnouncementForm() {
  const t = useTranslations('announcements');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setBusy(true);
    try {
      // Trim here too, not just in the disabled-button condition below --
      // the Server Action (createAnnouncementForCaller) also trims/guards
      // against a whitespace-only title as a backstop, but this form
      // shouldn't rely solely on that: if the button's disabled condition
      // is ever changed independently of this call, a whitespace-only
      // title should still never reach the server untrimmed.
      await createAnnouncement(title.trim(), body.trim() === '' ? undefined : body);
      setTitle('');
      setBody('');
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sendError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="text-xs text-turquoise">
          {t('sendSuccess')}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <label htmlFor="announcement-title" className="mb-1 block text-xs font-medium text-charcoal/60 dark:text-gray-400">
            {t('titleLabel')}
          </label>
          <input
            id="announcement-title"
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </div>

        <div>
          <label htmlFor="announcement-body" className="mb-1 block text-xs font-medium text-charcoal/60 dark:text-gray-400">
            {t('bodyLabel')}
          </label>
          <textarea
            id="announcement-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </div>

        <div>
          <Button type="submit" size="sm" disabled={busy || title.trim() === ''}>
            {busy ? t('sending') : t('sendButton')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
