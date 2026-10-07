// src/app/[locale]/(admin)/attendance/walk-in/page.tsx
//
// Task 7 — standalone walk-in admission admin page (design spec's "Walk-In
// Admission" section, scope decision 13: a minimal standalone admin page,
// deliberately not integrated into the scanner UI). Mirrors
// attendance/admissions/page.tsx's and attendance/scanners/page.tsx's exact
// shape: inline auth + role gate, service-role client for the
// profiles-touching role lookup and for the confirmed-sessions list (same
// profiles-RLS reasoning as those pages' own comments), then hands static
// reference data (confirmed sessions, for the session picker) down to a
// client component. Unlike admissions/page.tsx, there is no search console
// here — the applicant identifier is resolved server-side inside the
// /api/admit-walk-in Route Handler, since this page has exactly one
// action to perform.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import WalkInAdmissionForm from './walk-in-admission-form';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function WalkInAdmissionPage() {
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

  const t = await getTranslations({ locale, namespace: 'walkInAdmission' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-2 text-lg font-semibold text-charcoal dark:text-gray-100">{t('title')}</h1>
      <p className="mb-4 text-sm text-charcoal/70 dark:text-gray-400 md:mb-6">{t('description')}</p>
      <WalkInAdmissionForm sessions={sessions ?? []} />
    </div>
  );
}
