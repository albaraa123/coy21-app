// src/app/[locale]/(admin)/agenda/days/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import DayManager from './day-manager';
import { isStaffRole } from '@/lib/auth/is-staff-role';

export default async function ConferenceDaysPage() {
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

  // Same reasoning as rooms/page.tsx: this query only touches `conference_days`
  // columns, and `conference_days_staff_all` grants any agenda staff caller
  // unrestricted read access (no per-row owner check), so the session client
  // is sufficient — verified directly against the live database. The
  // service-role client is still needed above, but only for the role-gate's
  // `profiles` self-lookup.
  const { data: days } = await supabase
    .from('conference_days')
    .select('id, conference_date, label_ar, label_en, display_order, is_active')
    .order('display_order', { ascending: true });

  const t = await getTranslations({ locale, namespace: 'agenda.days' });

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold text-charcoal dark:text-gray-100 md:mb-6">{t('title')}</h1>
      <DayManager days={days ?? []} />
    </div>
  );
}
