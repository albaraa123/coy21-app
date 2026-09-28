// src/app/[locale]/(admin)/allocation/schedules/changed/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import ChangedQueue from './changed-queue';

export default async function ChangedSchedulesQueuePage() {
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

  const [{ data: unprocessedEvents }, { data: staleItems }] = await Promise.all([
    supabase
      .from('schedule_change_events')
      .select('id, session_id, change_type, detected_at, sessions(id, session_code, title_en)')
      .is('processed_at', null)
      .order('detected_at', { ascending: false }),
    supabase
      .from('schedule_publication_items')
      .select(
        'id, session_id, item_status, session_title_en, room_name_en, start_time, end_time, schedule_publication_id, schedule_publications!inner(id, application_id, status)'
      )
      .in('item_status', ['stale', 'pending_review'])
      .eq('schedule_publications.status', 'active'),
  ]);

  // For each session_id represented among the stale/pending_review items,
  // find the most recently processed change events (one per change_type)
  // that could have caused the current staleness. These are passed to
  // triggerStageFromChangeEvents so the RPC can resolve the affected
  // session set (see changed-queue.tsx for the correlation rationale).
  const affectedSessionIds = [...new Set((staleItems ?? []).map((item) => item.session_id).filter((id): id is string => !!id))];
  const { data: processedEvents } = affectedSessionIds.length
    ? await supabase
        .from('schedule_change_events')
        .select('id, session_id, change_type, detected_at')
        .in('session_id', affectedSessionIds)
        .not('processed_at', 'is', null)
        .order('detected_at', { ascending: false })
    : { data: [] as never[] };

  const t = await getTranslations({ locale, namespace: 'allocation.schedulePublication.changed' });

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <Link href="/allocation/schedules" className="mt-2 inline-block text-sm text-turquoise hover:underline">
          {t('backToOverview')}
        </Link>
      </div>

      <ChangedQueue
        unprocessedEvents={unprocessedEvents ?? []}
        staleItems={staleItems ?? []}
        processedEvents={processedEvents ?? []}
      />
    </div>
  );
}
