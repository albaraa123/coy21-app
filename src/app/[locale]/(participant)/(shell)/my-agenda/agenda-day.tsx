'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { CancelButton } from './booking-button';
import { formatConferenceTime } from '@/lib/datetime/conference-time';

type Session = {
  id: string;
  title_en: string;
  title_ar: string;
  start_time: string;
  end_time: string;
  booking_deadline: string | null;
  capacity: number;
  rooms: { name_en: string; name_ar: string } | null;
  tracks: { color: string | null } | null;
};

type Booking = {
  id: string;
  session_id: string;
  status: string;
  sessions: Session | null;
};

type Props = {
  date: string;
  label: string;
  bookings: Booking[];
  locale: string;
  applicationId: string;
};

export function AgendaDay({ date: _date, label, bookings, locale }: Props) {
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());

  const visible = bookings.filter((b) => !cancelled.has(b.id));

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">
        {label}
      </h2>
      {visible.length === 0 ? (
        <p className="text-sm text-charcoal/50 dark:text-gray-500">No sessions booked for this day.</p>
      ) : (
        visible.map((b) => {
          const s = b.sessions;
          if (!s) return null;

          const now = new Date();
          const deadline = s.booking_deadline
            ? new Date(s.booking_deadline)
            : new Date(new Date(s.start_time).getTime() - 3 * 60 * 60 * 1000);
          const isPastDeadline = now > deadline;

          const start = formatConferenceTime(s.start_time, locale === 'ar' ? 'ar' : 'en');

          const end = formatConferenceTime(s.end_time, locale === 'ar' ? 'ar' : 'en');

          const title = locale === 'ar' ? s.title_ar : s.title_en;
          const room = s.rooms
            ? (locale === 'ar' ? s.rooms.name_ar : s.rooms.name_en)
            : '';
          const trackColor = s.tracks?.color ?? '#6b7280';

          return (
            <Card key={b.id} className="flex flex-row items-start gap-3 py-3">
              {/* Track color strip */}
              <div
                className="mt-0.5 h-full w-1 shrink-0 rounded-full"
                style={{ backgroundColor: trackColor, minHeight: 40 }}
              />
              <div className="flex flex-1 flex-col gap-0.5">
                <p className="text-sm font-medium text-charcoal dark:text-gray-100">{title}</p>
                <p className="text-xs text-charcoal/60 dark:text-gray-400">
                  {start} – {end}
                  {room ? ` · ${room}` : ''}
                </p>
              </div>
              <div className="shrink-0">
                {b.status === 'session_cancelled' ? (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                    Session Cancelled
                  </span>
                ) : (
                  <CancelButton
                    bookingId={b.id}
                    isPastDeadline={isPastDeadline}
                    onCancelled={() => setCancelled((prev) => new Set([...prev, b.id]))}
                  />
                )}
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
