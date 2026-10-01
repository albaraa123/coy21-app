// src/app/[locale]/(admin)/allocation/runs/[id]/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Badge } from '@/components/ui/badge';
import AssignmentTable from './assignment-table';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function AllocationRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const locale = await getLocale();
  const { id } = await params;
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

  const { data: run } = await supabase
    .from('allocation_runs')
    .select('id, status, run_at, confirmed_at, feature_extraction_run_id')
    .eq('id', id)
    .single();
  if (!run) notFound();

  const [{ data: assignments }, { data: issues }] = await Promise.all([
    supabase
      .from('allocation_assignments')
      .select(
        'id, application_id, session_id, time_slot_group_key, suitability_score, is_low_confidence, is_mandatory_assignment, is_manual_override, override_reason, status, sessions(id, session_code, title_en)'
      )
      .eq('allocation_run_id', id)
      .order('suitability_score', { ascending: true }),
    supabase
      .from('allocation_issues')
      .select('id, issue_type, application_id, session_id, details')
      .eq('allocation_run_id', id),
  ]);

  // Fetch explanations and alternatives for all assignments in this run so the
  // per-assignment detail view can render them without an extra round trip.
  const assignmentIds = (assignments ?? []).map((a) => a.id);
  const [{ data: explanations }, { data: alternatives }] = await Promise.all([
    assignmentIds.length
      ? supabase
          .from('allocation_assignment_explanations')
          .select('id, allocation_assignment_id, constraint_type, passed, detail')
          .in('allocation_assignment_id', assignmentIds)
      : Promise.resolve({ data: [] as never[] }),
    assignmentIds.length
      ? supabase
          .from('allocation_alternatives')
          .select('id, allocation_assignment_id, session_id, suitability_score, rank, sessions(id, session_code, title_en)')
          .in('allocation_assignment_id', assignmentIds)
          .order('rank', { ascending: true })
      : Promise.resolve({ data: [] as never[] }),
  ]);

  // Group issues by type for the summary.
  const issueSummary = (issues ?? []).reduce<Record<string, number>>((acc, issue) => {
    acc[issue.issue_type] = (acc[issue.issue_type] ?? 0) + 1;
    return acc;
  }, {});

  const t = await getTranslations({ locale, namespace: 'allocation.runs.detail' });
  const STATUS_LABEL_KEY: Record<string, 'draft' | 'confirmed' | 'discarded'> = {
    draft: 'draft',
    confirmed: 'confirmed',
    discarded: 'discarded',
  };
  const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
    draft: 'pending',
    confirmed: 'changed',
    discarded: 'cancelled',
  };

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 md:mb-6">
        <div>
          <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title', { id: run.id })}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-charcoal/70 dark:text-gray-400">
            <Badge variant={STATUS_BADGE_VARIANT[run.status] ?? 'neutral'}>
              {run.status in STATUS_LABEL_KEY ? t(`statusValues.${STATUS_LABEL_KEY[run.status]}`) : run.status}
            </Badge>
            <span>{t('runAt', { runAt: new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }) })}</span>
            {run.confirmed_at && (
              <span>
                {t('confirmedAt', { confirmedAt: new Date(run.confirmed_at).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }) })}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Link href={`/allocation/runs/${run.id}/capacity`} className="text-sm text-turquoise hover:underline">
            {t('viewCapacity')}
          </Link>
          <a href={`/allocation/runs/${run.id}/export`} className="text-sm text-turquoise hover:underline">
            {t('exportCsv')}
          </a>
        </div>
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('issuesSummary.title')}</h2>
        {Object.keys(issueSummary).length === 0 ? (
          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('issuesSummary.empty')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {Object.entries(issueSummary).map(([type, count]) => (
              <li key={type}>
                <Badge variant="mandatory">
                  {type}: {t('issuesSummary.count', { count })}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AssignmentTable
        runId={run.id}
        runStatus={run.status}
        assignments={assignments ?? []}
        explanations={explanations ?? []}
        alternatives={alternatives ?? []}
      />
    </div>
  );
}
