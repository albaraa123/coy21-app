// src/app/[locale]/(admin)/allocation/clustering/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import ClusterList from './cluster-list';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function ClusteringPage() {
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

  const [{ data: runs }, { data: extractionRuns }, { data: clusters }, { data: memberships }] = await Promise.all([
    supabase
      .from('clustering_runs')
      .select('id, feature_extraction_run_id, k, random_seed, status, run_at')
      .order('run_at', { ascending: false }),
    supabase
      .from('feature_extraction_runs')
      .select('id, rules_version, application_count, run_at')
      .order('run_at', { ascending: false }),
    supabase
      .from('clusters')
      .select('id, clustering_run_id, label, member_count')
      .order('label', { ascending: true }),
    supabase
      .from('cluster_memberships')
      .select('id, cluster_id, application_id, distance_to_centroid')
      .order('distance_to_centroid', { ascending: true }),
  ]);

  const t = await getTranslations({ locale, namespace: 'allocation.clustering' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <ClusterList
        runs={runs ?? []}
        extractionRuns={extractionRuns ?? []}
        clusters={clusters ?? []}
        memberships={memberships ?? []}
      />
    </div>
  );
}
