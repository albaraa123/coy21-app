import { getLocale } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { BookButton, WaitlistButton } from '../booking-button';
import { MountReveal } from '@/components/motion/mount-reveal';
import { AgendaTimeGrid } from '@/components/schedule/agenda-time-grid';
import { DayTabs } from './day-tabs';

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
      track_id,
      title_en,
      title_ar,
      start_time,
      end_time,
      booking_deadline,
      capacity,
      rooms ( name_en, name_ar ),
      tracks ( color, name_en, name_ar ),
      conference_days ( conference_date, label_en, label_ar, display_order ),
      session_types ( enable_waitlist )
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

  // Caller's own waitlist entries — to show "On waitlist" state immediately
  const { data: myWaitlistRows } = await supabase
    .from('session_waitlist')
    .select('session_id')
    .eq('application_id', application.id)
    .eq('status', 'waiting');

  const myWaitlistedIds = new Set((myWaitlistRows ?? []).map((w) => w.session_id));

  // Global booking-closing deadline (a singleton row) — mirrors
  // session_effective_deadline()'s own least(global, per-session) logic
  // client-side, so the "Book"/"Join waitlist" buttons below reflect the
  // same hard ceiling book_session/join_waitlist actually enforce
  // server-side, instead of only ever checking each session's own
  // booking_deadline.
  const { data: conferenceSettings } = await supabase
    .from('conference_settings')
    .select('global_booking_deadline')
    .eq('id', true)
    .maybeSingle();
  const globalDeadline = conferenceSettings?.global_booking_deadline
    ? new Date(conferenceSettings.global_booking_deadline)
    : null;

  // Active booking counts per session — from a single query
  const { data: countRows } = await supabase
    .from('session_bookings')
    .select('session_id')
    .eq('status', 'active');

  const countMap = new Map<string, number>();
  for (const row of countRows ?? []) {
    countMap.set(row.session_id, (countMap.get(row.session_id) ?? 0) + 1);
  }

  // Confirmed allocation-assignment counts per session — via a SECURITY
  // DEFINER RPC, since participants have no direct RLS access to
  // allocation_assignments. Added to (not replacing) the session_bookings
  // counts above, so the displayed "spots left" matches exactly what
  // book_session() will enforce.
  const { data: allocationCountRows } = await supabase.rpc('session_allocation_confirmed_counts' as never);
  for (const row of (allocationCountRows ?? []) as { session_id: string; confirmed_count: number }[]) {
    countMap.set(row.session_id, (countMap.get(row.session_id) ?? 0) + row.confirmed_count);
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

      {byDay.length === 0 ? (
        <MountReveal delayMs={0}>
          <Card className="py-10 text-center text-sm text-charcoal/50 dark:text-gray-400">
            No sessions available yet. Check back soon.
          </Card>
        </MountReveal>
      ) : (
        <DayTabs days={byDay} locale={locale}>
          {(day) => (
            <AgendaTimeGrid
              tracks={distinctTracksForGrid(day.sessions, locale)}
              otherTrackLabel={locale === 'ar' ? 'أخرى' : 'Other'}
              sessions={day.sessions.map((s) => ({
                id: s.id,
                trackId: s.track_id,
                startTime: s.start_time,
                endTime: s.end_time,
                booking_deadline: s.booking_deadline,
                capacity: s.capacity,
                rooms: s.rooms,
                title_en: s.title_en,
                title_ar: s.title_ar,
                session_types: s.session_types,
              }))}
              emptyState={
                <Card className="py-10 text-center text-sm text-charcoal/50 dark:text-gray-400">
                  No sessions this day yet.
                </Card>
              }
              renderBlock={(s) => {
                const perSessionDeadline = s.booking_deadline
                  ? new Date(s.booking_deadline)
                  : new Date(new Date(s.startTime).getTime() - 3 * 60 * 60 * 1000);
                const deadline = globalDeadline && globalDeadline < perSessionDeadline ? globalDeadline : perSessionDeadline;
                const isPastDeadline = now > deadline;
                const bookedCount = countMap.get(s.id) ?? 0;
                const isFull = bookedCount >= s.capacity;
                const alreadyBooked = myBookedIds.has(s.id);
                const waitlistEnabled = s.session_types?.enable_waitlist ?? false;
                const title = locale === 'ar' ? s.title_ar : s.title_en;
                const room = s.rooms ? (locale === 'ar' ? s.rooms.name_ar : s.rooms.name_en) : '';

                return (
                  <div className="flex h-full flex-col gap-0.5 overflow-hidden p-1.5 text-white">
                    <span className="truncate text-xs font-semibold">{title}</span>
                    {room && <span className="truncate text-[10px] opacity-80">{room}</span>}
                    <div className="mt-auto">
                      {alreadyBooked ? (
                        <span className="text-[10px] font-medium">✓ Booked</span>
                      ) : isFull && waitlistEnabled && (myWaitlistedIds.has(s.id) || !isPastDeadline) ? (
                        // Deadline only gates *joining*: join_waitlist rejects a
                        // past-deadline join server-side, so without this guard a
                        // full+waitlist-enabled session past its deadline would
                        // show an active "Join waitlist" button guaranteed to
                        // fail on click -- falling through to BookButton below
                        // correctly renders its existing "Closed" state instead.
                        // But leave_waitlist has NO deadline check (withdrawing
                        // is always allowed), so an already-waitlisted
                        // participant must still see their "Leave waitlist"
                        // control even past the deadline -- hence the
                        // myWaitlistedIds.has(s.id) escape hatch here.
                        //
                        // `compact` here renders a small underlined-text
                        // control instead of the full <Button size="sm">
                        // (px-3/py-1.5, 32px+ tall) -- see booking-button.tsx's
                        // `compact` doc. The grid block this lives inside can
                        // be as short as ~20px (a 15-minute slot), too short
                        // for the roomy card-era button.
                        <WaitlistButton
                          sessionId={s.id}
                          isWaitlisted={myWaitlistedIds.has(s.id)}
                          isPastDeadline={isPastDeadline}
                          compact
                        />
                      ) : (
                        <BookButton sessionId={s.id} isFull={isFull} isPastDeadline={isPastDeadline} compact />
                      )}
                    </div>
                  </div>
                );
              }}
            />
          )}
        </DayTabs>
      )}
    </div>
  );
}

function distinctTracksForGrid(
  sessions: { track_id: string; tracks: { color: string | null; name_en: string; name_ar: string } | null }[],
  locale: string
) {
  const seen = new Map<string, { id: string; name: string; color: string }>();
  for (const s of sessions) {
    if (!s.tracks || seen.has(s.track_id)) continue;
    seen.set(s.track_id, { id: s.track_id, name: locale === 'ar' ? s.tracks.name_ar : s.tracks.name_en, color: s.tracks.color ?? '#6b7280' });
  }
  return [...seen.values()];
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
