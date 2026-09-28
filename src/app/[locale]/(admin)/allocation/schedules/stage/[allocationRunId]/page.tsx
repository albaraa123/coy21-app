// src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import DraftReview from './draft-review';

export default async function StagePublicationPage({
  params,
}: {
  params: Promise<{ allocationRunId: string }>;
}) {
  const locale = await getLocale();
  const { allocationRunId } = await params;
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

  const { data: run } = await supabase
    .from('allocation_runs')
    .select('id, status, run_at, confirmed_at')
    .eq('id', allocationRunId)
    .single();
  if (!run) notFound();

  // A run can have multiple drafts staged over time (e.g. re-staged after a
  // change). The most recently staged draft is the one under review here.
  const { data: draft } = await supabase
    .from('schedule_publication_drafts')
    .select('id, status, staged_at, staged_by, source_fingerprint')
    .eq('allocation_run_id', allocationRunId)
    .order('staged_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: draftItems } = draft
    ? await supabase
        .from('schedule_publication_draft_items')
        .select('id, application_id, verdict, blocker_details, resolution, override_reason, reassigned_session_id')
        .eq('schedule_publication_draft_id', draft.id)
    : { data: [] as never[] };

  const { data: lowConfidenceIssues } = await supabase
    .from('allocation_issues')
    .select('id, issue_type, application_id, session_id, details')
    .eq('allocation_run_id', allocationRunId)
    .eq('issue_type', 'low_confidence');

  const t = await getTranslations({ locale, namespace: 'allocation.schedulePublication.stage' });

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title', { id: run.id })}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-charcoal/70 dark:text-gray-400">
          <span>{t('runStatus', { status: run.status })}</span>
          <span>{t('runAt', { runAt: new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' }) })}</span>
        </div>
        <Link href="/allocation/schedules" className="mt-2 inline-block text-sm text-turquoise hover:underline">
          {t('backToOverview')}
        </Link>
      </div>

      <DraftReview
        allocationRunId={run.id}
        draft={draft ?? null}
        draftItems={draftItems ?? []}
        lowConfidenceIssues={lowConfidenceIssues ?? []}
      />
    </div>
  );
}
