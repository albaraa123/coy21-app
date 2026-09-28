// src/app/[locale]/(admin)/allocation/runs/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import RunList from './run-list';

export default async function AllocationRunsPage() {
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

  const [{ data: runs }, { data: extractionRuns }] = await Promise.all([
    supabase
      .from('allocation_runs')
      .select('id, status, run_at, confirmed_at')
      .order('run_at', { ascending: false }),
    supabase
      .from('feature_extraction_runs')
      .select('id, rules_version, application_count, run_at')
      .order('run_at', { ascending: false }),
  ]);

  const t = await getTranslations({ locale, namespace: 'allocation.runs.list' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <RunList runs={runs ?? []} extractionRuns={extractionRuns ?? []} />
    </div>
  );
}
