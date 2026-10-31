// src/app/[locale]/(admin)/agenda/sessions/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { SESSION_STATUSES } from '@/lib/validation/agenda';
import { EmptyState } from '@/components/ui/empty-state';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { MountReveal } from '@/components/motion/mount-reveal';
import { SessionsGridClient, type DayGroupData } from './sessions-grid-client';
import type { BadgeVariant } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';

const PAGE_SIZE = 50;

// Groups by the session's real conference_day_id (added to the select above
// specifically for this) rather than deriving a calendar date from
// start_time -- the latter would be UTC-based and could misgroup a session
// near local midnight relative to the venue's actual timezone
// (Europe/Istanbul). Grouping by the real foreign key sidesteps that
// entirely: no timezone math needed to know which day a session belongs to,
// the database already knows.
function groupSessionsByDay<T extends { conference_day_id: string; conference_day: { label_en: string } | null }>(
  sessions: T[],
  unscheduledLabel: string
): { dayId: string; label: string; sessions: T[] }[] {
  const map = new Map<string, { dayId: string; label: string; sessions: T[] }>();
  for (const s of sessions) {
    if (!map.has(s.conference_day_id)) {
      map.set(s.conference_day_id, { dayId: s.conference_day_id, label: s.conference_day?.label_en ?? unscheduledLabel, sessions: [] });
    }
    map.get(s.conference_day_id)!.sessions.push(s);
  }
  return [...map.values()];
}

const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
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
  if (!profile || !isStaffRole(profile.role)) {
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
    supabase.from('tracks').select('id, name_en, color').order('name_en', { ascending: true }),
    supabase.from('rooms').select('id, name_en').order('name_en', { ascending: true }),
  ]);

  let countQuery = supabase.from('sessions').select('id', { count: 'exact', head: true });
  let dataQuery = supabase
    .from('sessions')
    .select(
      'id, session_code, title_en, start_time, end_time, status, capacity, track_id, room_id, conference_day_id, conference_day:conference_days(label_en), track:tracks(name_en, color), room:rooms(name_en), session_type:session_types(code), session_people (people (full_name_en, full_name_ar))'
    )
    .order('start_time', { ascending: true })
    .order('session_code', { ascending: true });

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
          <Select
            name="day"
            defaultValue={params.day ?? ''}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('filters.all')}</option>
            {days?.map((day) => (
              <option key={day.id} value={day.id}>{day.label_en}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filters.track')}
          <Select
            name="track"
            defaultValue={params.track ?? ''}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('filters.all')}</option>
            {tracks?.map((track) => (
              <option key={track.id} value={track.id}>{track.name_en}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filters.room')}
          <Select
            name="room"
            defaultValue={params.room ?? ''}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('filters.all')}</option>
            {rooms?.map((room) => (
              <option key={room.id} value={room.id}>{room.name_en}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('filters.status')}
          <Select
            name="status"
            defaultValue={params.status ?? ''}
            className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">{t('filters.all')}</option>
            {SESSION_STATUSES.map((status) => (
              <option key={status} value={status}>{t(`statusValues.${status}`)}</option>
            ))}
          </Select>
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
        <MountReveal delayMs={0}>
          {/* All data for the grid (status labels/variants, room/column
              lists, day grouping) is fully resolved here, server-side,
              into plain JSON-serializable objects (DayGroupData[]) BEFORE
              handing off to SessionsGridClient ('use client', owns the
              zoom state). This is a deliberate fix for a real production
              bug: an earlier version passed a function (a render-prop)
              from this Server Component into a 'use client' zoom wrapper,
              which is not legal RSC composition and broke in production
              despite passing local typecheck -- see sessions-grid-
              client.tsx's own header comment for the full story. Never
              pass a function value into a 'use client' component's props
              from here; only plain data. */}
          {(() => {
            const dayGroups = groupSessionsByDay(sessions, t('unscheduled'));
            const dayGroupData: DayGroupData[] = dayGroups.map((dayGroup) => ({
              dayId: dayGroup.dayId,
              label: dayGroup.label,
              rooms: (rooms ?? [])
                .filter((r) => dayGroup.sessions.some((s) => s.room_id === r.id))
                .map((r) => ({ id: r.id, name: r.name_en })),
              sessions: dayGroup.sessions.map((s) => ({
                id: s.id,
                roomId: s.room_id,
                trackId: s.track_id,
                blockColor: s.track?.color ?? '#6b7280',
                startTime: s.start_time,
                endTime: s.end_time,
                sessionCode: s.session_code,
                titleEn: s.title_en,
                statusLabel: t(`statusValues.${s.status}`),
                statusVariant: STATUS_BADGE_VARIANT[s.status] ?? 'neutral',
                isBreak: s.session_type?.code === 'BRK',
                speakerNames: (s.session_people ?? [])
                  .map((sp: { people: { full_name_en: string; full_name_ar: string } | null }) =>
                    locale === 'ar' ? sp.people?.full_name_ar : sp.people?.full_name_en
                  )
                  .filter((n: string | undefined): n is string => Boolean(n)),
              })),
            }));
            return (
              <SessionsGridClient
                dayGroups={dayGroupData}
                showDayHeading={dayGroups.length > 1}
                otherColumnLabel={t('otherTrack')}
                zoomOutLabel={t('zoomOut')}
                zoomInLabel={t('zoomIn')}
                legendItems={(tracks ?? []).map((tr) => ({ id: tr.id, name: tr.name_en, color: tr.color ?? '#6b7280' }))}
                gridViewLabel={t('gridView')}
                timelineViewLabel={t('timelineView')}
                allTracksLabel={t('allTracks')}
                searchPlaceholder={t('searchPlaceholder')}
                resultCountSingularLabel={t('resultCountSingular')}
                resultCountPluralLabel={t('resultCountPlural')}
                timelineEmptyTitle={t('emptyTitle')}
                timelineEmptyDescription={t('emptyDescription')}
              />
            );
          })()}
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
        </MountReveal>
      )}
    </div>
  );
}
