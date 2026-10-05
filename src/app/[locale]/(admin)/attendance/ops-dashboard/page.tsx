// src/app/[locale]/(admin)/attendance/ops-dashboard/page.tsx
//
// Sub-project 5a — live operations dashboard for the control-room staff
// team during the conference. See
// docs/superpowers/specs/2026-10-05-ops-dashboard-design.md for the full
// design. Same audience/gate as demand/page.tsx: isStaffRole()
// ('staff' | 'super_admin'), reusing that check as-is per the spec's
// scope decision 1 rather than introducing a new one.
//
// This task (plan Task 2) ships the initial server-rendered snapshot
// only. Realtime subscription + fallback polling are added in Task 3,
// inside OpsDashboardClient — do not add live-update logic here.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import OpsDashboardClient from './ops-dashboard-client';

export default async function OpsDashboardPage() {
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
  if (!profile || !isStaffRole(profile.role)) {
    notFound();
  }

  const { data: rows } = await supabase.rpc('ops_dashboard_snapshot');

  const t = await getTranslations({ locale, namespace: 'opsDashboard' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>

      <OpsDashboardClient initialRows={rows ?? []} />
    </div>
  );
}
