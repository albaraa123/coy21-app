import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AgendaDay } from './agenda-day';

export default async function MyAgendaPage() {
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

  // Fetch active bookings with full session + room + day info
  const { data: bookings } = await supabase
    .from('session_bookings')
    .select(`
      id,
      session_id,
      booked_at,
      sessions (
        id,
        title_en,
        title_ar,
        start_time,
        end_time,
        booking_deadline,
        capacity,
        rooms ( name_en, name_ar ),
        tracks ( color ),
        conference_days ( conference_date, label_en, label_ar, display_order )
      )
    `)
    .eq('application_id', application.id)
    .eq('status', 'active')
    .order('booked_at');

  const sessionsByDay = groupByDay(bookings ?? []);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6 md:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-charcoal dark:text-gray-100">My Agenda</h1>
        <Button href="/my-agenda/browse" size="sm" variant="secondary">
          Browse sessions
        </Button>
      </div>

      {sessionsByDay.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-charcoal/70 dark:text-gray-400">
            You have no sessions booked yet.
          </p>
          <Button href="/my-agenda/browse" size="sm">
            Browse &amp; book sessions
          </Button>
        </Card>
      ) : (
        sessionsByDay.map((day) => (
          <AgendaDay
            key={day.date}
            date={day.date}
            label={locale === 'ar' ? day.labelAr : day.labelEn}
            bookings={day.bookings}
            locale={locale}
            applicationId={application.id}
          />
        ))
      )}
    </div>
  );
}

// Group bookings by conference day, sorted by day display_order then session start_time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function groupByDay(bookings: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = new Map<string, { date: string; labelEn: string; labelAr: string; order: number; bookings: any[] }>();
  for (const b of bookings) {
    const day = b.sessions?.conference_days;
    if (!day) continue;
    if (!map.has(day.conference_date)) {
      map.set(day.conference_date, { date: day.conference_date, labelEn: day.label_en, labelAr: day.label_ar, order: day.display_order, bookings: [] });
    }
    map.get(day.conference_date)!.bookings.push(b);
  }
  return [...map.values()]
    .sort((a, b) => a.order - b.order)
    .map((d) => ({ ...d, bookings: d.bookings.sort((a: { sessions: { start_time: string } | null }, b: { sessions: { start_time: string } | null }) => (a.sessions?.start_time ?? '').localeCompare(b.sessions?.start_time ?? '')) }));
}
