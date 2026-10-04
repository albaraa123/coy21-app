'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { WaitlistButton } from './booking-button';
import { formatConferenceTime } from '@/lib/datetime/conference-time';

type Session = {
  id: string;
  title_en: string;
  title_ar: string;
  start_time: string;
  end_time: string;
  rooms: { name_en: string; name_ar: string } | null;
};

type WaitlistEntry = {
  id: string;
  session_id: string;
  sessions: Session | null;
};

type Props = {
  entries: WaitlistEntry[];
  locale: string;
};

// Mirrors AgendaDay's local-removal pattern (its `cancelled` Set) so a
// successful "Leave waitlist" removes the row immediately instead of
// WaitlistButton locally flipping to its "Join waitlist" branch under a
// now-stale "Waitlisted" badge -- see the onLeft prop on WaitlistButton.
export function WaitlistedSessions({ entries, locale }: Props) {
  const [left, setLeft] = useState<Set<string>>(new Set());

  const visible = entries.filter((e) => !left.has(e.id));

  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">
        Waitlisted
      </h2>
      {visible.map((entry) => {
        const s = entry.sessions;
        if (!s) return null;

        const title = locale === 'ar' ? s.title_ar : s.title_en;
        const room = s.rooms ? (locale === 'ar' ? s.rooms.name_ar : s.rooms.name_en) : '';
        const start = formatConferenceTime(s.start_time, locale === 'ar' ? 'ar' : 'en');
        const end = formatConferenceTime(s.end_time, locale === 'ar' ? 'ar' : 'en');

        return (
          <Card key={entry.id} className="flex flex-row items-start gap-3 py-3">
            <div className="flex flex-1 flex-col gap-0.5">
              <p className="text-sm font-medium text-charcoal dark:text-gray-100">{title}</p>
              <p className="text-xs text-charcoal/60 dark:text-gray-400">
                {start} – {end}
                {room ? ` · ${room}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
              <Badge variant="waitlisted">Waitlisted</Badge>
              <WaitlistButton
                sessionId={s.id}
                isWaitlisted={true}
                onLeft={() => setLeft((prev) => new Set([...prev, entry.id]))}
              />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
