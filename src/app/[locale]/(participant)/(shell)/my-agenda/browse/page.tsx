import { getLocale } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { MountReveal } from '@/components/motion/mount-reveal';
import { BrowseGridClient, type BrowseDayData } from './browse-grid-client';

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
      room_id,
      title_en,
      title_ar,
      start_time,
      end_time,
      booking_deadline,
      capacity,
      rooms ( name_en, name_ar ),
      tracks ( color, name_en, name_ar ),
      conference_days ( conference_date, label_en, label_ar, display_order ),
      session_types ( code, enable_waitlist ),
      session_people ( people ( full_name_en, full_name_ar ) )
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
        (() => {
          // All per-session booking-state booleans (isPastDeadline, isFull,
          // alreadyBooked, showWaitlistButton, isWaitlisted) are precomputed
          // HERE, server-side, into plain data -- see browse-grid-client.tsx's
          // own header comment for why: a function/JSX value built here can
          // never be passed as a prop into BrowseGridClient ('use client'),
          // only plain, JSON-serializable data can. This fixes a real
          // production bug (the equivalent one already found and fixed on
          // the admin Sessions page) that was present but never yet
          // exercised here, since all real sessions are currently
          // status='draft' and this page only shows published/confirmed
          // ones -- byDay was always empty in production so far.
          const dayData: BrowseDayData[] = byDay.map((day) => ({
            date: day.date,
            labelEn: day.labelEn,
            labelAr: day.labelAr,
            rooms: distinctRoomsForGrid(day.sessions, locale),
            legendItems: distinctTracksForLegend(day.sessions, locale),
            sessions: day.sessions.map((s) => {
              const perSessionDeadline = s.booking_deadline
                ? new Date(s.booking_deadline)
                : new Date(new Date(s.start_time).getTime() - 3 * 60 * 60 * 1000);
              const deadline = globalDeadline && globalDeadline < perSessionDeadline ? globalDeadline : perSessionDeadline;
              const isPastDeadline = now > deadline;
              const bookedCount = countMap.get(s.id) ?? 0;
              const isFull = bookedCount >= s.capacity;
              const alreadyBooked = myBookedIds.has(s.id);
              const isWaitlisted = myWaitlistedIds.has(s.id);
              const waitlistEnabled = s.session_types?.enable_waitlist ?? false;
              // Deadline only gates *joining*: join_waitlist rejects a
              // past-deadline join server-side, so without this guard a
              // full+waitlist-enabled session past its deadline would show
              // an active "Join waitlist" button guaranteed to fail on
              // click -- falling through to BookButton instead correctly
              // shows its existing "Closed" state. But leave_waitlist has
              // NO deadline check (withdrawing is always allowed), so an
              // already-waitlisted participant must still see their "Leave
              // waitlist" control even past the deadline -- hence the
              // isWaitlisted escape hatch here.
              const showWaitlistButton = isFull && waitlistEnabled && (isWaitlisted || !isPastDeadline);

              return {
                id: s.id,
                roomId: s.room_id,
                trackId: s.track_id,
                blockColor: s.tracks?.color ?? '#6b7280',
                startTime: s.start_time,
                endTime: s.end_time,
                title: locale === 'ar' ? s.title_ar : s.title_en,
                isBreak: s.session_types?.code === 'BRK',
                speakerNames: (s.session_people ?? [])
                  .map((sp: { people: { full_name_en: string; full_name_ar: string } | null }) =>
                    locale === 'ar' ? sp.people?.full_name_ar : sp.people?.full_name_en
                  )
                  .filter((n: string | undefined): n is string => Boolean(n)),
                alreadyBooked,
                showWaitlistButton,
                isWaitlisted,
                isFull,
                isPastDeadline,
              };
            }),
          }));

          return (
            <BrowseGridClient
              days={dayData}
              locale={locale}
              emptyDayLabel="No sessions this day yet."
              otherColumnLabel={locale === 'ar' ? 'أخرى' : 'Other'}
              zoomOutLabel={locale === 'ar' ? 'تصغير' : 'Zoom out'}
              zoomInLabel={locale === 'ar' ? 'تكبير' : 'Zoom in'}
              gridViewLabel="Grid"
              timelineViewLabel="Timeline"
              allTracksLabel="All tracks"
              searchPlaceholder="Search by title or speaker"
            />
          );
        })()
      )}
    </div>
  );
}

// Columns are ROOMS now (2026-11-01 change, see agenda-time-grid.tsx's
// own header comment for the full "columns vs. color" reasoning) --
// each session's track color moves to its block instead, via blockColor
// in the sessions map passed to AgendaTimeGrid below.
// Color-key legend data: distinct tracks actually present among this
// day's sessions (track_id, locale-aware name, real color), for
// AgendaColorLegend. Scoped per-day (not globally across all days) since
// the grid/legend only ever shows one active day at a time here.
function distinctTracksForLegend(
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

function distinctRoomsForGrid(
  sessions: { room_id: string; rooms: { name_en: string; name_ar: string } | null }[],
  locale: string
) {
  const seen = new Map<string, { id: string; name: string }>();
  for (const s of sessions) {
    if (!s.rooms || seen.has(s.room_id)) continue;
    seen.set(s.room_id, { id: s.room_id, name: locale === 'ar' ? s.rooms.name_ar : s.rooms.name_en });
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
