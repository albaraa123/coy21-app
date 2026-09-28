// src/app/[locale]/(admin)/allocation/schedules/stage/draft/[draftId]/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import DraftReview from '../../[allocationRunId]/draft-review';

export default async function StageDraftPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const locale = await getLocale();
  const { draftId } = await params;
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

  // Drafts staged from the changed-schedules queue (via
  // triggerStageFromChangeEvents) have allocation_run_id = null and
  // triggered_by_change_event_ids set instead (schema constraint:
  // schedule_publication_drafts_one_source). This page looks the draft up
  // directly by its own id rather than via an allocation run.
  const { data: draft } = await supabase
    .from('schedule_publication_drafts')
    .select('id, status, staged_at, staged_by, source_fingerprint')
    .eq('id', draftId)
    .maybeSingle();
  if (!draft) notFound();

  const { data: draftItems } = await supabase
    .from('schedule_publication_draft_items')
    .select('id, application_id, verdict, blocker_details, resolution, override_reason, reassigned_session_id')
    .eq('schedule_publication_draft_id', draft.id);

  // low_confidence allocation_issues rows are keyed to allocation_run_id
  // and are only ever produced/consumed on the run-publish path —
  // stage_publication_transactional's change-propagation branch explicitly
  // does not use allocation_issues (see its inline comment: "not by
  // allocation_issues (which don't apply to a change-propagation batch)").
  // This draft has no allocation_run_id, so there is nothing to query here.
  const t = await getTranslations({ locale, namespace: 'allocation.schedulePublication.draftDetail' });

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title', { id: draft.id })}</h1>
        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">{t('sourceChangePropagation')}</p>
        <Link href="/allocation/schedules" className="mt-2 inline-block text-sm text-turquoise hover:underline">
          {t('backToOverview')}
        </Link>
      </div>

      <DraftReview
        draft={draft}
        draftItems={draftItems ?? []}
        lowConfidenceIssues={[]}
      />
    </div>
  );
}
