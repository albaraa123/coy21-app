'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { sendBulkEmail, previewAudienceCount, type AudienceKey } from './actions';

const AUDIENCES: { key: AudienceKey; label: string; description: string }[] = [
  {
    key: 'all_accepted',
    label: 'All accepted participants',
    description: 'Everyone with accepted status',
  },
  {
    key: 'no_travel',
    label: 'No travel submitted',
    description: 'Accepted participants who have not entered any flight legs',
  },
  {
    key: 'no_bookings',
    label: 'No session bookings',
    description: 'Accepted participants with zero active session bookings',
  },
  { key: 'type_delegate', label: 'Delegates only', description: 'COY21-DEL-* participants' },
  { key: 'type_volunteer', label: 'Volunteers only', description: 'COY21-VOL-* participants' },
  { key: 'type_kp', label: 'Knowledge Partners only', description: 'COY21-KP-* participants' },
  { key: 'type_youngo', label: 'Youngo only', description: 'COY21-YNG-* participants' },
  { key: 'type_speaker', label: 'Speakers only', description: 'COY21-SPK-* participants' },
];

export function ComposeForm() {
  const [audience, setAudience] = useState<AudienceKey>('all_accepted');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [result, setResult] = useState<{ sent: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewing, startPreview] = useTransition();
  const [isSending, startSend] = useTransition();

  function handleAudienceChange(key: AudienceKey) {
    setAudience(key);
    setAudienceCount(null);
    setResult(null);
    setError(null);
  }

  function handlePreview() {
    startPreview(async () => {
      const count = await previewAudienceCount(audience);
      setAudienceCount(count);
    });
  }

  function handleSend() {
    if (!subject.trim() || !body.trim()) {
      setError('Subject and body are required.');
      return;
    }
    if (!confirm(`Send to ${audienceCount ?? '?'} recipients? This cannot be undone.`)) return;

    setResult(null);
    setError(null);
    startSend(async () => {
      const res = await sendBulkEmail({ audience, subject, body });
      if (res.error) {
        setError(res.error);
      } else {
        setResult({ sent: res.sent, failed: res.failed });
        setSubject('');
        setBody('');
        setAudienceCount(null);
      }
    });
  }

  const selectedAudience = AUDIENCES.find((a) => a.key === audience)!;

  return (
    <div className="flex flex-col gap-6">
      {/* Audience selector */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-charcoal dark:text-gray-200">
          Audience
        </legend>
        <div className="flex flex-col gap-2">
          {AUDIENCES.map((a) => (
            <label
              key={a.key}
              className={[
                'flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors',
                audience === a.key
                  ? 'border-turquoise bg-turquoise/5 dark:border-turquoise/60'
                  : 'border-charcoal/10 hover:border-charcoal/20 dark:border-white/10 dark:hover:border-white/20',
              ].join(' ')}
            >
              <input
                type="radio"
                name="audience"
                value={a.key}
                checked={audience === a.key}
                onChange={() => handleAudienceChange(a.key)}
                className="mt-0.5 accent-turquoise"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-charcoal dark:text-gray-100">
                  {a.label}
                </span>
                <span className="text-xs text-charcoal/50 dark:text-gray-500">
                  {a.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button
            onClick={handlePreview}
            disabled={isPreviewing}
            variant="secondary"
            size="sm"
          >
            {isPreviewing ? 'Counting…' : 'Preview count'}
          </Button>
          {audienceCount !== null && (
            <span className="text-sm text-charcoal/70 dark:text-gray-400">
              {audienceCount} recipient{audienceCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </fieldset>

      {/* Subject */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-charcoal dark:text-gray-200">
          Subject
        </label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Email subject line"
          className="w-full rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal outline-none focus:border-turquoise focus:ring-1 focus:ring-turquoise dark:border-white/20 dark:text-gray-100"
        />
      </div>

      {/* Body */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-charcoal dark:text-gray-200">
          Message body
        </label>
        <p className="text-xs text-charcoal/50 dark:text-gray-500">
          Use <code className="font-mono">{'{{name}}'}</code> to insert the recipient&apos;s name.
        </p>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          placeholder={`Dear {{name}},\n\n...`}
          className="w-full rounded-md border border-charcoal/20 bg-transparent px-3 py-2 text-sm text-charcoal outline-none focus:border-turquoise focus:ring-1 focus:ring-turquoise dark:border-white/20 dark:text-gray-100"
        />
      </div>

      {/* Send */}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {result && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950/40 dark:text-green-300">
          Sent {result.sent} email{result.sent !== 1 ? 's' : ''}.
          {result.failed > 0 && ` ${result.failed} failed.`}
        </p>
      )}

      <Button
        onClick={handleSend}
        disabled={isSending || !subject.trim() || !body.trim()}
        size="md"
      >
        {isSending ? 'Sending…' : `Send email${audienceCount && audienceCount > 1 ? 's' : ''}`}
      </Button>

      <p className="text-xs text-charcoal/40 dark:text-gray-600">
        Audience: {selectedAudience.label}.
        Emails are sent via Resend in sequence — for very large batches this may take a few minutes.
      </p>
    </div>
  );
}
