// src/app/[locale]/(admin)/attendance/admissions/page.tsx
//
// Phase 8.1 — Admission Management Console. Mirrors
// attendance/scanners/page.tsx's exact shape: inline auth + role gate,
// service-role client for the profiles-touching role lookup and for the
// sessions list (same profiles-RLS reasoning as scanners/page.tsx's own
// comment), then hands static reference data (confirmed sessions, for the
// override/transfer session pickers) down to a client component. The
// client component does its own searching/lookups via the actions in
// ./actions.ts rather than this page pre-fetching applications, since the
// whole point of a search console is that the working set isn't known
// until staff type a query.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import AdmissionManagementConsole from './admission-management-console';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function AdmissionsPage() {
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

  const { data: sessions } = await service
    .from('sessions')
    .select('id, title_ar, title_en, status, start_time, end_time')
    .eq('status', 'confirmed')
    .order('start_time', { ascending: true });

  const t = await getTranslations({ locale, namespace: 'admissionManagement' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>
      <AdmissionManagementConsole sessions={sessions ?? []} />
    </div>
  );
}
