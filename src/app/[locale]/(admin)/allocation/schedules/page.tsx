// src/app/[locale]/(admin)/allocation/schedules/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import RunList from './run-list';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function SchedulePublicationOverviewPage() {
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

  const [{ data: runs }, { data: drafts }] = await Promise.all([
    supabase
      .from('allocation_runs')
      .select('id, status, run_at, confirmed_at')
      .eq('status', 'confirmed')
      .order('run_at', { ascending: false }),
    supabase
      .from('schedule_publication_drafts')
      .select('id, allocation_run_id, status')
      .not('allocation_run_id', 'is', null),
  ]);

  // A run is "fully published" once it has a confirmed draft. Runs with no
  // draft yet, or only a staged/expired/discarded draft, still need staging
  // or review, so they remain in the list.
  const confirmedRunIds = new Set(
    (drafts ?? []).filter((d) => d.status === 'confirmed').map((d) => d.allocation_run_id)
  );
  const pendingRuns = (runs ?? []).filter((run) => !confirmedRunIds.has(run.id));

  const t = await getTranslations({ locale, namespace: 'allocation.schedulePublication.overview' });

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
        <Link href="/allocation/schedules/changed" className="mt-2 inline-block text-sm text-turquoise hover:underline">
          {t('changeQueueLink')}
        </Link>
      </div>

      <RunList runs={pendingRuns} />
    </div>
  );
}
