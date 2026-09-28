'use client';

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { triggerClusteringRun } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type ClusteringRun = {
  id: string;
  feature_extraction_run_id: string;
  k: number;
  random_seed: number;
  status: string;
  run_at: string;
};

type ExtractionRun = {
  id: string;
  rules_version: number;
  application_count: number;
  run_at: string;
};

type Cluster = {
  id: string;
  clustering_run_id: string;
  label: string | null;
  member_count: number;
};

type Membership = {
  id: string;
  cluster_id: string;
  application_id: string;
  distance_to_centroid: number;
};

type FormState = {
  featureExtractionRunId: string;
  k: string;
  randomSeed: string;
};

const EMPTY_FORM: FormState = {
  featureExtractionRunId: '',
  k: '',
  randomSeed: '',
};

// clustering_runs.status is constrained at the DB level to
// ('completed', 'failed') — see supabase/migrations/20260723090000_clustering_tables.sql.
const STATUS_BADGE_VARIANT: Record<string, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  completed: 'changed',
  failed: 'cancelled',
};

const inputClasses =
  'rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

export default function ClusterList({
  runs,
  extractionRuns,
  clusters,
  memberships,
}: {
  runs: ClusteringRun[];
  extractionRuns: ExtractionRun[];
  clusters: Cluster[];
  memberships: Membership[];
}) {
  const t = useTranslations('allocation.clustering');
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!form.featureExtractionRunId) {
        throw new Error(t('errors.extractionRunRequired'));
      }
      const k = Number(form.k);
      if (!Number.isInteger(k) || k <= 0) {
        throw new Error(t('errors.kInvalid'));
      }
      const randomSeed = Number(form.randomSeed);
      if (!Number.isInteger(randomSeed)) {
        throw new Error(t('errors.seedInvalid'));
      }
      await triggerClusteringRun({
        featureExtractionRunId: form.featureExtractionRunId,
        k,
        randomSeed,
      });
      setForm(EMPTY_FORM);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.runFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('newRunTitle')}</h2>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('extractionRun')}
          <select
            value={form.featureExtractionRunId}
            onChange={(e) => setForm({ ...form, featureExtractionRunId: e.target.value })}
            required
            className={inputClasses}
          >
            <option value="">{t('selectExtractionRun')}</option>
            {extractionRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {t('extractionRunOption', { id: run.id, version: run.rules_version, count: run.application_count })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('k')}
          <input
            type="number"
            min={1}
            step={1}
            value={form.k}
            onChange={(e) => setForm({ ...form, k: e.target.value })}
            required
            className={inputClasses}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('randomSeed')}
          <input
            type="number"
            step={1}
            value={form.randomSeed}
            onChange={(e) => setForm({ ...form, randomSeed: e.target.value })}
            required
            className={inputClasses}
          />
        </label>
        <div className="mt-2">
          <Button type="submit" disabled={submitting}>{t('runClustering')}</Button>
        </div>
      </form>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-charcoal dark:text-gray-100">{t('runsTitle')}</h2>

        {runs.length === 0 ? (
          <EmptyState title={t('emptyRunsTitle')} description={t('emptyRunsDescription')} />
        ) : (
          <div className="flex flex-col gap-4">
            {runs.map((run) => {
              const runClusters = clusters.filter((c) => c.clustering_run_id === run.id);
              return (
                <Card key={run.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-charcoal dark:text-gray-100">
                      {t('runLabel', { id: run.id })}
                    </h3>
                    <Badge variant={STATUS_BADGE_VARIANT[run.status] ?? 'neutral'}>
                      {run.status in STATUS_BADGE_VARIANT ? t(`statusValues.${run.status}` as 'statusValues.completed' | 'statusValues.failed') : run.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                    {t('runMeta', {
                      k: run.k,
                      seed: run.random_seed,
                      runAt: new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' }),
                    })}
                  </p>

                  {runClusters.length === 0 ? (
                    <p className="mt-3 text-sm text-charcoal/60 dark:text-gray-400">{t('noClusters')}</p>
                  ) : (
                    <>
                      {/* Mobile: card-per-cluster list. Desktop (md+): table.
                          Both trees render the same `runClusters` data and
                          must be kept in sync — any column added to one must
                          be added to the other. */}
                      <div className="mt-3 flex flex-col gap-2 md:hidden">
                        {runClusters.map((cluster) => (
                          <div key={cluster.id} className="rounded-md border border-charcoal/10 p-3 dark:border-gray-700">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                                {cluster.label ?? cluster.id}
                              </p>
                              <span className="text-sm text-charcoal/70 dark:text-gray-400">
                                {t('membersCount', { count: cluster.member_count })}
                              </span>
                            </div>
                            <div className="mt-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                type="button"
                                onClick={() => setExpandedCluster(expandedCluster === cluster.id ? null : cluster.id)}
                              >
                                {expandedCluster === cluster.id ? t('hideMembers') : t('viewMembers')}
                              </Button>
                            </div>
                            {expandedCluster === cluster.id && (
                              <ClusterMembers memberships={memberships} clusterId={cluster.id} t={t} />
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
                        <table className="w-full text-start text-sm">
                          <thead>
                            <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                              <th scope="col" className="px-4 py-2 text-start font-medium">{t('cluster')}</th>
                              <th scope="col" className="px-4 py-2 text-start font-medium">{t('label')}</th>
                              <th scope="col" className="px-4 py-2 text-start font-medium">{t('members')}</th>
                              <th scope="col" className="px-4 py-2 text-start font-medium">{t('actions')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                            {runClusters.map((cluster) => (
                              <Fragment key={cluster.id}>
                                <tr>
                                  <td className="px-4 py-2 text-charcoal dark:text-gray-100">{cluster.id}</td>
                                  <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{cluster.label ?? '—'}</td>
                                  <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{cluster.member_count}</td>
                                  <td className="px-4 py-2">
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      type="button"
                                      onClick={() => setExpandedCluster(expandedCluster === cluster.id ? null : cluster.id)}
                                    >
                                      {expandedCluster === cluster.id ? t('hideMembers') : t('viewMembers')}
                                    </Button>
                                  </td>
                                </tr>
                                {expandedCluster === cluster.id && (
                                  <tr>
                                    <td colSpan={4} className="px-4 py-3">
                                      <ClusterMembers memberships={memberships} clusterId={cluster.id} t={t} />
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function ClusterMembers({
  memberships,
  clusterId,
  t,
}: {
  memberships: Membership[];
  clusterId: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const clusterMemberships = memberships.filter((m) => m.cluster_id === clusterId);
  return (
    <div className="mt-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-charcoal/60 dark:text-gray-400">
        {t('membersOfCluster', { id: clusterId })}
      </h4>
      {clusterMemberships.length === 0 ? (
        <p className="text-sm text-charcoal/60 dark:text-gray-400">{t('noMembers')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-charcoal/10 dark:border-gray-700">
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                <th scope="col" className="px-3 py-1.5 text-start font-medium">{t('applicationId')}</th>
                <th scope="col" className="px-3 py-1.5 text-start font-medium">{t('distanceToCentroid')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
              {clusterMemberships.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-1.5 text-charcoal dark:text-gray-100">{m.application_id}</td>
                  <td className="px-3 py-1.5 text-charcoal/70 dark:text-gray-400">{m.distance_to_centroid}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
