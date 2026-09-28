// src/app/[locale]/(admin)/allocation/schedules/participants/[applicationId]/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import RevisionHistory from './revision-history';

export default async function ParticipantScheduleHistoryPage({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const locale = await getLocale();
  const { applicationId } = await params;
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

  const { data: publications } = await supabase
    .from('schedule_publications')
    .select('id, application_id, allocation_run_id, revision_number, status, source_fingerprint, published_at, published_by')
    .eq('application_id', applicationId)
    .order('revision_number', { ascending: true });

  if (!publications || publications.length === 0) notFound();

  const publicationIds = publications.map((p) => p.id);
  const { data: items } = await supabase
    .from('schedule_publication_items')
    .select(
      'id, schedule_publication_id, session_id, session_title_ar, session_title_en, room_name_ar, room_name_en, start_time, end_time, is_mandatory, item_status, suitability_score, explanation_summary, gap_reason, speakers'
    )
    .in('schedule_publication_id', publicationIds);

  const t = await getTranslations({ locale, namespace: 'allocation.schedulePublication.participantDetail' });

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title', { id: applicationId })}</h1>
        <Link href="/allocation/schedules" className="mt-2 inline-block text-sm text-turquoise hover:underline">
          {t('backToOverview')}
        </Link>
      </div>

      <RevisionHistory publications={publications} items={items ?? []} />
    </div>
  );
}
