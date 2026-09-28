// src/app/[locale]/(admin)/attendance/demand/page.tsx
//
// Phase 8.5 — read-only demand/capacity dashboard for
// program_attendance_manager. Deliberately read-only: no flexible-entry
// open/close controls, no new session state or database columns (see
// Phase 8 scope). All computation lives in
// src/lib/program-attendance/demand-capacity.ts (fetchDemandCapacityForCaller
// / computeDemandCapacityRows) — see that module's own header comment for
// exactly which existing data sources each metric reuses, and why an
// earlier "Recommended" (allocation_assignments-derived) metric was
// deliberately dropped rather than shipped ambiguous.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';
import { fetchDemandCapacityForCaller } from '@/lib/program-attendance/demand-capacity';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

export default async function DemandCapacityDashboardPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isProgramAttendanceStaffRole(profile.role)) {
    notFound();
  }

  const rows = await fetchDemandCapacityForCaller({ userId: user.id, service }, locale);

  const t = await getTranslations({ locale, namespace: 'attendanceDemand' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>

      {rows.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <>
          {/* Mobile: card-per-session list. Desktop (md+): table. Both trees
              render the same `rows` data and must be kept in sync — any
              column added to one must be added to the other. */}
          <div className="flex flex-col gap-2 md:hidden">
            {rows.map((row) => (
              <div key={row.sessionId} className="rounded-lg border border-charcoal/10 bg-warm-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                <p className="text-sm font-medium text-charcoal dark:text-gray-100">{row.title ? `${row.code} — ${row.title}` : row.code}</p>
                <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                  {t('admitted')}: {row.admittedTotal} / {t('capacity')}: {row.capacity}
                </p>
                <p className="text-sm text-charcoal/70 dark:text-gray-400">
                  {t('priority')}: {row.admittedPriority} · {t('flexible')}: {row.admittedFlexible} · {t('remaining')}: {row.remaining}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant={row.atOrOverCapacity ? 'mandatory' : 'neutral'}>{row.atOrOverCapacity ? t('atOrOverCapacity') : t('hasCapacity')}</Badge>
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
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('admitted')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('priority')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('flexible')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('remaining')}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                {rows.map((row) => (
                  <tr key={row.sessionId}>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{row.title ? `${row.code} — ${row.title}` : row.code}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.capacity}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.admittedTotal}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.admittedPriority}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.admittedFlexible}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.remaining}</td>
                    <td className="px-4 py-2">
                      <Badge variant={row.atOrOverCapacity ? 'mandatory' : 'neutral'}>{row.atOrOverCapacity ? t('atOrOverCapacity') : t('hasCapacity')}</Badge>
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
