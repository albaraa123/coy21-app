import { getLocale } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { BookButton } from '../booking-button';
import { formatConferenceTime } from '@/lib/datetime/conference-time';

export default async function BrowseSessionsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const { data: application } = await supabase
    .from('applications')
    .select('id')
    .eq('applicant_id', user.id)
    .eq('status', 'accepted')
    .maybeSingle();

  if (!application) {
    redirect({ href: '/my-application', locale });
    return;
  }

  // All published/confirmed sessions with room, track, day, and booked count
  const { data: sessions } = await supabase
    .from('sessions')
    .select(`
      id,
      title_en,
      title_ar,
      start_time,
      end_time,
      booking_deadline,
      capacity,
      rooms ( name_en, name_ar ),
      tracks ( color, name_en, name_ar ),
      conference_days ( conference_date, label_en, label_ar, display_order )
    `)
    .in('status', ['published', 'confirmed'])
    .order('start_time');

  // Caller's active bookings — to show "Booked" state immediately
  const { data: myBookings } = await supabase
    .from('session_bookings')
    .select('session_id')
    .eq('application_id', application.id)
    .eq('status', 'active');

  const myBookedIds = new Set((myBookings ?? []).map((b) => b.session_id));

  // Active booking counts per session — from a single query
  const { data: countRows } = await supabase
    .from('session_bookings')
    .select('session_id')
    .eq('status', 'active');

  const countMap = new Map<string, number>();
  for (const row of countRows ?? []) {
    countMap.set(row.session_id, (countMap.get(row.session_id) ?? 0) + 1);
  }

  // Group by day
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byDay = groupByDay(sessions ?? [] as any[]);

  const now = new Date();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div className="flex items-center gap-3">
        <Link
          href="/my-agenda"
          className="text-sm text-charcoal/60 hover:text-charcoal dark:text-gray-400 dark:hover:text-gray-100"
        >
          ← My Agenda
        </Link>
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">Browse Sessions</h1>
      </div>

      {byDay.length === 0 && (
        <Card className="py-10 text-center text-sm text-charcoal/50 dark:text-gray-400">
          No sessions available yet. Check back soon.
        </Card>
      )}

      {byDay.map((day) => (
        <div key={day.date} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">
            {locale === 'ar' ? day.labelAr : day.labelEn}
          </h2>

          {day.sessions.map((s) => {
            const deadline = s.booking_deadline
              ? new Date(s.booking_deadline)
              : new Date(new Date(s.start_time).getTime() - 3 * 60 * 60 * 1000);
            const isPastDeadline = now > deadline;
            const bookedCount = countMap.get(s.id) ?? 0;
            const isFull = bookedCount >= s.capacity;
            const alreadyBooked = myBookedIds.has(s.id);

            const title = locale === 'ar' ? s.title_ar : s.title_en;
            const room = s.rooms ? (locale === 'ar' ? s.rooms.name_ar : s.rooms.name_en) : '';
            const track = s.tracks ? (locale === 'ar' ? s.tracks.name_ar : s.tracks.name_en) : '';
            const trackColor = s.tracks?.color ?? '#6b7280';

            const start = formatConferenceTime(s.start_time, locale === 'ar' ? 'ar' : 'en');
            const end = formatConferenceTime(s.end_time, locale === 'ar' ? 'ar' : 'en');

            return (
              <Card key={s.id} className="flex flex-row items-start gap-3 py-3">
                <div
                  className="mt-0.5 shrink-0 rounded-full"
                  style={{ backgroundColor: trackColor, width: 4, minHeight: 40 }}
                />
                <div className="flex flex-1 flex-col gap-0.5">
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{title}</p>
                  <p className="text-xs text-charcoal/60 dark:text-gray-400">
                    {start} – {end}
                    {room ? ` · ${room}` : ''}
                  </p>
                  <p className="text-xs text-charcoal/40 dark:text-gray-500">
                    {track}
                    {!isFull && !isPastDeadline
                      ? ` · ${s.capacity - bookedCount} spots left`
                      : ''}
                  </p>
                </div>
                <div className="shrink-0 pt-0.5">
                  {alreadyBooked ? (
                    <span className="text-sm font-medium text-green-600 dark:text-green-400">Booked ✓</span>
                  ) : (
                    <BookButton
                      sessionId={s.id}
                      isFull={isFull}
                      isPastDeadline={isPastDeadline}
                    />
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function groupByDay(sessions: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = new Map<string, { date: string; labelEn: string; labelAr: string; order: number; sessions: any[] }>();
  for (const s of sessions) {
    const day = s.conference_days;
    if (!day) continue;
    if (!map.has(day.conference_date)) {
      map.set(day.conference_date, { date: day.conference_date, labelEn: day.label_en, labelAr: day.label_ar, order: day.display_order, sessions: [] });
    }
    map.get(day.conference_date)!.sessions.push(s);
  }
  return [...map.values()].sort((a, b) => a.order - b.order);
}
