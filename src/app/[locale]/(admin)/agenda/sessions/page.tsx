// src/app/[locale]/(admin)/agenda/sessions/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole, SESSION_STATUSES } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

const PAGE_SIZE = 50;

const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  draft: 'neutral',
  published: 'pending',
  confirmed: 'changed',
  cancelled: 'cancelled',
  completed: 'elective',
};

export default async function SessionsListPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; day?: string; track?: string; room?: string; status?: string }>;
}) {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !(isAgendaStaffRole(profile.role) || isProgramAttendanceStaffRole(profile.role))) {
    notFound();
  }

  const params = await searchParams;
  const requestedPage = Math.max(1, Number(params.page) || 1);

  // Session client is sufficient for every query on this page (both the
  // filter-dropdown lookups and the sessions list itself): `sessions_staff_all`
  // (supabase/migrations/20260723040000_sessions_rls_policies.sql) and the
  // reference-table policies (conference_days_staff_all, tracks_staff_all,
  // rooms_staff_all — supabase/migrations/20260722201600_agenda_reference_rls_policies.sql)
  // are all plain `current_user_role() in (...)` checks with no per-row owner
  // condition, unlike Phase 2's `profiles_select_own`. So there's no
  // other-users'-row problem for the caller's own session client to hit here —
  // same reasoning already verified live for Task 15's rooms/tracks/etc. list
  // pages. The service-role client above is still needed, but only for the
  // role-gate's `profiles` lookup.
  const [{ data: days }, { data: tracks }, { data: rooms }] = await Promise.all([
    supabase.from('conference_days').select('id, label_en, display_order').order('display_order', { ascending: true }),
    supabase.from('tracks').select('id, name_en').order('name_en', { ascending: true }),
    supabase.from('rooms').select('id, name_en').order('name_en', { ascending: true }),
  ]);

  let countQuery = supabase.from('sessions').select('id', { count: 'exact', head: true });
  let dataQuery = supabase
    .from('sessions')
    .select(
      'id, session_code, title_en, start_time, end_time, status, capacity, conference_day:conference_days(label_en), track:tracks(name_en), room:rooms(name_en)'
    )
    .order('start_time', { ascending: true })
    .order('id', { ascending: true });

  // All four filters below are ID/enum exact-match filters (dropdown-driven,
  // not free text), so Phase 2's `.or()` comma/paren sanitization lesson
  // (src/app/[locale]/(admin)/applications/page.tsx) doesn't apply here —
  // there's no free-text search param on this page to sanitize.
  if (params.day) {
    countQuery = countQuery.eq('conference_day_id', params.day);
    dataQuery = dataQuery.eq('conference_day_id', params.day);
  }
  if (params.track) {
    countQuery = countQuery.eq('track_id', params.track);
    dataQuery = dataQuery.eq('track_id', params.track);
  }
  if (params.room) {
    countQuery = countQuery.eq('room_id', params.room);
    dataQuery = dataQuery.eq('room_id', params.room);
  }
  if (params.status && (SESSION_STATUSES as readonly string[]).includes(params.status)) {
    const status = params.status as (typeof SESSION_STATUSES)[number];
    countQuery = countQuery.eq('status', status);
    dataQuery = dataQuery.eq('status', status);
  }

  // Count first (cheap, head:true) so `page` can be clamped to a range that
  // actually exists before `.range()` runs — see Phase 2's applications list
  // page for the PGRST103 "Requested range not satisfiable" failure mode this
  // avoids.
  const { count } = await countQuery;
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data: sessions } = await dataQuery.range(from, to);

  const filterQuery = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { day: params.day, track: params.track, room: params.room, status: params.status, ...overrides };
    for (const [key, value] of Object.entries(merged)) {
      if (value) next.set(key, value);
    }
    const qs = next.toString();
    return qs ? `/agenda/sessions?${qs}` : '/agenda/sessions';
  };

  const t = await getTranslations({ locale, namespace: 'agenda.sessions' });

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between gap-3 md:mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <Link
          href="/agenda/sessions/new"
          className="inline-flex items-center justify-center gap-2 rounded-md bg-turquoise px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-turquoise/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise focus-visible:ring-offset-2"
        >
          {t('newSession')}
        </Link>
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900 md:mb-6">
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filters.day')}
          <select
            name="day"
            defaultValue={params.day ?? ''}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('filters.all')}</option>
            {days?.map((day) => (
              <option key={day.id} value={day.id}>{day.label_en}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filters.track')}
          <select
            name="track"
            defaultValue={params.track ?? ''}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('filters.all')}</option>
            {tracks?.map((track) => (
              <option key={track.id} value={track.id}>{track.name_en}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filters.room')}
          <select
            name="room"
            defaultValue={params.room ?? ''}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('filters.all')}</option>
            {rooms?.map((room) => (
              <option key={room.id} value={room.id}>{room.name_en}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filters.status')}
          <select
            name="status"
            defaultValue={params.status ?? ''}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('filters.all')}</option>
            {SESSION_STATUSES.map((status) => (
              <option key={status} value={status}>{t(`statusValues.${status}`)}</option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-2 rounded-md bg-turquoise px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-turquoise/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise focus-visible:ring-offset-2"
        >
          {t('filters.apply')}
        </button>
        <Link href="/agenda/sessions" className="text-sm font-medium text-turquoise hover:underline">
          {t('filters.clear')}
        </Link>
      </form>

      {!sessions || sessions.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-session list. Desktop (md+): table. Both trees
              render the same `sessions` data and must be kept in sync — any
              column added to one must be added to the other. */}
          <div className="flex flex-col gap-2 md:hidden">
            {sessions.map((session) => (
              <Card key={session.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/agenda/sessions/${session.id}`} className="text-sm font-medium text-turquoise hover:underline">
                    {session.session_code}
                  </Link>
                  <Badge variant={STATUS_BADGE_VARIANT[session.status] ?? 'neutral'}>
                    {t(`statusValues.${session.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-charcoal dark:text-gray-100">{session.title_en}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-charcoal/60 dark:text-gray-400">
                  <span>{session.conference_day?.label_en}</span>
                  <span>
                    {new Date(session.start_time).toLocaleTimeString('en-US', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit' })}
                    –
                    {new Date(session.end_time).toLocaleTimeString('en-US', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span>{session.track?.name_en}</span>
                  <span>{session.room?.name_en}</span>
                  <span>{t('capacity')}: {session.capacity}</span>
                </div>
              </Card>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('code')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('titleColumn')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('day')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('time')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('track')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('room')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('capacity')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="px-4 py-2">
                      <Link href={`/agenda/sessions/${session.id}`} className="text-sm font-medium text-turquoise hover:underline">
                        {session.session_code}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{session.title_en}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{session.conference_day?.label_en}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                      {new Date(session.start_time).toLocaleTimeString('en-US', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit' })}
                      –
                      {new Date(session.end_time).toLocaleTimeString('en-US', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{session.track?.name_en}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{session.room?.name_en}</td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_BADGE_VARIANT[session.status] ?? 'neutral'}>
                        {t(`statusValues.${session.status}`)}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{session.capacity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-charcoal/70 dark:text-gray-400">
            <p>{t('pageOf', { page, totalPages })}</p>
            {page > 1 && (
              <Link href={filterQuery({ page: String(page - 1) })} className="font-medium text-turquoise hover:underline">
                {t('previous')}
              </Link>
            )}
            {page < totalPages && (
              <Link href={filterQuery({ page: String(page + 1) })} className="font-medium text-turquoise hover:underline">
                {t('next')}
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
