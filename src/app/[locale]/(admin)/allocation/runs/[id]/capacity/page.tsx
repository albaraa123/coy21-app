// src/app/[locale]/(admin)/allocation/runs/[id]/capacity/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect, Link } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function AllocationRunCapacityPage({ params }: { params: Promise<{ id: string }> }) {
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
    .select('id, status')
    .eq('id', id)
    .single();
  if (!run) notFound();

  const [{ data: assignments }, { data: issues }] = await Promise.all([
    supabase
      .from('allocation_assignments')
      .select('session_id, status, sessions(id, session_code, title_en, capacity)')
      .eq('allocation_run_id', id),
    supabase
      .from('allocation_issues')
      .select('session_id, issue_type')
      .eq('allocation_run_id', id)
      .eq('issue_type', 'capacity_bottleneck'),
  ]);

  // "Filled" for a draft run counts assignments in EITHER 'proposed' OR
  // 'confirmed' status (spec: previously-reviewed requirement). Since those are
  // the only two assignment statuses, every assignment for this session counts.
  const FILLED_STATUSES = new Set(['proposed', 'confirmed']);

  type SessionInfo = { session_code: string; title_en: string; capacity: number };
  const perSession = new Map<string, { info: SessionInfo | null; filled: number }>();
  for (const a of assignments ?? []) {
    const entry = perSession.get(a.session_id) ?? { info: a.sessions, filled: 0 };
    if (!entry.info && a.sessions) entry.info = a.sessions;
    if (FILLED_STATUSES.has(a.status)) entry.filled += 1;
    perSession.set(a.session_id, entry);
  }

  const bottleneckSessionIds = new Set(
    (issues ?? []).map((i) => i.session_id).filter((sid): sid is string => sid !== null)
  );

  const rows = Array.from(perSession.entries())
    .map(([sessionId, { info, filled }]) => ({
      sessionId,
      code: info?.session_code ?? sessionId,
      title: info?.title_en ?? '',
      capacity: info?.capacity ?? null,
      filled,
      // Derived directly from filled >= capacity — this is the display's own
      // source of truth for "is this session at/over capacity right now",
      // independent of whether the run's own issue detector also flagged it.
      // (Previously this required bottleneckSessionIds.has(sessionId) too,
      // which could hide a genuinely over-capacity session from this
      // capacity-review screen if the issue detector didn't emit a row for
      // it — code review flagged this as a real display-correctness gap.)
      oversubscribed: info?.capacity != null && filled >= info.capacity,
      flaggedAsBottleneck: bottleneckSessionIds.has(sessionId),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const t = await getTranslations({ locale, namespace: 'allocation.runs.detail.capacity' });

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 md:mb-6">
        <h1 className="text-lg font-semibold text-charcoal dark:text-gray-100">{t('title', { id: run.id })}</h1>
        <Link href={`/allocation/runs/${run.id}`} className="text-sm text-turquoise hover:underline">
          {t('backToRun')}
        </Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-session list. Desktop (md+): table. Both trees
              render the same `rows` data and must be kept in sync — any
              column added to one must be added to the other. */}
          <div className="flex flex-col gap-2 md:hidden">
            {rows.map((row) => (
              <div
                key={row.sessionId}
                className="rounded-lg border border-charcoal/10 bg-warm-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                  {row.title ? `${row.code} — ${row.title}` : row.code}
                </p>
                <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                  {t('filled')}: {row.filled} / {t('capacity')}: {row.capacity ?? '—'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant={row.oversubscribed ? 'mandatory' : 'neutral'}>
                    {t('oversubscribed')}: {row.oversubscribed ? t('yes') : t('no')}
                  </Badge>
                  <Badge variant={row.flaggedAsBottleneck ? 'changed' : 'neutral'}>
                    {t('flaggedAsBottleneck')}: {row.flaggedAsBottleneck ? t('yes') : t('no')}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('session')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('capacity')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('filled')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('oversubscribed')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('flaggedAsBottleneck')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {rows.map((row) => (
                  <tr key={row.sessionId}>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">
                      {row.title ? `${row.code} — ${row.title}` : row.code}
                    </td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.capacity ?? '—'}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.filled}</td>
                    <td className="px-4 py-2">
                      <Badge variant={row.oversubscribed ? 'mandatory' : 'neutral'}>
                        {row.oversubscribed ? t('yes') : t('no')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={row.flaggedAsBottleneck ? 'changed' : 'neutral'}>
                        {row.flaggedAsBottleneck ? t('yes') : t('no')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
